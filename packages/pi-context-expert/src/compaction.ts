import { assertCompleteCoverage, buildBasicCompactionResult } from "./compaction-core.ts";
import { isStableDigest } from "./digest.ts";
import { parseRuleSignalBatch, StoredEntryValidationError } from "./storage.ts";
import type {
  JevCompactionResult,
  JevRequestSchedulerStats,
  RuleSignalBatch,
} from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./types.ts";
import type { BuildJevCompactionOptions } from "./compaction-core.ts";

export type { BuildJevCompactionOptions } from "./compaction-core.ts";
export { CompactionBuildError } from "./compaction-core.ts";

/**
 * Backward-compatible adapter for callers that still provide RuleSignal batches.
 * Retention is built exclusively from their decisions; basic results never retain
 * Evidence artifacts.
 */
export interface BuildJevCompactionInput {
  attemptId: string;
  sourceDigest: string;
  createdAt: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  messageCount: number;
  scheduler: JevRequestSchedulerStats;
  ruleSignalBatches: RuleSignalBatch[];
}

export function buildJevCompactionResult(
  input: BuildJevCompactionInput,
  options: BuildJevCompactionOptions = {},
): JevCompactionResult {
  const decisions = input.ruleSignalBatches
    .flatMap((batch) => batch.compaction.decisions)
    .sort((left, right) => left.sourceMessageIndex - right.sourceMessageIndex);
  assertCompleteCoverage(decisions, input.messageCount, input.attemptId);
  return buildBasicCompactionResult(
    {
      attemptId: input.attemptId,
      sourceDigest: input.sourceDigest,
      createdAt: input.createdAt,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      decisions,
      scheduler: input.scheduler,
    },
    options,
  );
}

export function recoverRuleSignalBatchesFromDetails(
  value: unknown,
): { attemptId: string; sourceDigest: string; batches: RuleSignalBatch[] } | undefined {
  const record = optionalRecord(value);
  if (
    record?.schema !== "a4s.jev-compaction-details/v1" ||
    !isStableDigest(record.attemptId) ||
    !isStableDigest(record.sourceDigest) ||
    record.jevModel !== DEFAULT_JEV_MODEL ||
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
