import { isStableDigest, stableDigest } from "./digest.ts";
import { truncateExcerpt } from "./state.ts";
import type {
  JevCompactionDetails,
  JevCompactionResult,
  JevRequestSchedulerStats,
  MessageCompactionDecision,
  PersistedCompactionDecision,
} from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./types.ts";

export interface BasicCompactionInput {
  attemptId: string;
  sourceDigest: string;
  createdAt: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  decisions: readonly MessageCompactionDecision[];
  scheduler: JevRequestSchedulerStats;
}

export interface BuildJevCompactionOptions {
  maxSummaryChars?: number;
  minimumSummaryExcerptChars?: number;
}

export class CompactionBuildError extends Error {
  readonly code: "coverage" | "oversized_summary";

  constructor(code: "coverage" | "oversized_summary") {
    super(code === "coverage" ? "compaction decisions do not cover the source exactly" : "summary budget is too small");
    this.name = "CompactionBuildError";
    this.code = code;
  }
}

const EMPTY_MESSAGE = "[empty sanitized message]";

export function buildBasicCompactionResult(
  input: BasicCompactionInput,
  options: BuildJevCompactionOptions = {},
): JevCompactionResult {
  const maxSummaryChars = positiveInteger(options.maxSummaryChars ?? 160_000, "maxSummaryChars");
  const minimumExcerptChars = positiveInteger(
    options.minimumSummaryExcerptChars ?? 24,
    "minimumSummaryExcerptChars",
  );
  const decisions = [...input.decisions].sort((left, right) => left.sourceMessageIndex - right.sourceMessageIndex);
  assertCompleteCoverage(decisions, decisions.length, input.attemptId);

  const retained = decisions.filter((decision) => decision.action !== "drop");
  const maximumExcerptChars = Math.max(
    minimumExcerptChars,
    ...retained.map((decision) => Math.max(EMPTY_MESSAGE.length, decision.selectedExcerpt.length)),
  );
  let rendered = renderSummary(input.sourceDigest, decisions, maximumExcerptChars);
  if (rendered.summary.length > maxSummaryChars) {
    const minimum = renderSummary(input.sourceDigest, decisions, minimumExcerptChars);
    if (minimum.summary.length > maxSummaryChars) throw new CompactionBuildError("oversized_summary");
    rendered = minimum;
    let lower = minimumExcerptChars;
    let upper = maximumExcerptChars;
    while (lower <= upper) {
      const midpoint = Math.floor((lower + upper) / 2);
      const candidate = renderSummary(input.sourceDigest, decisions, midpoint);
      if (candidate.summary.length <= maxSummaryChars) {
        rendered = candidate;
        lower = midpoint + 1;
      } else {
        upper = midpoint - 1;
      }
    }
  }

  const persistedDecisions: PersistedCompactionDecision[] = decisions.map((decision) => {
    const summaryExcerpt = rendered.excerpts.get(decision.sourceMessageIndex) ?? "";
    return {
      ...decision,
      summaryExcerpt,
      budgetTruncated: decision.action !== "drop" && summaryExcerpt !== normalizedSelectedExcerpt(decision),
    };
  });
  const budgetTruncatedMessages = persistedDecisions.filter((decision) => decision.budgetTruncated).length;
  const details: JevCompactionDetails = {
    schema: "a4s.jev-compaction-details/v1",
    attemptId: input.attemptId,
    sourceDigest: input.sourceDigest,
    jevModel: DEFAULT_JEV_MODEL,
    createdAt: canonicalTimestamp(input.createdAt),
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: nonNegativeInteger(input.tokensBefore, "tokensBefore"),
    summary: {
      digest: stableDigest(rendered.summary),
      chars: rendered.summary.length,
      budgetChars: maxSummaryChars,
      retainedMessages: retained.length,
      budgetTruncatedMessages,
    },
    scheduler: validateSchedulerStats(input.scheduler),
    decisions: persistedDecisions,
    ruleSignalBatches: [],
  };

  return {
    summary: rendered.summary,
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    details,
  };
}

export function assertCompleteCoverage(
  decisions: readonly MessageCompactionDecision[],
  messageCount: number,
  attemptId: string,
): void {
  if (!isStableDigest(attemptId) || !Number.isSafeInteger(messageCount) || messageCount <= 0 || decisions.length !== messageCount) {
    throw new CompactionBuildError("coverage");
  }
  for (const [index, decision] of decisions.entries()) {
    if (decision.sourceMessageIndex !== index) throw new CompactionBuildError("coverage");
  }
}

function renderSummary(
  sourceDigest: string,
  decisions: readonly MessageCompactionDecision[],
  excerptLimit: number,
): { summary: string; excerpts: Map<number, string> } {
  const excerpts = new Map<number, string>();
  const kept = decisions.filter((decision) => decision.action === "keep").length;
  const truncated = decisions.filter((decision) => decision.action === "truncate").length;
  const dropped = decisions.filter((decision) => decision.action === "drop").length;
  const lines = [
    "# Jev-authoritative compaction",
    "",
    "The following sanitized excerpts were selected deterministically in original chronological order.",
    "",
  ];

  for (const decision of decisions) {
    if (decision.action === "drop") continue;
    const excerpt = truncateExcerpt(normalizedSelectedExcerpt(decision), excerptLimit);
    excerpts.set(decision.sourceMessageIndex, excerpt);
    const forced = decision.forcedBy.length > 0 ? ` · forced=${decision.forcedBy.join(",")}` : "";
    lines.push(
      `## Message ${decision.sourceMessageIndex + 1} · role=${decision.sourceRole} · action=${decision.action}${forced}`,
      "",
      ...quoteExcerpt(excerpt),
      "",
    );
  }

  lines.push(
    "## Compaction audit",
    "",
    `- Source digest: ${sourceDigest}`,
    `- Decisions: keep=${kept}, truncate=${truncated}, drop=${dropped}`,
    `- Model: ${DEFAULT_JEV_MODEL}`,
    "",
  );
  return { summary: lines.join("\n"), excerpts };
}

function quoteExcerpt(excerpt: string): string[] {
  return excerpt.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((line) => `> ${line}`);
}

function normalizedSelectedExcerpt(decision: MessageCompactionDecision): string {
  return decision.selectedExcerpt.length > 0 ? decision.selectedExcerpt : EMPTY_MESSAGE;
}

function validateSchedulerStats(value: JevRequestSchedulerStats): JevRequestSchedulerStats {
  const stats = {
    maxConcurrency: positiveInteger(value.maxConcurrency, "scheduler.maxConcurrency"),
    maxRetries: nonNegativeInteger(value.maxRetries, "scheduler.maxRetries"),
    logicalRequests: positiveInteger(value.logicalRequests, "scheduler.logicalRequests"),
    attempts: positiveInteger(value.attempts, "scheduler.attempts"),
    retries: nonNegativeInteger(value.retries, "scheduler.retries"),
    maxObservedConcurrency: positiveInteger(
      value.maxObservedConcurrency,
      "scheduler.maxObservedConcurrency",
    ),
  };
  if (
    stats.maxObservedConcurrency > stats.maxConcurrency ||
    stats.attempts !== stats.logicalRequests + stats.retries
  ) {
    throw new RangeError("scheduler stats are inconsistent");
  }
  return stats;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError("createdAt must be an ISO timestamp");
  return new Date(value).toISOString();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}
