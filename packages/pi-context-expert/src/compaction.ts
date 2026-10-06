import { isStableDigest } from "./digest.ts";
import { parseRuleSignalBatch, StoredEntryValidationError } from "./storage.ts";
import type { RuleSignalBatch } from "./types.ts";
import { isSupportedJevModel } from "./types.ts";

/** Reads RuleSignal batches from historical compaction details without creating a new compaction. */
export function recoverRuleSignalBatchesFromDetails(
  value: unknown,
): { attemptId: string; sourceDigest: string; batches: RuleSignalBatch[] } | undefined {
  const record = optionalRecord(value);
  if (
    record?.schema !== "a4s.jev-compaction-details/v1" ||
    !isStableDigest(record.attemptId) ||
    !isStableDigest(record.sourceDigest) ||
    !isSupportedJevModel(record.jevModel) ||
    !Array.isArray(record.ruleSignalBatches)
  ) {
    return undefined;
  }
  try {
    const batches = record.ruleSignalBatches.map((batch) => parseRuleSignalBatch(batch));
    if (batches.some((batch) => batch.provenance.compactionAttemptId !== record.attemptId)) return undefined;
    return { attemptId: record.attemptId, sourceDigest: record.sourceDigest, batches };
  } catch (error) {
    if (error instanceof StoredEntryValidationError) return undefined;
    throw error;
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
