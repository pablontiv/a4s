import { stableDigest } from "./digest.ts";
import { validateJevResponse } from "./jev.ts";
import { buildLadderQuestions, type LadderQuestionRef } from "./questions.ts";
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

export class LadderProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LadderProjectionError";
  }
}

/** Stable corpus identity independent of durable-entry append order. */
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

/** Renders only validated source text, ordered by corpus position and source offset. */
export function renderProjection(
  projection: VisibilityProjection,
  corpus: readonly CorpusChunk[],
): string {
  validateProjection(projection, corpus);
  const chunks = new Map(corpus.map((chunk) => [chunk.id, chunk]));
  const rendered = [...projection.selections]
    .sort((left, right) => compareChunks(requireChunk(chunks, left.chunkId), requireChunk(chunks, right.chunkId)))
    .flatMap((selection) => renderSelection(selection, requireChunk(chunks, selection.chunkId)))
    .filter((text) => text.length > 0);
  return rendered.length === 0 ? "" : `[a4s ladder context]\n${rendered.join("\n")}`;
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
): Promise<VisibilityProjection> {
  if (query.trim().length === 0) throw new LadderProjectionError("a concrete non-empty query is required");
  const ordered = orderedCorpus(corpus);
  if (ordered.length === 0) {
    return { queryDigest: stableDigest(query), corpusDigest: corpusDigest(corpus), selections: [] };
  }

  const { questions, refs } = buildLadderQuestions(ordered, query);
  const request = {
    state: {
      schema: "a4s.ladder-query/v1",
      query,
      corpus: ordered.map((chunk) => ({ id: chunk.id, position: chunk.position, role: chunk.role, text: chunk.text })),
    },
    model: DEFAULT_JEV_MODEL,
    questions,
  } as const;
  const response = validateJevResponse(await jevClient.evaluate(request, { signal }), questions);
  const selections = refs.map((ref) => {
    const answer = response.answers[ref.questionId];
    if (!answer || answer.type !== "choice") throw new LadderProjectionError("Jev returned an invalid Ladder answer");
    return selectionFromAnswer(ref, ordered, answer.choice);
  });
  const projection: VisibilityProjection = {
    queryDigest: stableDigest(query),
    corpusDigest: corpusDigest(corpus),
    selections,
  };
  validateProjection(projection, corpus);
  return projection;
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

function orderedCorpus(corpus: readonly CorpusChunk[]): CorpusChunk[] {
  return [...corpus].sort(compareChunks);
}

function compareChunks(left: CorpusChunk, right: CorpusChunk): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function requireChunk(chunks: ReadonlyMap<string, CorpusChunk>, id: string): CorpusChunk {
  const chunk = chunks.get(id);
  if (!chunk) throw new LadderProjectionError("projection selected an unknown corpus chunk");
  return chunk;
}

function isVisibilityLevel(value: string | undefined): value is VisibilityLevel {
  return value === "hide" || value === "short" || value === "long" || value === "full";
}
