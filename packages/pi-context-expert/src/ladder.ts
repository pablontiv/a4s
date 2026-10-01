import { stableDigest } from "./digest.ts";
import { validateJevResponse } from "./jev.ts";
import { buildLadderQuestions, type LadderQuestionRef } from "./questions.ts";
import { estimateJevTokens } from "./state.ts";
import type {
  CorpusChunk,
  JevClient,
  SourceSpan,
  VisibilityLevel,
  VisibilityProjection,
} from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./types.ts";

export const SHORT_SPAN_CHAR_LIMIT = 240;
export const LONG_SPAN_CHAR_LIMIT = 1_200;
export const DEFAULT_LADDER_MAX_CANDIDATE_CHUNKS = 48;
export const DEFAULT_LADDER_RECENT_CHUNKS = 8;
export const DEFAULT_LADDER_MAX_STATE_TOKENS = 20_000;
export type LadderProfile = "ordinary" | "conservative-evidence";

export interface LadderShortlistOptions {
  maxCandidateChunks?: number;
  recentChunks?: number;
  maxStateTokens?: number;
}

export interface LadderShortlist {
  corpus: readonly CorpusChunk[];
  estimatedStateTokens: number;
  sourceChunks: number;
  strategy: "full" | "lexical-recency";
}

export class LadderProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LadderProjectionError";
  }
}

export class LadderShortlistError extends Error {
  readonly code = "oversized_state" as const;

  constructor() {
    super("Ladder shortlist cannot fit one corpus chunk within the configured state budget");
    this.name = "LadderShortlistError";
  }
}

/** Stable corpus identity for one canonical durable append chronology. */
export function corpusDigest(corpus: readonly CorpusChunk[]): string {
  return stableDigest({
    schema: "a4s.ladder-corpus/v1",
    chunks: orderedCorpus(corpus).map((chunk) => ({ id: chunk.id, digest: chunk.digest })),
  });
}

/**
 * Validates a complete, immutable retrieval view before it reaches Pi's context.
 * A projection cannot invent chunks, silently omit an unselected chunk, or use
 * unbounded/overlapping source slices.
 */
export function validateProjection(
  projection: VisibilityProjection,
  corpus: readonly CorpusChunk[],
): void {
  if (projection.corpusDigest !== corpusDigest(corpus)) {
    throw new LadderProjectionError("projection corpus digest does not match the current branch corpus");
  }
  if (typeof projection.queryDigest !== "string" || projection.queryDigest.length === 0) {
    throw new LadderProjectionError("projection query digest is required");
  }

  const chunks = new Map<string, CorpusChunk>();
  for (const chunk of corpus) {
    if (chunks.has(chunk.id)) throw new LadderProjectionError("corpus contains duplicate chunk ids");
    chunks.set(chunk.id, chunk);
  }
  if (projection.selections.length !== chunks.size) {
    throw new LadderProjectionError("projection must cover every corpus chunk exactly once");
  }

  const selected = new Set<string>();
  for (const selection of projection.selections) {
    const chunk = chunks.get(selection.chunkId);
    if (!chunk) throw new LadderProjectionError("projection selected an unknown corpus chunk");
    if (selected.has(selection.chunkId)) throw new LadderProjectionError("projection selected a corpus chunk more than once");
    selected.add(selection.chunkId);
    validateSelection(selection.level, selection.spans, chunk);
  }
}

/** Renders validated historical sources with explicit chronology and boundaries. */
export function renderProjection(
  projection: VisibilityProjection,
  corpus: readonly CorpusChunk[],
): string {
  validateProjection(projection, corpus);
  const selections = new Map(projection.selections.map((selection) => [selection.chunkId, selection]));
  const visible = orderedCorpus(corpus).flatMap((chunk) => {
    const selection = selections.get(chunk.id);
    if (!selection) return [];
    const excerpts = renderSelection(selection, chunk).filter((text) => text.length > 0);
    return excerpts.length > 0 ? [{ chunk, excerpts }] : [];
  });
  if (visible.length === 0) return "";

  const sources = visible.map(({ chunk, excerpts }, index) =>
    `[source ${index + 1}/${visible.length} | role=${chunk.role}]\n${excerpts.join("\n")}`
  );
  return [
    "[a4s ladder context]",
    "Selected historical source excerpts are ordered oldest to newest.",
    "Later source excerpts supersede conflicting earlier excerpts. Mutable repository state must be verified against the current checkout.",
    ...sources,
  ].join("\n");
}

/**
 * Bounds a large branch corpus before semantic ranking. Exact query matches and
 * recent continuity are retained deterministically; Jev remains authoritative
 * over the visibility level of every shortlisted chunk.
 */
export function shortlistLadderCorpus(
  corpus: readonly CorpusChunk[],
  query: string,
  profile: LadderProfile = "ordinary",
  options: LadderShortlistOptions = {},
): LadderShortlist {
  const maxCandidateChunks = positiveInteger(
    options.maxCandidateChunks ?? DEFAULT_LADDER_MAX_CANDIDATE_CHUNKS,
    "maxCandidateChunks",
  );
  const recentChunks = nonNegativeInteger(
    options.recentChunks ?? DEFAULT_LADDER_RECENT_CHUNKS,
    "recentChunks",
  );
  const maxStateTokens = positiveInteger(
    options.maxStateTokens ?? DEFAULT_LADDER_MAX_STATE_TOKENS,
    "maxStateTokens",
  );
  const ordered = orderedCorpus(corpus);
  const fullTokens = ladderStateTokens(ordered, query, profile);
  if (ordered.length <= maxCandidateChunks && fullTokens <= maxStateTokens) {
    return {
      corpus: ordered,
      estimatedStateTokens: fullTokens,
      sourceChunks: ordered.length,
      strategy: "full",
    };
  }

  const terms = queryTerms(query);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const timelineIndex = new Map(ordered.map((chunk, index) => [chunk.id, index]));
  const ranked = ordered
    .map((chunk) => ({ chunk, score: lexicalScore(chunk.text, normalizedQuery, terms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      requireTimelineIndex(timelineIndex, right.chunk.id) - requireTimelineIndex(timelineIndex, left.chunk.id) ||
      left.chunk.id.localeCompare(right.chunk.id)
    );
  const newest = [...ordered].reverse();
  const selected = new Map<string, CorpusChunk>();
  let selectedTokens = ladderStateTokens([], query, profile);
  if (ordered.length > 0 && selectedTokens > maxStateTokens) throw new LadderShortlistError();

  const tryAdd = (chunk: CorpusChunk): void => {
    if (selected.size >= maxCandidateChunks || selected.has(chunk.id)) return;
    const candidate = [...selected.values(), chunk].sort(compareChunks);
    const candidateTokens = ladderStateTokens(candidate, query, profile);
    if (candidateTokens > maxStateTokens) return;
    selected.set(chunk.id, chunk);
    selectedTokens = candidateTokens;
  };

  for (const chunk of newest.slice(0, Math.min(recentChunks, maxCandidateChunks))) tryAdd(chunk);
  for (const candidate of ranked) tryAdd(candidate.chunk);
  for (const chunk of newest) tryAdd(chunk);
  if (ordered.length > 0 && selected.size === 0) throw new LadderShortlistError();

  return {
    corpus: ordered.filter((chunk) => selected.has(chunk.id)),
    estimatedStateTokens: selectedTokens,
    sourceChunks: ordered.length,
    strategy: "lexical-recency",
  };
}

/**
 * Performs one Jev retrieval query against a branch-scoped sanitized corpus.
 * Jev determines visibility; source ranges are then bounded deterministically
 * from the concrete query so the projection is always renderable and auditable.
 */
export async function selectLadderProjection(
  corpus: readonly CorpusChunk[],
  query: string,
  jevClient: JevClient,
  signal: AbortSignal,
  profile: LadderProfile = "ordinary",
): Promise<VisibilityProjection> {
  if (query.trim().length === 0) throw new LadderProjectionError("a concrete non-empty query is required");
  const ordered = orderedCorpus(corpus);
  if (ordered.length === 0) {
    return { queryDigest: stableDigest(query), corpusDigest: corpusDigest(corpus), selections: [] };
  }

  const { questions, refs } = buildLadderQuestions(ordered, query);
  const request = {
    state: ladderState(ordered, query, profile),
    model: DEFAULT_JEV_MODEL,
    questions,
  } as const;
  const response = validateJevResponse(await jevClient.evaluate(request, { signal }), questions);
  const selections = refs.map((ref) => {
    const answer = response.answers[ref.questionId];
    if (!answer || answer.type !== "choice") throw new LadderProjectionError("Jev returned an invalid Ladder answer");
    return selectionFromAnswer(ref, ordered, conservativeLevel(answer, profile));
  });
  const projection: VisibilityProjection = {
    queryDigest: stableDigest(query),
    corpusDigest: corpusDigest(corpus),
    selections,
  };
  validateProjection(projection, corpus);
  return projection;
}

function conservativeLevel(
  answer: { choice: string; probabilities: Record<string, number>; confidence: number },
  profile: LadderProfile,
): string {
  if (profile !== "conservative-evidence") return answer.choice;
  const selectedProbability = answer.probabilities[answer.choice];
  if (
    selectedProbability === undefined ||
    answer.confidence < 0.8 ||
    selectedProbability < 0.8
  ) {
    return "full";
  }
  return answer.choice;
}

function selectionFromAnswer(
  ref: LadderQuestionRef,
  corpus: readonly CorpusChunk[],
  level: string | undefined,
): VisibilityProjection["selections"][number] {
  if (!isVisibilityLevel(level)) throw new LadderProjectionError("Jev returned an invalid Ladder visibility level");
  const chunk = corpus[ref.corpusIndex];
  if (!chunk || chunk.id !== ref.chunkId) throw new LadderProjectionError("Ladder question no longer matches the corpus");
  return { chunkId: chunk.id, level, spans: spansFor(level, chunk.id, chunk.text, ref.query) };
}

function validateSelection(level: VisibilityLevel, spans: readonly SourceSpan[], chunk: CorpusChunk): void {
  if ((level === "short" || level === "long") && spans.length === 0) {
    throw new LadderProjectionError("short and long selections require source spans");
  }
  if ((level === "hide" || level === "full") && spans.length !== 0) {
    throw new LadderProjectionError("hide and full selections cannot carry source spans");
  }
  let previousEnd = -1;
  for (const span of [...spans].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (span.chunkId !== chunk.id) throw new LadderProjectionError("source span references a different chunk");
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.start >= span.end || span.end > chunk.text.length) {
      throw new LadderProjectionError("source span is outside its chunk bounds");
    }
    if (span.start < previousEnd) throw new LadderProjectionError("source spans overlap");
    previousEnd = span.end;
  }
}

function renderSelection(
  selection: VisibilityProjection["selections"][number],
  chunk: CorpusChunk,
): string[] {
  if (selection.level === "hide") return [];
  if (selection.level === "full") return [chunk.text];
  const limit = selection.level === "short" ? SHORT_SPAN_CHAR_LIMIT : LONG_SPAN_CHAR_LIMIT;
  return [...selection.spans]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((span) => chunk.text.slice(span.start, Math.min(span.end, span.start + limit)));
}

function spansFor(level: VisibilityLevel, chunkId: string, text: string, query: string): readonly SourceSpan[] {
  if (level === "hide" || level === "full") return [];
  const limit = level === "short" ? SHORT_SPAN_CHAR_LIMIT : LONG_SPAN_CHAR_LIMIT;
  const normalized = text.toLocaleLowerCase();
  const start = queryTerms(query)
    .map((term) => normalized.indexOf(term))
    .find((index) => index >= 0) ?? 0;
  return [{ chunkId, start, end: Math.min(text.length, start + limit) }];
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])];
}

function lexicalScore(text: string, normalizedQuery: string, terms: readonly string[]): number {
  const normalized = text.toLocaleLowerCase();
  let score = normalizedQuery.length >= 3 && normalized.includes(normalizedQuery) ? 10_000 : 0;
  for (const term of terms) {
    if (!normalized.includes(term)) continue;
    score += 100 + Math.min(10, normalized.split(term).length - 1);
  }
  return score;
}

function ladderState(corpus: readonly CorpusChunk[], query: string, profile: LadderProfile) {
  return {
    schema: "a4s.ladder-query/v1" as const,
    query,
    profile,
    chronology: {
      direction: "oldest-to-newest" as const,
      conflictPolicy: "later sources supersede conflicting earlier sources" as const,
    },
    corpus: corpus.map((chunk, timelineIndex) => ({
      id: chunk.id,
      timelineIndex,
      position: chunk.position,
      role: chunk.role,
      text: chunk.text,
    })),
  };
}

function ladderStateTokens(corpus: readonly CorpusChunk[], query: string, profile: LadderProfile): number {
  return estimateJevTokens(JSON.stringify(ladderState(corpus, query, profile)));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

/**
 * Orders local message positions within attempts and preserves the first-seen
 * attempt sequence. Callers must supply chunks in durable branch append order.
 */
function orderedCorpus(corpus: readonly CorpusChunk[]): CorpusChunk[] {
  const attemptOrder = new Map<string, number>();
  for (const chunk of corpus) {
    if (!attemptOrder.has(chunk.provenance.compactionAttemptId)) {
      attemptOrder.set(chunk.provenance.compactionAttemptId, attemptOrder.size);
    }
  }
  return [...corpus].sort((left, right) =>
    requireAttemptOrder(attemptOrder, left.provenance.compactionAttemptId) -
      requireAttemptOrder(attemptOrder, right.provenance.compactionAttemptId) ||
    compareChunks(left, right)
  );
}

function compareChunks(left: CorpusChunk, right: CorpusChunk): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function requireAttemptOrder(order: ReadonlyMap<string, number>, attemptId: string): number {
  const index = order.get(attemptId);
  if (index === undefined) throw new LadderProjectionError(`unknown compaction attempt ${attemptId}`);
  return index;
}

function requireTimelineIndex(order: ReadonlyMap<string, number>, chunkId: string): number {
  const index = order.get(chunkId);
  if (index === undefined) throw new LadderProjectionError(`unknown corpus chunk ${chunkId}`);
  return index;
}

function isVisibilityLevel(value: string | undefined): value is VisibilityLevel {
  return value === "hide" || value === "short" || value === "long" || value === "full";
}
