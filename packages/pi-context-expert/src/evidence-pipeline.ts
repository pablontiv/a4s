import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DeadlineExceededError, OperationAbortedError } from "./deadline.ts";
import { stableDigest } from "./digest.ts";
import { extractRuleSignals, selectEvidenceContext } from "./evidence.ts";
import { JevApiError, JevUnavailableError, JevValidationError } from "./jev.ts";
import { LadderProjectionError } from "./ladder.ts";
import type { RuleObservationOptions } from "./observer.ts";
import { ObservationPlanError } from "./questions.ts";
import { StateFitError } from "./state.ts";
import {
  collectEvidenceReceipts,
  collectRetroPendingMarkers,
  collectRuleSignalBatches,
  EVIDENCE_RECEIPT_ENTRY_TYPE,
  parseEvidenceReceipt,
  parseRetroPendingMarker,
  parseRuleSignalBatch,
  RETRO_PENDING_ENTRY_TYPE,
  RULE_SIGNAL_ENTRY_TYPE,
  type OperationalFailureCode,
} from "./storage.ts";
import type {
  CompactionConfig,
  CorpusChunk,
  EvidenceReceipt,
  JevClient,
  JevCompactionResult,
  RetroPendingMarker,
  RuleSignal,
} from "./types.ts";

export interface EvidencePipeline {
  afterCompaction(result: JevCompactionResult, ctx: ExtensionContext): Promise<void>;
}

export interface EvidenceEntryAppender {
  appendEntry(customType: string, data: unknown): unknown;
}

export interface RunEvidenceInput {
  config: CompactionConfig;
  result: JevCompactionResult;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  corpus: readonly CorpusChunk[];
  getBranch: () => readonly unknown[];
  appender: EvidenceEntryAppender;
  jev: JevClient;
  signal?: AbortSignal;
  observation?: RuleObservationOptions;
}

export interface RunEvidenceResult {
  status: "disabled" | "empty-corpus" | "failed" | "published" | "already-published";
  signals: RuleSignal[];
  receipt?: EvidenceReceipt;
  rootlineWrites: 0;
  /** Preserved for callers that need to continue the successful lifecycle. */
  compactionResult: JevCompactionResult;
}

/** Evidence is the explicit no-op for the default/basic lifecycle. */
export const disabledEvidencePipeline: EvidencePipeline = {
  async afterCompaction() {},
};

/**
 * Runs selection and extraction fully before publishing any review artifact.
 * Corpus is caller-owned durable input and is never removed or mutated on any
 * failure. The receipt is appended last, making interrupted publication safe
 * to replay without duplicating validated batches or markers.
 */
export async function runEvidence(input: RunEvidenceInput): Promise<RunEvidenceResult> {
  return runEvidenceWithFailure(input);
}

export async function runEvidenceWithFailure(
  input: RunEvidenceInput,
  onFailure?: (code: OperationalFailureCode) => void,
): Promise<RunEvidenceResult> {
  const base = { signals: [] as RuleSignal[], rootlineWrites: 0 as const, compactionResult: input.result };
  if (input.config.compaction.strategy !== "ladder" || input.config.evidence.strategy !== "ladder") {
    return { status: "disabled", ...base };
  }
  if (input.corpus.length === 0) return { status: "empty-corpus", ...base };

  const existingReceipt = collectEvidenceReceipts(input.getBranch()).find(
    (receipt) => receipt.compactionAttemptId === input.result.details.attemptId,
  );
  if (existingReceipt) {
    return { status: "already-published", ...base, receipt: existingReceipt };
  }

  let publishing = false;
  try {
    const projection = await selectEvidenceContext(
      input.corpus,
      input.jev,
      input.signal ?? new AbortController().signal,
    );
    const extracted = await extractRuleSignals({
      projection,
      corpus: input.corpus,
      jev: input.jev,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      compactionAttemptId: input.result.details.attemptId,
      observedAt: input.result.details.createdAt,
      reason: input.reason,
      willRetry: input.willRetry,
      ...(input.observation === undefined ? {} : { observation: input.observation }),
    });
    const batchDigests = extracted.batches.map((batch) => stableDigest(batch));
    const signalIds = [...new Set(extracted.signals.map((signal) => signal.id))];
    for (const ruleSignal of extracted.signals) {
      const source = extracted.sources[ruleSignal.sourceMessageIndex];
      if (!source || source.sourceDigest !== ruleSignal.sourceMessageDigest) {
        throw new Error("Evidence signal is not bound to a selected source span");
      }
    }
    const sourceSpans = extracted.sources.map(
      ({ chunkId, start, end, sourceMessageIndex, sourceDigest }) => ({
        chunkId,
        start,
        end,
        sourceMessageIndex,
        sourceDigest,
      }),
    );
    const receiptWithoutId = {
      schema: "a4s.evidence-receipt/v1" as const,
      compactionAttemptId: input.result.details.attemptId,
      queryDigest: projection.queryDigest,
      corpusDigest: projection.corpusDigest,
      sourceSpans,
      batchDigests,
      signalIds,
    };
    const receipt: EvidenceReceipt = {
      ...receiptWithoutId,
      idempotencyKey: stableDigest(receiptWithoutId),
    };
    const marker: RetroPendingMarker | undefined = extracted.batches.length === 0
      ? undefined
      : {
        schema: "a4s.retro-pending/v1",
        attemptId: input.result.details.attemptId,
        createdAt: input.result.details.createdAt,
        sourceDigests: extracted.batches.map((batch) => batch.sourceDigest),
        compactionReason: input.reason,
        deferredUntilAgentSettled: input.willRetry,
      };

    // Validate the complete publication set before the first append.
    for (const batch of extracted.batches) parseRuleSignalBatch(batch);
    if (marker) parseRetroPendingMarker(marker);
    parseEvidenceReceipt(receipt);

    const existingBatchDigests = new Set(
      collectRuleSignalBatches(input.getBranch()).map((batch) => stableDigest(batch)),
    );
    publishing = true;
    for (const [index, batch] of extracted.batches.entries()) {
      if (!existingBatchDigests.has(batchDigests[index]!)) {
        input.appender.appendEntry(RULE_SIGNAL_ENTRY_TYPE, batch);
      }
    }
    if (
      marker &&
      !collectRetroPendingMarkers(input.getBranch()).some((candidate) => candidate.attemptId === marker.attemptId)
    ) {
      input.appender.appendEntry(RETRO_PENDING_ENTRY_TYPE, marker);
    }
    input.appender.appendEntry(EVIDENCE_RECEIPT_ENTRY_TYPE, receipt);
    return {
      status: "published",
      signals: extracted.signals,
      receipt,
      rootlineWrites: 0,
      compactionResult: input.result,
    };
  } catch (error) {
    try {
      onFailure?.(publishing ? "storage_failure" : classifyEvidenceFailure(error));
    } catch {
      // El callback es best-effort. Evidence conserva su resultado público.
    }
    return { status: "failed", ...base };
  }
}

function classifyEvidenceFailure(error: unknown): OperationalFailureCode {
  if (error instanceof JevUnavailableError) return "missing_key";
  if (error instanceof DeadlineExceededError) return "timeout";
  if (error instanceof OperationAbortedError) return "aborted";
  if (error instanceof LadderProjectionError || error instanceof JevValidationError) return "malformed_response";
  if (error instanceof StateFitError || error instanceof ObservationPlanError) return "oversized_state";
  if (error instanceof JevApiError) return "api_failure";
  return "internal_failure";
}
