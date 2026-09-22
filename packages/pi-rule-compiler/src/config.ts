import type { CompactionConfig } from "./types.ts";

export const A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY = "A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY";
export const A4S_PI_RULE_COMPILER_TRIGGER_MODE = "A4S_PI_RULE_COMPILER_TRIGGER_MODE";
export const A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY = "A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY";

/**
 * Projects the installed entrypoint's three non-secret process settings onto
 * the same flat configuration surface used by programmatic embeddings.
 */
export function configurationFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, unknown>> {
  const config: Record<string, unknown> = {};
  const compactionStrategy = env[A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY];
  const triggerMode = env[A4S_PI_RULE_COMPILER_TRIGGER_MODE];
  const evidenceStrategy = env[A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY];
  if (compactionStrategy !== undefined) config["compaction.strategy"] = compactionStrategy;
  if (triggerMode !== undefined) config["trigger.mode"] = triggerMode;
  if (evidenceStrategy !== undefined) config["evidence.strategy"] = evidenceStrategy;
  return config;
}

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

function isCompactionStrategy(value: unknown): value is CompactionConfig["compaction"]["strategy"] {
  return value === "basic" || value === "ladder";
}

function isTriggerMode(value: unknown): value is CompactionConfig["trigger"]["mode"] {
  return value === "off" || value === "hint" || value === "auto";
}

function isEvidenceStrategy(value: unknown): value is CompactionConfig["evidence"]["strategy"] {
  return value === "off" || value === "ladder";
}
