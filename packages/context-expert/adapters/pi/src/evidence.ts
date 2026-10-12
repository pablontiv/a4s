import { stableDigest } from "./digest.ts";
import { selectLadderProjection, validateProjection } from "./ladder.ts";
import {
  observePreparedCompactionRules,
  type RuleObservationOptions,
} from "./observer.ts";
import { buildRuleObservationPlan } from "./questions.ts";
import { fitWholeSessionState, StateFitError } from "./state.ts";
import type {
  CorpusChunk,
  JevClient,
  NormalizedSessionMessage,
  RuleObservationPlan,
  RuleSignal,
  RuleSignalBatch,
  SourceSpan,
  VisibilityProjection,
} from "./types.ts";

export const EVIDENCE_LADDER_QUERY =
  "Identify material that may originate a durable rule; elevate uncertain candidates.";

export interface EvidenceSource extends SourceSpan {
  sourceMessageIndex: number;
  sourceDigest: string;
  role: string;
}

export interface ExtractRuleSignalsInput {
  projection: VisibilityProjection;
  corpus: readonly CorpusChunk[];
  jev: JevClient;
  signal?: AbortSignal;
  compactionAttemptId: string;
  observedAt: string;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  observation?: RuleObservationOptions;
}

export interface ExtractedRuleSignals {
  batches: RuleSignalBatch[];
  signals: RuleSignal[];
  sources: EvidenceSource[];
}

/** Executes Evidence's dedicated conservative query, never a normal context query. */
export async function selectEvidenceContext(
  corpus: readonly CorpusChunk[],
  jev: JevClient,
  signal: AbortSignal = new AbortController().signal,
): Promise<VisibilityProjection> {
  return selectLadderProjection(
    corpus,
    EVIDENCE_LADDER_QUERY,
    jev,
    signal,
    "conservative-evidence",
  );
}

/**
 * Extracts RuleSignals solely from source ranges admitted by a validated
 * Evidence projection. The existing candidate, generality, and authority
 * thresholds remain the final gate; conservative retrieval does not weaken
 * rule classification.
 */
export async function extractRuleSignals(
  input: ExtractRuleSignalsInput,
): Promise<ExtractedRuleSignals> {
  validateProjection(input.projection, input.corpus);
  const materialized = materializeEvidenceSources(input.projection, input.corpus);
  if (materialized.messages.length === 0) return { batches: [], signals: [], sources: [] };

  const plans = buildEvidencePlans(materialized.messages, input.observation);
  const abortSignal = input.signal ?? new AbortController().signal;
  const batches = await Promise.all(plans.map((plan, windowIndex) =>
    observePreparedCompactionRules(
      plan,
      {
        attemptId: input.compactionAttemptId,
        reason: input.reason,
        willRetry: input.willRetry,
        observedAt: input.observedAt,
        windowIndex,
        windowCount: plans.length,
        pins: { boundary: new Set(), newest: new Set() },
      },
      input.jev,
      abortSignal,
      input.observation,
    ),
  ));

  return {
    batches,
    signals: batches.flatMap((batch) => batch.signals),
    sources: materialized.sources,
  };
}

function materializeEvidenceSources(
  projection: VisibilityProjection,
  corpus: readonly CorpusChunk[],
): { messages: NormalizedSessionMessage[]; sources: EvidenceSource[] } {
  const chunks = new Map(corpus.map((chunk) => [chunk.id, chunk]));
  const messages: NormalizedSessionMessage[] = [];
  const sources: EvidenceSource[] = [];
  const selections = [...projection.selections].sort((left, right) => {
    const leftChunk = requireChunk(chunks, left.chunkId);
    const rightChunk = requireChunk(chunks, right.chunkId);
    return leftChunk.position - rightChunk.position || leftChunk.id.localeCompare(rightChunk.id);
  });

  for (const selection of selections) {
    if (selection.level === "hide") continue;
    const chunk = requireChunk(chunks, selection.chunkId);
    const spans = selection.level === "full"
      ? [{ chunkId: chunk.id, start: 0, end: chunk.text.length }]
      : [...selection.spans].sort((left, right) => left.start - right.start || left.end - right.end);
    for (const span of spans) {
      const text = chunk.text.slice(span.start, span.end);
      if (text.length === 0) continue;
      const sourceMessageIndex = messages.length;
      const sourceDigest = stableDigest({
        schema: "a4s.evidence-source/v1",
        chunkId: chunk.id,
        start: span.start,
        end: span.end,
        role: chunk.role,
        text,
      });
      messages.push({
        index: sourceMessageIndex,
        role: chunk.role,
        text,
        sourceDigest,
        redactionCount: 0,
      });
      sources.push({
        chunkId: chunk.id,
        start: span.start,
        end: span.end,
        sourceMessageIndex,
        sourceDigest,
        role: chunk.role,
      });
    }
  }
  return { messages, sources };
}

function buildEvidencePlans(
  messages: readonly NormalizedSessionMessage[],
  options: RuleObservationOptions = {},
): RuleObservationPlan[] {
  const maxMessagesPerWindow = positiveInteger(options.maxMessagesPerWindow ?? 96, "maxMessagesPerWindow");
  const plans: RuleObservationPlan[] = [];
  for (let start = 0; start < messages.length; start += maxMessagesPerWindow) {
    appendFittablePlans(messages.slice(start, start + maxMessagesPerWindow), plans, options);
  }
  return plans;
}

function appendFittablePlans(
  messages: readonly NormalizedSessionMessage[],
  plans: RuleObservationPlan[],
  options: RuleObservationOptions,
): void {
  try {
    plans.push(buildRuleObservationPlan(fitWholeSessionState(messages, options), options));
  } catch (error) {
    if (!(error instanceof StateFitError) || error.code !== "oversized_state" || messages.length <= 1) {
      throw error;
    }
    const midpoint = Math.ceil(messages.length / 2);
    appendFittablePlans(messages.slice(0, midpoint), plans, options);
    appendFittablePlans(messages.slice(midpoint), plans, options);
  }
}

function requireChunk(chunks: ReadonlyMap<string, CorpusChunk>, id: string): CorpusChunk {
  const chunk = chunks.get(id);
  if (!chunk) throw new Error("Evidence projection selected an unknown corpus chunk");
  return chunk;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
