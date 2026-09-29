import { stableDigest } from "./digest.ts";
import { redactAndLimitCorpusText } from "./redaction.ts";
import {
  collectCorpus,
  collectCorpusReceipts,
  CORPUS_ENTRY_TYPE,
} from "./storage.ts";
import type { CorpusChunk, CorpusReceipt, NormalizedSessionMessage } from "./types.ts";

export { collectCorpus, CORPUS_ENTRY_TYPE } from "./storage.ts";

const MAX_CORPUS_CHUNKS = 256;
const DEFAULT_BRANCH_ID = stableDigest({ schema: "a4s.corpus-branch/v1", branch: "unknown" });

export interface CorpusStageOptions {
  branchId?: string;
  compactionAttemptId?: string;
}

export interface CorpusEntryAppender {
  appendEntry(customType: string, data: unknown): unknown;
}

/**
 * Builds a persistable corpus exclusively from normalized messages. Text is
 * redacted and bounded again here before every source-derived identifier.
 */
export function stageCorpus(
  messages: readonly NormalizedSessionMessage[],
  options: CorpusStageOptions = {},
): CorpusChunk[] {
  const branchId = sanitizeBranchId(options.branchId);
  const staged: CorpusChunk[] = [];
  for (const message of messages.slice(0, MAX_CORPUS_CHUNKS)) {
    if (!isNormalizedMessage(message)) continue;
    const role = sanitizeRole(message.role);
    const text = redactAndLimitCorpusText(message.text).text;
    if (text.length === 0) continue;
    const position = Number.isSafeInteger(message.index) && message.index >= 0 ? message.index : staged.length;
    const sourceDigest = stableDigest({ schema: "a4s.corpus-source/v1", role, text });
    const compactionAttemptId = sanitizeAttemptId(options.compactionAttemptId, sourceDigest);
    const provenance = { branchId, compactionAttemptId, sourceDigest };
    const digest = stableDigest({ schema: "a4s.corpus-chunk/v1", role, position, text, provenance });
    staged.push({
      schema: "a4s.corpus-chunk/v1",
      id: stableDigest({ schema: "a4s.corpus-chunk-id/v1", digest }),
      digest,
      role,
      position,
      text,
      provenance,
    });
  }
  return deduplicateChunks(staged);
}

/**
 * Publishes staged chunks only after Pi's session_compact event. Existing
 * chunks and the receipt are read from the supplied current branch so a retry
 * or reload cannot duplicate durable corpus records.
 */
export function publishCorpusAfterCompaction(
  chunks: readonly CorpusChunk[],
  branch: readonly unknown[],
  appender: CorpusEntryAppender,
): CorpusReceipt | undefined {
  if (chunks.length === 0) return undefined;
  const receipt = receiptFor(chunks);
  if (collectCorpusReceipts(branch).some((candidate) => candidate.idempotencyKey === receipt.idempotencyKey)) {
    return receipt;
  }
  const existing = new Set(collectCorpus(branch).map((chunk) => chunk.id));
  for (const chunk of chunks) {
    if (!existing.has(chunk.id)) appender.appendEntry(CORPUS_ENTRY_TYPE, chunk);
  }
  appender.appendEntry(CORPUS_ENTRY_TYPE, receipt);
  return receipt;
}

function receiptFor(chunks: readonly CorpusChunk[]): CorpusReceipt {
  const first = chunks[0];
  if (!first) throw new Error("a corpus receipt requires chunks");
  const branchId = first.provenance.branchId;
  const compactionAttemptId = first.provenance.compactionAttemptId;
  const chunkIds = [...new Set(chunks.map((chunk) => {
    if (chunk.provenance.branchId !== branchId || chunk.provenance.compactionAttemptId !== compactionAttemptId) {
      throw new Error("corpus chunks must share branch and compaction attempt");
    }
    return chunk.id;
  }))];
  const idempotencyKey = stableDigest({ schema: "a4s.corpus-receipt/v1", branchId, compactionAttemptId, chunkIds });
  return { schema: "a4s.corpus-receipt/v1", idempotencyKey, branchId, compactionAttemptId, chunkIds };
}

function isNormalizedMessage(value: NormalizedSessionMessage): boolean {
  return typeof value.role === "string" && typeof value.text === "string";
}

function sanitizeRole(role: string): string {
  const sanitized = redactAndLimitCorpusText(role, 80).text.replaceAll(/[\r\n\t]/g, " ").trim();
  return sanitized.length > 0 ? sanitized : "unknown";
}

function sanitizeBranchId(branchId: string | undefined): string {
  const text = redactAndLimitCorpusText(branchId ?? DEFAULT_BRANCH_ID, 200).text;
  return text.length > 0 ? text : DEFAULT_BRANCH_ID;
}

function sanitizeAttemptId(attemptId: string | undefined, sourceDigest: string): string {
  if (attemptId && /^sha256:[0-9a-f]{64}$/.test(attemptId)) return attemptId;
  return stableDigest({ schema: "a4s.corpus-attempt/v1", sourceDigest });
}

function deduplicateChunks(chunks: readonly CorpusChunk[]): CorpusChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    if (seen.has(chunk.id)) return false;
    seen.add(chunk.id);
    return true;
  });
}
