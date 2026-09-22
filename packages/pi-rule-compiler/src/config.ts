import type { CompactionConfig } from "./types.ts";

/** The safe, backwards-compatible configuration used when no valid opt-in is supplied. */
export const BASIC_COMPACTION_CONFIG: CompactionConfig = {
  compaction: { strategy: "basic" },
  trigger: { mode: "hint" },
  evidence: { strategy: "off" },
};

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
