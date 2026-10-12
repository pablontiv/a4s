import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  PI_CONTEXT_EXPERT_SETTINGS_COMMAND,
  registerPiContextExpertSettingsCommand,
  runPiContextExpertSettingsCommand,
} from "../src/settings-command.ts";
import type { CompactionConfig } from "../src/types.ts";

const BASIC_CONFIG: CompactionConfig = {
  compaction: { strategy: "basic" },
  trigger: { mode: "hint" },
  evidence: { strategy: "off" },
};

function createContext(options: {
  selects?: Array<string | undefined>;
  confirms?: boolean[];
  hasUI?: boolean;
} = {}) {
  const selects = [...(options.selects ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  let reloads = 0;
  const context = {
    hasUI: options.hasUI ?? true,
    ui: {
      async select() {
        return selects.shift();
      },
      async confirm() {
        return confirms.shift() ?? false;
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    async reload() {
      reloads += 1;
    },
  } as unknown as ExtensionCommandContext;
  return { context, notifications, reloads: () => reloads };
}

function captureWrites() {
  const writes: CompactionConfig[] = [];
  return {
    writes,
    save(config: CompactionConfig) {
      writes.push(config);
    },
  };
}

test("registers the exact native settings command name", () => {
  const commands = new Map<string, unknown>();
  const pi = {
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;

  registerPiContextExpertSettingsCommand(pi, { initialConfiguration: {} });

  assert.equal(PI_CONTEXT_EXPERT_SETTINGS_COMMAND, "pi-context-expert-settings");
  assert.deepEqual([...commands.keys()], ["pi-context-expert-settings"]);
});

test("cancel and unavailable UI do not write or reload", async () => {
  const cancelled = createContext({ selects: ["Cancel"] });
  const cancelledWrites = captureWrites();
  await runPiContextExpertSettingsCommand(
    cancelled.context,
    BASIC_CONFIG,
    cancelledWrites.save,
  );
  assert.equal(cancelledWrites.writes.length, 0);
  assert.equal(cancelled.reloads(), 0);

  const unavailable = createContext({ hasUI: false });
  const unavailableWrites = captureWrites();
  await runPiContextExpertSettingsCommand(
    unavailable.context,
    BASIC_CONFIG,
    unavailableWrites.save,
  );
  assert.equal(unavailableWrites.writes.length, 0);
  assert.equal(unavailable.reloads(), 0);
  assert.match(unavailable.notifications[0]?.message ?? "", /interactive UI/);
});

test("enabling Ladder Evidence confirms and enables Ladder compaction", async () => {
  const runtime = createContext({
    selects: ["Evidence: off", "ladder"],
    confirms: [true],
  });
  const saved = captureWrites();

  await runPiContextExpertSettingsCommand(runtime.context, BASIC_CONFIG, saved.save);

  assert.deepEqual(saved.writes, [{
    compaction: { strategy: "ladder" },
    trigger: { mode: "hint" },
    evidence: { strategy: "ladder" },
  }]);
  assert.equal(runtime.reloads(), 1);
  assert.match(runtime.notifications.at(-1)?.message ?? "", /compaction=ladder/);
});

test("rejecting the Ladder Evidence coupling does not write or reload", async () => {
  const runtime = createContext({
    selects: ["Evidence: off", "ladder"],
    confirms: [false],
  });
  const saved = captureWrites();

  await runPiContextExpertSettingsCommand(runtime.context, BASIC_CONFIG, saved.save);

  assert.equal(saved.writes.length, 0);
  assert.equal(runtime.reloads(), 0);
});

test("automatic Trigger requires explicit confirmation", async () => {
  const rejected = createContext({
    selects: ["Trigger: hint", "auto"],
    confirms: [false],
  });
  const rejectedWrites = captureWrites();
  await runPiContextExpertSettingsCommand(rejected.context, BASIC_CONFIG, rejectedWrites.save);
  assert.equal(rejectedWrites.writes.length, 0);
  assert.equal(rejected.reloads(), 0);

  const accepted = createContext({
    selects: ["Trigger: hint", "auto"],
    confirms: [true],
  });
  const acceptedWrites = captureWrites();
  await runPiContextExpertSettingsCommand(accepted.context, BASIC_CONFIG, acceptedWrites.save);
  assert.equal(acceptedWrites.writes[0]?.trigger.mode, "auto");
  assert.equal(accepted.reloads(), 1);
});

test("reset requires confirmation and reloads once after its write", async () => {
  const current: CompactionConfig = {
    compaction: { strategy: "ladder" },
    trigger: { mode: "auto" },
    evidence: { strategy: "ladder" },
  };
  const runtime = createContext({
    selects: ["Reset to defaults"],
    confirms: [true],
  });
  const saved = captureWrites();

  await runPiContextExpertSettingsCommand(runtime.context, current, saved.save);

  assert.deepEqual(saved.writes, [BASIC_CONFIG]);
  assert.equal(runtime.reloads(), 1);
});

test("basic compaction confirms disabling Ladder Evidence", async () => {
  const current: CompactionConfig = {
    compaction: { strategy: "ladder" },
    trigger: { mode: "off" },
    evidence: { strategy: "ladder" },
  };
  const runtime = createContext({
    selects: ["Compaction: ladder", "basic"],
    confirms: [true],
  });
  const saved = captureWrites();

  await runPiContextExpertSettingsCommand(runtime.context, current, saved.save);

  assert.deepEqual(saved.writes[0], {
    compaction: { strategy: "basic" },
    trigger: { mode: "off" },
    evidence: { strategy: "off" },
  });
  assert.equal(runtime.reloads(), 1);
});

test("a failed write leaves the active command state unchanged and does not reload", async () => {
  const runtime = createContext({
    selects: ["Trigger: hint", "off"],
  });

  await runPiContextExpertSettingsCommand(runtime.context, BASIC_CONFIG, () => {
    throw new Error("sensitive path and implementation detail");
  });

  assert.equal(runtime.reloads(), 0);
  assert.deepEqual(runtime.notifications, [{
    message: "Context Expert could not save its settings.",
    type: "error",
  }]);
  assert.equal(BASIC_CONFIG.trigger.mode, "hint");
});
