import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionConfig } from "./types.ts";

export const PI_CONTEXT_EXPERT_GLOBAL_CONFIG_PATH = "~/.pi/agent/pi-context-expert.json";

const FLAT_CONFIG_KEYS = new Set([
  "compaction.strategy",
  "trigger.mode",
  "evidence.strategy",
]);

/** The safe, backwards-compatible configuration used when no valid opt-in is supplied. */
export const BASIC_COMPACTION_CONFIG: CompactionConfig = {
  compaction: { strategy: "basic" },
  trigger: { mode: "hint" },
  evidence: { strategy: "off" },
};

/** True only for the explicit request-time retrieval opt-in. */
export function isLadderCompaction(config: CompactionConfig): boolean {
  return config.compaction.strategy === "ladder";
}

/** Evidence has a double opt-in: it cannot run without Ladder compaction. */
export function isLadderEvidence(config: CompactionConfig): boolean {
  return config.compaction.strategy === "ladder" && config.evidence.strategy === "ladder";
}

/**
 * Resolves the deliberately small public configuration surface. Invalid or
 * incomplete updates never partially enable an opt-in feature: the complete
 * preceding safe value is retained.
 */
export function resolveCompactionConfig(
  raw: Readonly<Record<string, unknown>> | undefined,
  previous: CompactionConfig = BASIC_COMPACTION_CONFIG,
): CompactionConfig {
  if (!raw) return previous;
  const compactionStrategy = raw["compaction.strategy"] ?? previous.compaction.strategy;
  const triggerMode = raw["trigger.mode"] ?? previous.trigger.mode;
  const evidenceStrategy = raw["evidence.strategy"] ?? previous.evidence.strategy;

  if (
    !isCompactionStrategy(compactionStrategy) ||
    !isTriggerMode(triggerMode) ||
    !isEvidenceStrategy(evidenceStrategy) ||
    (evidenceStrategy === "ladder" && compactionStrategy !== "ladder")
  ) {
    return previous;
  }

  return {
    compaction: { strategy: compactionStrategy },
    trigger: { mode: triggerMode },
    evidence: { strategy: evidenceStrategy },
  };
}

/** Parses the persisted global file without accepting any additional fields. */
export function configurationFromGlobalFile(
  contents: string | undefined,
): Readonly<Record<string, unknown>> {
  if (contents === undefined) return flatConfiguration(BASIC_COMPACTION_CONFIG);

  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || Object.keys(parsed).some((key) => !FLAT_CONFIG_KEYS.has(key))) {
      return flatConfiguration(BASIC_COMPACTION_CONFIG);
    }
    return flatConfiguration(resolveCompactionConfig(parsed, BASIC_COMPACTION_CONFIG));
  } catch {
    return flatConfiguration(BASIC_COMPACTION_CONFIG);
  }
}

/** Reads the sole installed configuration location. Any read failure is basic. */
export function loadGlobalCompactionConfiguration(): Readonly<Record<string, unknown>> {
  try {
    return configurationFromGlobalFile(readFileSync(globalCompactionConfigPath(), "utf8"));
  } catch {
    return configurationFromGlobalFile(undefined);
  }
}

export function globalCompactionConfigPath(): string {
  return join(homedir(), ".pi", "agent", "pi-context-expert.json");
}

function flatConfiguration(config: CompactionConfig): Readonly<Record<string, unknown>> {
  return {
    "compaction.strategy": config.compaction.strategy,
    "trigger.mode": config.trigger.mode,
    "evidence.strategy": config.evidence.strategy,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompactionStrategy(value: unknown): value is CompactionConfig["compaction"]["strategy"] {
  return value === "basic" || value === "ladder";
}

function isTriggerMode(value: unknown): value is CompactionConfig["trigger"]["mode"] {
  return value === "off" || value === "hint" || value === "auto";
}

function isEvidenceStrategy(value: unknown): value is CompactionConfig["evidence"]["strategy"] {
  return value === "off" || value === "ladder";
}
