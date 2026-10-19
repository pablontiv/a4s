import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  BASIC_COMPACTION_CONFIG,
  flatConfiguration,
  resolveCompactionConfig,
  writeGlobalCompactionConfiguration,
} from "./config.ts";
import type { CompactionConfig } from "./types.ts";

export const PI_CONTEXT_EXPERT_SETTINGS_COMMAND = "pi-context-expert-settings";

export interface PiContextExpertSettingsCommandOptions {
  readonly initialConfiguration: Readonly<Record<string, unknown>>;
  readonly save?: (config: CompactionConfig) => void;
}

/** Registers the interactive global settings command supported by Pi and Pion. */
export function registerPiContextExpertSettingsCommand(
  pi: ExtensionAPI,
  options: PiContextExpertSettingsCommandOptions,
): void {
  const current = resolveCompactionConfig(options.initialConfiguration);
  const save = options.save ?? writeGlobalCompactionConfiguration;

  pi.registerCommand(PI_CONTEXT_EXPERT_SETTINGS_COMMAND, {
    description: "Configure Context Expert compaction, trigger, and Evidence modes",
    handler: async (_args, ctx) => {
      await runPiContextExpertSettingsCommand(ctx, current, save);
    },
  });
}

export async function runPiContextExpertSettingsCommand(
  ctx: ExtensionCommandContext,
  current: CompactionConfig,
  save: (config: CompactionConfig) => void = writeGlobalCompactionConfiguration,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Context Expert settings require an interactive UI.", "warning");
    return;
  }

  const compactionOption = `Compaction: ${current.compaction.strategy}`;
  const triggerOption = `Trigger: ${current.trigger.mode}`;
  const evidenceOption = `Evidence: ${current.evidence.strategy}`;
  const selected = await ctx.ui.select("Context Expert settings", [
    compactionOption,
    triggerOption,
    evidenceOption,
    "Reset to defaults",
    "Cancel",
  ]);

  let next: CompactionConfig | undefined;
  if (selected === compactionOption) {
    next = await selectCompaction(ctx, current);
  } else if (selected === triggerOption) {
    next = await selectTrigger(ctx, current);
  } else if (selected === evidenceOption) {
    next = await selectEvidence(ctx, current);
  } else if (selected === "Reset to defaults") {
    const confirmed = await ctx.ui.confirm(
      "Reset Context Expert settings",
      "Reset Compaction to basic, Trigger to hint, and Evidence to off?",
    );
    if (confirmed) next = cloneConfiguration(BASIC_COMPACTION_CONFIG);
  }

  if (!next) return;

  try {
    save(next);
  } catch {
    ctx.ui.notify("Context Expert could not save its settings.", "error");
    return;
  }

  ctx.ui.notify(`Context Expert settings saved: ${formatConfiguration(next)}.`, "info");
  await ctx.reload();
}

async function selectCompaction(
  ctx: ExtensionCommandContext,
  current: CompactionConfig,
): Promise<CompactionConfig | undefined> {
  const selected = await ctx.ui.select(
    `Compaction strategy (current: ${current.compaction.strategy})`,
    ["basic", "ladder", "Cancel"],
  );
  if (selected !== "basic" && selected !== "ladder") return undefined;
  if (selected === current.compaction.strategy) return undefined;

  if (selected === "basic" && current.evidence.strategy === "ladder") {
    const confirmed = await ctx.ui.confirm(
      "Disable Ladder Evidence",
      "Basic compaction requires Evidence to change to off. Apply both changes?",
    );
    if (!confirmed) return undefined;
    return {
      compaction: { strategy: "basic" },
      trigger: { mode: current.trigger.mode },
      evidence: { strategy: "off" },
    };
  }

  return {
    compaction: { strategy: selected },
    trigger: { mode: current.trigger.mode },
    evidence: { strategy: current.evidence.strategy },
  };
}

async function selectTrigger(
  ctx: ExtensionCommandContext,
  current: CompactionConfig,
): Promise<CompactionConfig | undefined> {
  const selected = await ctx.ui.select(
    `Trigger mode (current: ${current.trigger.mode})`,
    ["off", "hint", "auto", "Cancel"],
  );
  if (selected !== "off" && selected !== "hint" && selected !== "auto") return undefined;
  if (selected === current.trigger.mode) return undefined;

  if (selected === "auto") {
    const confirmed = await ctx.ui.confirm(
      "Enable automatic compaction",
      "Allow Context Expert to start compaction automatically when its trigger gates pass?",
    );
    if (!confirmed) return undefined;
  }

  return {
    compaction: { strategy: current.compaction.strategy },
    trigger: { mode: selected },
    evidence: { strategy: current.evidence.strategy },
  };
}

async function selectEvidence(
  ctx: ExtensionCommandContext,
  current: CompactionConfig,
): Promise<CompactionConfig | undefined> {
  const selected = await ctx.ui.select(
    `Evidence strategy (current: ${current.evidence.strategy})`,
    ["off", "ladder", "Cancel"],
  );
  if (selected !== "off" && selected !== "ladder") return undefined;
  if (selected === current.evidence.strategy) return undefined;

  if (selected === "ladder" && current.compaction.strategy !== "ladder") {
    const confirmed = await ctx.ui.confirm(
      "Enable Ladder compaction",
      "Ladder Evidence requires Compaction to change to ladder. Apply both changes?",
    );
    if (!confirmed) return undefined;
    return {
      compaction: { strategy: "ladder" },
      trigger: { mode: current.trigger.mode },
      evidence: { strategy: "ladder" },
    };
  }

  return {
    compaction: { strategy: current.compaction.strategy },
    trigger: { mode: current.trigger.mode },
    evidence: { strategy: selected },
  };
}

function cloneConfiguration(config: CompactionConfig): CompactionConfig {
  return {
    compaction: { strategy: config.compaction.strategy },
    trigger: { mode: config.trigger.mode },
    evidence: { strategy: config.evidence.strategy },
  };
}

function formatConfiguration(config: CompactionConfig): string {
  const flat = flatConfiguration(config);
  return [
    `compaction=${String(flat["compaction.strategy"])}`,
    `trigger=${String(flat["trigger.mode"])}`,
    `evidence=${String(flat["evidence.strategy"])}`,
  ].join(", ");
}
