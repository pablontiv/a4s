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
import type { ToolRendererResolver, ToolRenderers, ToolRowResult } from "@pablontiv/pion";
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
	registration?: "valid" | "void" | "absent";
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
	const notifications: Notification[] = [];
	const selections: Array<string | undefined> = [];
	let invalidations = 0;
	let resolver: ToolRendererResolver | undefined;

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
	if (options.registration !== "absent") {
		api.registerToolRenderer = (candidate: ToolRendererResolver) => {
			resolver = candidate;
			if (options.registration === "void") return undefined;
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
	const resolveRenderers = (
		toolName: string,
		inherited: ToolRenderers | undefined,
	): { renderers: ToolRenderers | undefined; nextCalls: number } => {
		let nextCalls = 0;
		const renderers =
			resolver?.(toolName, () => {
				nextCalls += 1;
				return inherited;
			}) ?? inherited;
		return { renderers, nextCalls };
	};

	return {
		api,
		commands,
		shortcuts,
		notifications,
		start,
		runCommand,
		runShortcut,
		resolveRenderers,
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

function component(label: string) {
	return {
		render: () => [label],
		invalidate: () => {},
	};
}

function inheritedRenderers(): ToolRenderers {
	return {
		renderShell: "self",
		renderCall: () => component("call"),
		renderResult: () => component("result"),
		renderRow: () => component("row"),
	};
}

function renderRow(
	renderers: ToolRenderers | undefined,
	options: {
		width?: number;
		expanded?: boolean;
		isError?: boolean;
		result?: ToolRowResult;
	} = {},
): string[] | undefined {
	const row = renderers?.renderRow?.(
		{},
		options.result,
		{} as never,
		{
			args: {},
			toolCallId: "call-1",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: "/project",
			executionStarted: true,
			argsComplete: true,
			isPartial: options.result === undefined,
			expanded: options.expanded ?? false,
			showImages: true,
			isError: options.isError ?? false,
		},
	);
	return row?.render(options.width ?? 80);
}

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
		assert.deepEqual(renderRow(harness.resolveRenderers("read", undefined).renderers), []);

		writeModeFile(projectModePath(cwd), '{"mode":"dense"}\n');
		await harness.start();
		assert.equal(harness.resolveRenderers("read", undefined).renderers, undefined);
	});

	it("ignores the project override when the project is not trusted", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const cwd = join(root, "project");
		writeModeFile(globalPath, serializeMode("compact"));
		writeModeFile(projectModePath(cwd), serializeMode("hidden"));
		const harness = createHarness({ globalPath, cwd, trusted: false });

		await harness.start();
		assert.deepEqual(renderRow(harness.resolveRenderers("read", undefined).renderers), ["read"]);
	});

	it("migrates supported legacy values only when the new file is absent", async () => {
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
	it("keeps controls on an old host and uses native rows", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({ globalPath, cwd: root, registration: "void" });
		const inherited = inheritedRenderers();

		await harness.start();
		await harness.runCommand("compact");
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: "compact" });
		assert.deepEqual(harness.notifications.at(-1), {
			message: "Tool row mode was saved. This host version cannot apply tool row presentation.",
			type: "warning",
		});
		assert.strictEqual(harness.resolveRenderers("read", inherited).renderers, inherited);

		await harness.runShortcut();
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: "hidden" });
		assert.deepEqual(harness.notifications.at(-1), {
			message: "Tool row mode was saved. This host version cannot apply tool row presentation.",
			type: "warning",
		});
		assert.equal(harness.invalidations, 0);
		assert.deepEqual([...harness.commands.keys()], [TOOL_ROW_PRESENTATION_SETTINGS_COMMAND]);
		assert.equal(harness.shortcuts.has("ctrl+alt+o"), true);
	});

	it("loads without an old host registration method", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
			registration: "absent",
		});
		await harness.start();
		await harness.runCommand("hidden");
		assert.equal(harness.invalidations, 0);
	});

	it("calls next once and returns inherited renderers unchanged in full mode", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
		});
		const inherited = inheritedRenderers();
		await harness.start();

		const resolution = harness.resolveRenderers("grep", inherited);
		assert.equal(resolution.nextCalls, 1);
		assert.strictEqual(resolution.renderers, inherited);
	});

	it("replaces only the complete row in compact and hidden modes", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({ globalPath, cwd: root });
		const inherited = inheritedRenderers();
		await harness.start();

		for (const mode of ["compact", "hidden"] as const) {
			await harness.runCommand(mode);
			const resolution = harness.resolveRenderers("bash", inherited);
			assert.equal(resolution.nextCalls, 1);
			assert.notStrictEqual(resolution.renderers, inherited);
			assert.strictEqual(resolution.renderers?.renderCall, inherited.renderCall);
			assert.strictEqual(resolution.renderers?.renderResult, inherited.renderResult);
			assert.strictEqual(resolution.renderers?.renderShell, inherited.renderShell);
			assert.notStrictEqual(resolution.renderers?.renderRow, inherited.renderRow);
		}
	});

	it("renders compact pending and successful rows as one width-limited line", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
		});
		await harness.start();
		await harness.runCommand("compact");
		const renderers = harness.resolveRenderers("long-tool-name", inheritedRenderers()).renderers;

		assert.deepEqual(renderRow(renderers, { width: 4 }), ["long"]);
		assert.deepEqual(
			renderRow(harness.resolveRenderers("工具名称", inheritedRenderers()).renderers, { width: 4 }),
			["工具"],
		);
		assert.deepEqual(
			renderRow(renderers, {
				result: { content: [{ type: "text", text: "done" }], details: { complete: true } },
			}),
			["long-tool-name"],
		);
		assert.equal(renderRow(renderers, { isError: true }), undefined);
		assert.equal(renderRow(renderers, { expanded: true }), undefined);
	});

	it("renders hidden pending and successful rows with no lines", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
		});
		await harness.start();
		await harness.runCommand("hidden");
		const renderers = harness.resolveRenderers("read", inheritedRenderers()).renderers;

		assert.deepEqual(renderRow(renderers), []);
		assert.deepEqual(
			renderRow(renderers, { result: { content: [{ type: "text", text: "done" }], details: {} } }),
			[],
		);
		assert.equal(renderRow(renderers, { isError: true }), undefined);
		assert.equal(renderRow(renderers, { expanded: true }), undefined);
	});

	it("invalidates once only when the effective mode changes", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		const harness = createHarness({ globalPath, cwd: root });
		await harness.start();

		await harness.runCommand("compact");
		assert.equal(harness.invalidations, 1);
		await harness.runCommand("compact");
		assert.equal(harness.invalidations, 1);
		await harness.runCommand("hidden");
		assert.equal(harness.invalidations, 2);

		const renderers = harness.resolveRenderers("read", inheritedRenderers()).renderers;
		renderRow(renderers, { width: 1 });
		renderRow(renderers, { expanded: true });
		assert.equal(harness.invalidations, 2);
	});

	it("does not invalidate for a global change hidden by a project override", async () => {
		const root = await temporaryDirectory();
		const globalPath = join(root, "agent", "pi-tool-row-presentation.json");
		writeModeFile(projectModePath(root), serializeMode("hidden"));
		const harness = createHarness({ globalPath, cwd: root });
		await harness.start();
		assert.equal(harness.invalidations, 1);

		await harness.runCommand("compact");
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { mode: "compact" });
		assert.equal(harness.invalidations, 1);
		assert.deepEqual(renderRow(harness.resolveRenderers("read", undefined).renderers), []);
		assert.deepEqual(harness.notifications.at(-1), {
			message: "Global tool rows saved: compact. Project override remains: hidden.",
			type: "info",
		});
	});

	it("does not change or invalidate the effective mode after a write failure", async () => {
		const root = await temporaryDirectory();
		const harness = createHarness({
			globalPath: join(root, "agent", "pi-tool-row-presentation.json"),
			cwd: root,
			writeMode: () => {
				throw new Error("write failed");
			},
		});
		const inherited = inheritedRenderers();
		await harness.start();

		await harness.runCommand("hidden");
		await harness.runShortcut();
		assert.strictEqual(harness.resolveRenderers("read", inherited).renderers, inherited);
		assert.equal(harness.invalidations, 0);
		assert.deepEqual(harness.notifications.at(-1), {
			message: "Tool row presentation could not save its settings.",
			type: "error",
		});
	});

	it("does not use retired host APIs or transcript markers", () => {
		const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
		const retiredNames = [
			["register", "Setting"].join(""),
			["registerTranscript", "PresentationPolicy"].join(""),
			["orphaned-thinking", "-placeholder"].join(""),
		];
		for (const name of retiredNames) {
			assert.equal(source.includes(name), false);
		}
	});
});

describe("package host dependencies", () => {
	it("declares compatible optional peers and uses the approved Pion snapshot", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			peerDependenciesMeta?: Record<string, { optional?: boolean }>;
			devDependencies?: Record<string, string>;
		};
		const version = "1.0.2-dev.40713b10ba6db5c6f083026e3367e2af72cea0ea";
		assert.equal(manifest.dependencies?.["@earendil-works/pi-tui"], "1.0.4");
		assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=1.0.3");
		assert.equal(manifest.peerDependencies?.["@pablontiv/pion"], `>=1.0.4 || ${version}`);
		assert.equal(manifest.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional, true);
		assert.equal(manifest.peerDependenciesMeta?.["@pablontiv/pion"]?.optional, true);
		assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], "1.0.3");
		assert.equal(
			manifest.devDependencies?.["@pablontiv/pion"],
			`https://github.com/pablontiv/pi/releases/download/pion-local-v${version}/pablontiv-pion-${version}.tgz`,
		);
	});
});
