import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Check } from "typebox/value";
import toolRowPresentation from "../src/index.ts";

const MODE_KEY = "a4s.tool-rows.mode";
const MIGRATION_KEY = "a4s.tool-rows.migrated-v1";
const MODES = ["full", "compact", "hidden"] as const;
type Scope = "global" | "project";
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };
type SettingWrite = { key: string; value: unknown; scope: Scope };
type SettingDefinition = {
	key: string;
	schema: object;
	defaultValue: unknown;
	title: string;
	description: string;
	ui?: { control: "select"; choices: readonly { label: string; value: unknown }[] };
};
type Block = {
	kind: "tool" | "thinking";
	subtype?: "orphaned-thinking-placeholder";
	capabilities: { summary: boolean; expandable: boolean };
};
type Presentation = { density: "full" | "summary" | "hidden" };
type EventName = "session_start" | "session_shutdown";
type EventHandler = () => void | Promise<void>;
type ShortcutHandler = (context: FakeContext) => void | Promise<void>;
type FakeContext = { ui: { notify(message: string, type?: Notification["type"]): void } };

function createHarness(options: {
	global?: Record<string, unknown>;
	project?: Record<string, unknown>;
	rawSettings?: Record<string, unknown>;
} = {}) {
	const global = new Map(Object.entries(options.global ?? {}));
	const project = new Map(Object.entries(options.project ?? {}));
	const rawSettings = options.rawSettings ?? {};
	const definitions = new Map<string, SettingDefinition>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const events = new Map<EventName, EventHandler[]>();
	const commands = new Set<string>();
	const shortcuts = new Map<string, { description?: string; handler: ShortcutHandler }>();
	const writes: SettingWrite[] = [];
	const notifications: Notification[] = [];
	const policies: Array<(block: Block, current: Presentation) => Presentation | undefined> = [];
	let invalidations = 0;

	const resolve = (key: string): unknown =>
		project.get(key) ?? global.get(key) ?? definitions.get(key)?.defaultValue;
	const set = (key: string, value: unknown, scope: Scope): void => {
		const previous = resolve(key);
		writes.push({ key, value, scope });
		(scope === "global" ? global : project).set(key, value);
		const next = resolve(key);
		if (Object.is(previous, next)) return;
		for (const listener of listeners.get(key) ?? []) listener(next);
	};

	const api = {
		registerSetting(definition: SettingDefinition) {
			definitions.set(definition.key, definition);
			return {
				key: definition.key,
				get: () => resolve(definition.key),
				set: (value: unknown, setOptions: { scope?: Scope } = {}) =>
					set(definition.key, value, setOptions.scope ?? "global"),
				onChange: (listener: (value: unknown) => void) => {
					const keyListeners = listeners.get(definition.key) ?? new Set<(value: unknown) => void>();
					keyListeners.add(listener);
					listeners.set(definition.key, keyListeners);
					let active = true;
					return () => {
						if (!active) return;
						active = false;
						keyListeners.delete(listener);
					};
				},
			};
		},
		registerTranscriptPresentationPolicy(policy: (block: Block, current: Presentation) => Presentation | undefined) {
			policies.push(policy);
			return {
				invalidate: () => {
					invalidations += 1;
				},
				dispose: () => {},
			};
		},
		on(event: EventName, handler: EventHandler) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
			return () => {};
		},
		getSettings: () => rawSettings,
		registerCommand(name: string) {
			commands.add(name);
		},
		registerShortcut(key: string, shortcut: { description?: string; handler: ShortcutHandler }) {
			shortcuts.set(key, shortcut);
		},
	};

	toolRowPresentation(api as never);

	const context: FakeContext = {
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
		},
	};
	const emit = async (event: EventName): Promise<void> => {
		for (const handler of events.get(event) ?? []) await handler();
	};
	const runShortcut = async (): Promise<void> => {
		const shortcut = shortcuts.get("ctrl+alt+o");
		assert.ok(shortcut);
		await shortcut.handler(context);
	};
	const resolvePresentation = (block: Block): Presentation => {
		let current: Presentation = { density: "full" };
		for (const policy of policies) current = policy(block, current) ?? current;
		return current;
	};

	return {
		definitions,
		writes,
		notifications,
		commands,
		shortcuts,
		resolve,
		set,
		emit,
		runShortcut,
		resolvePresentation,
		get invalidations() {
			return invalidations;
		},
	};
}

const block = (kind: Block["kind"], subtype?: Block["subtype"]): Block => ({
	kind,
	...(subtype === undefined ? {} : { subtype }),
	capabilities: { summary: kind === "tool", expandable: true },
});

describe("A4S tool row presentation extension public contract", () => {
	it("registers only the A4S mode and migration keys with the expected schemas", () => {
		const harness = createHarness();
		assert.deepEqual([...harness.definitions.keys()], [MODE_KEY, MIGRATION_KEY]);
		const mode = harness.definitions.get(MODE_KEY);
		const marker = harness.definitions.get(MIGRATION_KEY);
		assert.ok(mode);
		assert.ok(marker);
		assert.deepEqual(
			{
				key: mode.key,
				defaultValue: mode.defaultValue,
				title: mode.title,
				description: mode.description,
				ui: mode.ui,
			},
			{
				key: MODE_KEY,
				defaultValue: "full",
				title: "Tool rows",
				description: "How tool calls appear in the interactive transcript",
				ui: {
					control: "select",
					choices: [
						{ label: "Full", value: "full" },
						{ label: "Compact", value: "compact" },
						{ label: "Hidden", value: "hidden" },
					],
				},
			},
		);
		for (const value of MODES) assert.equal(Check(mode.schema, value), true);
		assert.equal(Check(mode.schema, "other"), false);
		assert.equal(marker.defaultValue, false);
		assert.equal(marker.ui, undefined);
		assert.equal(Check(marker.schema, true), true);
		assert.equal(Check(marker.schema, "true"), false);
	});

	it("registers no command and cycles the native mode setting through all three values", async () => {
		const harness = createHarness({ global: { [MIGRATION_KEY]: true } });
		assert.deepEqual([...harness.commands], []);
		assert.equal(harness.shortcuts.get("ctrl+alt+o")?.description, "Cycle tool row presentation");

		for (const expected of ["compact", "hidden", "full"] as const) {
			await harness.runShortcut();
			assert.equal(harness.resolve(MODE_KEY), expected);
			assert.deepEqual(harness.writes.at(-1), { key: MODE_KEY, value: expected, scope: "global" });
			assert.deepEqual(harness.notifications.at(-1), { message: `Tool rows: ${expected}`, type: "info" });
		}
	});

	it("maps compact tools to summary and hides orphaned thinking only in hidden mode", () => {
		const harness = createHarness({ global: { [MIGRATION_KEY]: true } });
		assert.deepEqual(harness.resolvePresentation(block("tool")), { density: "full" });

		harness.set(MODE_KEY, "compact", "global");
		assert.deepEqual(harness.resolvePresentation(block("tool")), { density: "summary" });
		assert.deepEqual(harness.resolvePresentation(block("thinking", "orphaned-thinking-placeholder")), {
			density: "full",
		});

		harness.set(MODE_KEY, "hidden", "global");
		assert.deepEqual(harness.resolvePresentation(block("tool")), { density: "hidden" });
		assert.deepEqual(harness.resolvePresentation(block("thinking", "orphaned-thinking-placeholder")), {
			density: "hidden",
		});
		assert.deepEqual(harness.resolvePresentation(block("thinking")), { density: "full" });
	});

	it("invalidates once per change and manages its listener across repeated lifecycle events", async () => {
		const harness = createHarness({ global: { [MIGRATION_KEY]: true } });
		await harness.emit("session_start");
		await harness.emit("session_start");
		harness.set(MODE_KEY, "compact", "global");
		assert.equal(harness.invalidations, 1);

		await harness.emit("session_shutdown");
		await harness.emit("session_shutdown");
		harness.set(MODE_KEY, "hidden", "global");
		assert.equal(harness.invalidations, 1);
	});

	it("migrates valid legacy core state once without overwriting a non-default mode", async () => {
		const migrated = createHarness({ rawSettings: { toolRowsMode: "compact", unrelated: true } });
		await migrated.emit("session_start");
		assert.equal(migrated.resolve(MODE_KEY), "compact");
		assert.equal(migrated.resolve(MIGRATION_KEY), true);
		assert.deepEqual(migrated.writes, [
			{ key: MODE_KEY, value: "compact", scope: "global" },
			{ key: MIGRATION_KEY, value: true, scope: "global" },
		]);
		await migrated.emit("session_start");
		assert.equal(migrated.writes.length, 2);

		const configured = createHarness({
			global: { [MODE_KEY]: "hidden" },
			rawSettings: { toolRowsMode: "compact" },
		});
		await configured.emit("session_start");
		assert.equal(configured.resolve(MODE_KEY), "hidden");
		assert.deepEqual(configured.writes, [{ key: MIGRATION_KEY, value: true, scope: "global" }]);
	});

	it("marks invalid or absent legacy state and never reads unreleased extension keys", async () => {
		for (const rawSettings of [
			{},
			{ toolRowsMode: "verbose" },
			{ "pablontiv.tool-rows.mode": "hidden", "pablontiv.tool-rows.migrated-v1": true },
		]) {
			const harness = createHarness({ rawSettings });
			await harness.emit("session_start");
			assert.equal(harness.resolve(MODE_KEY), "full");
			assert.deepEqual(harness.writes, [{ key: MIGRATION_KEY, value: true, scope: "global" }]);
		}

		const alreadyMarked = createHarness({
			global: { [MIGRATION_KEY]: true },
			rawSettings: { toolRowsMode: "compact" },
		});
		await alreadyMarked.emit("session_start");
		assert.equal(alreadyMarked.resolve(MODE_KEY), "full");
		assert.deepEqual(alreadyMarked.writes, []);
	});
});
