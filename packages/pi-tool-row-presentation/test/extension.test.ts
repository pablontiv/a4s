import assert from "node:assert/strict";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	globalModePath,
	modeFromFile,
	projectModePath,
	serializeMode,
} from "../src/config.ts";
import {
	migratedMode,
	registerToolRowPresentation,
	TOOL_ROW_PRESENTATION_SETTINGS_COMMAND,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

type Mode = "full" | "compact" | "hidden";
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };
type Block = { kind: "tool" | "thinking"; subtype?: "orphaned-thinking-placeholder" };
type Presentation = { density: "full" | "summary" | "hidden" };
type Context = {
	hasUI: boolean;
	cwd: string;
	isProjectTrusted(): boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		notify(message: string, type?: Notification["type"]): void;
	};
};

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "a4s-tool-rows-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function createHarness(options: {
	globalPath: string;
	cwd: string;
	trusted?: boolean;
	settings?: Record<string, unknown>;
	withPolicy?: boolean;
	writeMode?: (mode: Mode, path: string) => void;
}) {
	const events = new Map<string, Array<(event: unknown, ctx: Context) => void | Promise<void>>>();
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: Context) => Promise<void> }
	>();
	const shortcuts = new Map<
		string,
		{ description?: string; handler: (ctx: Context) => void | Promise<void> }
	>();
	const policies: Array<(block: Block) => Presentation | undefined> = [];
	const notifications: Notification[] = [];
	const selections: Array<string | undefined> = [];
	let invalidations = 0;

	const api: Record<string, unknown> = {
		on: (event: string, handler: (event: unknown, ctx: Context) => void | Promise<void>) => {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
			return () => {};
		},
		getSettings: () => options.settings ?? {},
		registerCommand: (
			name: string,
			command: { description?: string; handler: (args: string, ctx: Context) => Promise<void> },
		) => commands.set(name, command),
		registerShortcut: (
			key: string,
			shortcut: { description?: string; handler: (ctx: Context) => void | Promise<void> },
		) => shortcuts.set(key, shortcut),
	};
	if (options.withPolicy !== false) {
		api.registerTranscriptPresentationPolicy = (
			policy: (block: Block) => Presentation | undefined,
		) => {
			policies.push(policy);
			return {
				invalidate: () => {
					invalidations += 1;
				},
			};
		};
	}

	registerToolRowPresentation(api as never, {
		globalPath: options.globalPath,
		...(options.writeMode === undefined ? {} : { writeMode: options.writeMode }),
	});

	const context: Context = {
		hasUI: true,
		cwd: options.cwd,
		isProjectTrusted: () => options.trusted ?? true,
		ui: {
			select: async () => selections.shift(),
			notify: (message, type) => notifications.push({ message, type }),
		},
	};
	const start = async (): Promise<void> => {
		for (const handler of events.get("session_start") ?? []) await handler({}, context);
	};
	const runCommand = async (selection: string | undefined): Promise<void> => {
		selections.push(selection);
		const command = commands.get(TOOL_ROW_PRESENTATION_SETTINGS_COMMAND);
		assert.ok(command);
		await command.handler("", context);
	};
	const runShortcut = async (): Promise<void> => {
		const shortcut = shortcuts.get("ctrl+alt+o");
		assert.ok(shortcut);
		await shortcut.handler(context);
	};
	const resolvePresentation = (block: Block): Presentation => {
		let current: Presentation = { density: "full" };
		for (const policy of policies) current = policy(block) ?? current;
		return current;
	};

	return {
		api,
		commands,
		shortcuts,
		notifications,
		start,
		runCommand,
		runShortcut,
		resolvePresentation,
		get invalidations() {
			return invalidations;
		},
	};
}

function writeModeFile(path: string, contents: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents, "utf8");
}

function readFileSnapshot(path: string): { contents: string; mode: number } {
	const descriptor = openSync(path, "r");
	try {
		return {
			contents: readFileSync(descriptor, "utf8"),
			mode: fstatSync(descriptor).mode & 0o777,
		};
	} finally {
		closeSync(descriptor);
	}
}

const tool = (): Block => ({ kind: "tool" });
const orphanedThinking = (): Block => ({
	kind: "thinking",
	subtype: "orphaned-thinking-placeholder",
});

describe("tool row configuration", () => {
	it("resolves the agent directory and parses only the supported file format", () => {
		assert.equal(
			globalModePath({ PI_CODING_AGENT_DIR: " /agent/config " }, "/home/user"),
			join("/agent/config", "pi-tool-row-presentation.json"),
		);
		assert.equal(
			globalModePath({ PI_CODING_AGENT_DIR: "  " }, "/home/user"),
			join("/home/user", ".pi", "agent", "pi-tool-row-presentation.json"),
		);
		assert.equal(modeFromFile(serializeMode("compact")), "compact");
		for (const invalid of [undefined, "", "{}", '{"mode":"dense"}', '{"mode":"full","extra":true}']) {
			assert.equal(modeFromFile(invalid), undefined);
		}
	});

	it("uses defaults for invalid values and gives a trusted project override precedence", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const cwd = join(root, "project");
		writeModeFile(globalPath, '{"mode":"dense"}\n');
		writeModeFile(projectModePath(cwd), serializeMode("hidden"));
		const harness = createHarness({ globalPath, cwd });

		await harness.start();
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "hidden" });
		assert.deepEqual(harness.resolvePresentation(orphanedThinking()), { density: "hidden" });

		writeModeFile(projectModePath(cwd), '{"mode":"dense"}\n');
		await harness.start();
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "full" });
	});

	it("ignores the project override when the project is not trusted", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const cwd = join(root, "project");
		writeModeFile(globalPath, serializeMode("compact"));
		writeModeFile(projectModePath(cwd), serializeMode("hidden"));
		const harness = createHarness({ globalPath, cwd, trusted: false });

		await harness.start();
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "summary" });
		assert.deepEqual(harness.resolvePresentation(orphanedThinking()), { density: "full" });
	});

	it("migrates extensionSettings before toolRowsMode only when the new file is absent", async () => {
		const root = await temporaryDirectory();
		const extensionPath = join(root, "extension", "pi-tool-row-presentation.json");
		const extension = createHarness({
			globalPath: extensionPath,
			cwd: root,
			settings: {
				extensionSettings: { "a4s.tool-rows.mode": "hidden" },
				toolRowsMode: "compact",
				"a4s.tool-rows.migrated-v1": true,
			},
		});
		await extension.start();
		assert.deepEqual(JSON.parse(readFileSync(extensionPath, "utf8")), { mode: "hidden" });

		const corePath = join(root, "core", "pi-tool-row-presentation.json");
		const core = createHarness({
			globalPath: corePath,
			cwd: root,
			settings: {
				extensionSettings: { "a4s.tool-rows.mode": "dense" },
				toolRowsMode: "compact",
			},
		});
		await core.start();
		assert.deepEqual(JSON.parse(readFileSync(corePath, "utf8")), { mode: "compact" });

		const existingPath = join(root, "existing", "pi-tool-row-presentation.json");
		writeModeFile(existingPath, serializeMode("full"));
		const existing = createHarness({
			globalPath: existingPath,
			cwd: root,
			settings: { extensionSettings: { "a4s.tool-rows.mode": "hidden" } },
		});
		await existing.start();
		assert.deepEqual(JSON.parse(readFileSync(existingPath, "utf8")), { mode: "full" });
	});

	it("does not migrate invalid values or unknown keys", async () => {
		assert.equal(migratedMode({ extensionSettings: { other: "hidden" }, toolRowsMode: "dense" }), undefined);
		assert.equal(
			migratedMode({
				extensionSettings: { "pablontiv.tool-rows.mode": "hidden" },
				"a4s.tool-rows.migrated-v1": true,
			}),
			undefined,
		);
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({
			globalPath,
			cwd: root,
			settings: { extensionSettings: { other: "hidden" }, toolRowsMode: "dense" },
		});
		await harness.start();
		assert.equal(existsSync(globalPath), false);
	});
});

describe("tool row host contract", () => {
	it("uses a common host fake that does not implement registerSetting", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
		});
		assert.equal("registerSetting" in harness.api, false);
		assert.deepEqual([...harness.commands.keys()], [TOOL_ROW_PRESENTATION_SETTINGS_COMMAND]);
		assert.equal(harness.shortcuts.has("ctrl+alt+o"), true);
		await harness.start();
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "full" });
	});

	it("changes and persists the mode through the command", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({ globalPath, cwd: root });
		await harness.start();

		await harness.runCommand("compact");
		const saved = readFileSnapshot(globalPath);
		assert.deepEqual(JSON.parse(saved.contents), { mode: "compact" });
		assert.equal(saved.mode, 0o600);
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "summary" });
		assert.deepEqual(harness.notifications.at(-1), { message: "Tool rows: compact", type: "info" });

		await harness.runCommand("Reset");
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: "full" });
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "full" });
	});

	it("writes the global file without replacing a trusted project override", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		writeModeFile(projectModePath(root), serializeMode("hidden"));
		const harness = createHarness({ globalPath, cwd: root });
		await harness.start();

		await harness.runCommand("compact");
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: "compact" });
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "hidden" });
	});

	it("cancels without writing", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({ globalPath, cwd: root });
		await harness.start();

		await harness.runCommand("Cancel");
		assert.equal(existsSync(globalPath), false);
		assert.deepEqual(harness.notifications, []);
	});

	it("persists each shortcut change", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({ globalPath, cwd: root });
		await harness.start();

		for (const expected of ["compact", "hidden", "full"] as const) {
			await harness.runShortcut();
			assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: expected });
		}
	});

	it("cycles the global mode while a project override keeps the effective mode unchanged", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		writeModeFile(globalPath, serializeMode("compact"));
		writeModeFile(projectModePath(root), serializeMode("hidden"));
		const harness = createHarness({ globalPath, cwd: root });
		await harness.start();
		assert.equal(harness.invalidations, 1);

		for (const expected of ["hidden", "full", "compact"] as const) {
			await harness.runShortcut();
			assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: expected });
			assert.deepEqual(harness.resolvePresentation(tool()), { density: "hidden" });
			assert.equal(harness.invalidations, 1);
		}
	});

	it("does not change the active mode after a write failure", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
			writeMode: () => {
				throw new Error("write failed");
			},
		});
		await harness.start();

		await harness.runCommand("hidden");
		await harness.runShortcut();
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "full" });
		assert.equal(harness.invalidations, 0);
		assert.deepEqual(harness.notifications.at(-1), {
			message: "Tool row presentation could not save its settings.",
			type: "error",
		});
	});

	it("invalidates the Pion policy after a successful change", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
		});
		await harness.start();
		await harness.runCommand("hidden");

		assert.equal(harness.invalidations, 1);
		assert.deepEqual(harness.resolvePresentation(tool()), { density: "hidden" });
		assert.deepEqual(harness.resolvePresentation(orphanedThinking()), { density: "hidden" });
	});

	it("loads in Pi without the policy and reports that Pi cannot apply the saved mode", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({ globalPath, cwd: root, withPolicy: false });
		await harness.start();
		await harness.runCommand("hidden");

		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: "hidden" });
		assert.deepEqual(harness.notifications.at(-1), {
			message: "Tool row mode was saved. This Pi version cannot apply transcript presentation.",
			type: "warning",
		});
	});
});

describe("package host dependencies", () => {
	it("declares Pi and Pion as optional peers and uses Pi for common development types", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			peerDependencies?: Record<string, string>;
			peerDependenciesMeta?: Record<string, { optional?: boolean }>;
			devDependencies?: Record<string, string>;
		};
		assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=1.0.3");
		assert.equal(manifest.peerDependencies?.["@pablontiv/pion"], ">=1.0.4");
		assert.equal(manifest.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional, true);
		assert.equal(manifest.peerDependenciesMeta?.["@pablontiv/pion"]?.optional, true);
		assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], "1.0.3");
	});
});
