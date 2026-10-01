import assert from "node:assert/strict";
import test from "node:test";
import {
  applyContextProjection,
  corpusDigest,
  LadderShortlistError,
  renderProjection,
  selectLadderProjection,
  shortlistLadderCorpus,
  validateProjection,
  type VisibilityProjection,
} from "../src/index.ts";
import type { CorpusChunk, JevRequest } from "../src/types.ts";
import { validJevResponse } from "./fixtures.ts";

const corpus: readonly CorpusChunk[] = [
  chunk("chunk-late", 20, "abcdefghij"),
  chunk("chunk-first", 10, "klmnopqrst"),
  chunk("chunk-hidden", 30, "uvwxyz"),
  chunk("chunk-full", 25, "0123456789"),
];

function chunk(id: string, position: number, text: string): CorpusChunk {
  return {
    schema: "a4s.corpus-chunk/v1",
    id,
    digest: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
    role: "user",
    position,
    text,
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt",
      sourceDigest: "sha256:source",
    },
  };
}

function validProjection(): VisibilityProjection {
  return {
    queryDigest: "sha256:query",
    corpusDigest: corpusDigest(corpus),
    selections: [
      { chunkId: "chunk-late", level: "short", spans: [{ chunkId: "chunk-late", start: 2, end: 5 }] },
      { chunkId: "chunk-first", level: "long", spans: [{ chunkId: "chunk-first", start: 0, end: 6 }] },
      { chunkId: "chunk-hidden", level: "hide", spans: [] },
      { chunkId: "chunk-full", level: "full", spans: [] },
    ],
  };
}

test("renderer orders valid short and long source spans deterministically", () => {
  const projection = validProjection();
  validateProjection(projection, corpus);

  assert.equal(
    renderProjection(projection, corpus),
    [
      "[a4s ladder context]",
      "Selected historical source excerpts are ordered oldest to newest.",
      "Later source excerpts supersede conflicting earlier excerpts. Mutable repository state must be verified against the current checkout.",
      "[source 1/3 | role=user]",
      "klmnop",
      "[source 2/3 | role=user]",
      "cde",
      "[source 3/3 | role=user]",
      "0123456789",
    ].join("\n"),
  );
  assert.deepEqual(corpus.map((item) => item.text), ["abcdefghij", "klmnopqrst", "uvwxyz", "0123456789"]);
});

test("unknown chunk ids and invalid spans reject the projection", () => {
  const invalidProjections: VisibilityProjection[] = [
    { ...validProjection(), selections: [{ chunkId: "missing", level: "full", spans: [] }] },
    { ...validProjection(), selections: [{ chunkId: "chunk-late", level: "short", spans: [] }] },
    {
      ...validProjection(),
      selections: [{ chunkId: "chunk-late", level: "long", spans: [{ chunkId: "chunk-late", start: 0, end: 11 }] }],
    },
    {
      ...validProjection(),
      selections: [{ chunkId: "chunk-late", level: "short", spans: [{ chunkId: "chunk-full", start: 0, end: 1 }] }],
    },
    {
      ...validProjection(),
      selections: [{ chunkId: "chunk-late", level: "long", spans: [{ chunkId: "chunk-late", start: 1, end: 4 }, { chunkId: "chunk-late", start: 3, end: 5 }] }],
    },
  ];

  for (const projection of invalidProjections) {
    assert.throws(() => validateProjection(projection, corpus));
  }
});

test("Ladder selection sends a concrete query and returns a validated projection", async () => {
  const requests: JevRequest[] = [];
  const projection = await selectLadderProjection(
    [corpus[0]!],
    "find cde",
    {
      async evaluate(request) {
        requests.push(request);
        return validJevResponse(request, (_id, question) =>
          question.type === "choice"
            ? {
              type: "choice",
              choice: "short",
              probabilities: { hide: 0, short: 1, long: 0, full: 0 },
              confidence: 1,
            }
            : undefined,
        );
      },
    },
    new AbortController().signal,
  );

  assert.equal(requests.length, 1);
  assert.equal((requests[0]?.state as { query?: unknown }).query, "find cde");
  assert.deepEqual(projection.selections, [
    { chunkId: "chunk-late", level: "short", spans: [{ chunkId: "chunk-late", start: 2, end: 10 }] },
  ]);
  validateProjection(projection, [corpus[0]!]);
});

test("Ladder request exposes chronology and supersession to Jev", async () => {
  const historical = {
    ...chunk("historical-server", 99, "dolt_mode server on port 3308"),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-old",
      sourceDigest: "sha256:source-old",
    },
  };
  const current = {
    ...chunk("current-embedded", 0, "dolt_mode embedded with no listener"),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-new",
      sourceDigest: "sha256:source-new",
    },
  };
  const requests: JevRequest[] = [];

  await selectLadderProjection(
    [historical, current],
    "what is the current dolt mode?",
    {
      async evaluate(request) {
        requests.push(request);
        return validJevResponse(request, (id, question) =>
          question.type === "choice"
            ? {
              type: "choice",
              choice: id.endsWith("000000") ? "hide" : "full",
              probabilities: id.endsWith("000000")
                ? { hide: 1, short: 0, long: 0, full: 0 }
                : { hide: 0, short: 0, long: 0, full: 1 },
              confidence: 1,
            }
            : undefined,
        );
      },
    },
    new AbortController().signal,
  );

  const request = requests[0];
  assert.ok(request);
  const state = request.state as {
    chronology?: { direction?: unknown; conflictPolicy?: unknown };
    corpus?: Array<{ id?: unknown; timelineIndex?: unknown }>;
  };
  assert.deepEqual(state.chronology, {
    direction: "oldest-to-newest",
    conflictPolicy: "later sources supersede conflicting earlier sources",
  });
  assert.deepEqual(state.corpus?.map(({ id, timelineIndex }) => ({ id, timelineIndex })), [
    { id: "historical-server", timelineIndex: 0 },
    { id: "current-embedded", timelineIndex: 1 },
  ]);
  const firstQuestion = request.questions.ladder_visibility_000000;
  assert.equal(firstQuestion?.type, "choice");
  const hideCriteria = firstQuestion?.type === "choice" ? firstQuestion.criteria.hide : undefined;
  assert.equal(typeof hideCriteria, "string");
  if (typeof hideCriteria !== "string") throw new TypeError("missing Ladder hide criterion");
  assert.match(hideCriteria, /superseded/i);
});

test("Ladder shortlist deterministically bounds large corpora while retaining lexical and recent candidates", () => {
  const largeCorpus = Array.from({ length: 160 }, (_, index) => chunk(
    `chunk-${String(index).padStart(3, "0")}`,
    index,
    index === 5
      ? `rare migration needle ${"a".repeat(1_000)}`
      : `routine historical material ${index} ${"b".repeat(1_000)}`,
  ));

  const first = shortlistLadderCorpus(largeCorpus, "rare migration needle", "ordinary", {
    maxCandidateChunks: 16,
    recentChunks: 4,
    maxStateTokens: 5_000,
  });
  const second = shortlistLadderCorpus(largeCorpus, "rare migration needle", "ordinary", {
    maxCandidateChunks: 16,
    recentChunks: 4,
    maxStateTokens: 5_000,
  });
  const selectedIds = first.corpus.map((item) => item.id);

  assert.equal(first.strategy, "lexical-recency");
  assert.equal(first.sourceChunks, 160);
  assert.ok(first.corpus.length <= 16);
  assert.ok(first.estimatedStateTokens <= 5_000);
  assert.ok(selectedIds.includes("chunk-005"));
  assert.ok(selectedIds.includes("chunk-159"));
  assert.deepEqual(second, first);
  assert.throws(
    () => shortlistLadderCorpus([largeCorpus[0]!], "rare migration needle", "ordinary", {
      maxStateTokens: 1,
    }),
    LadderShortlistError,
  );
});

test("Ladder recency follows compaction chronology instead of reset message positions", () => {
  const historical = {
    ...chunk("historical-server", 99, "dolt_mode server on port 3308"),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-old",
      sourceDigest: "sha256:source-old",
    },
  };
  const current = {
    ...chunk("current-embedded", 0, "dolt_mode embedded with no listener"),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-new",
      sourceDigest: "sha256:source-new",
    },
  };

  const result = shortlistLadderCorpus(
    [historical, current],
    "unrelated query",
    "ordinary",
    { maxCandidateChunks: 1, recentChunks: 1, maxStateTokens: 5_000 },
  );

  assert.deepEqual(result.corpus.map((item) => item.id), ["current-embedded"]);
});

test("bounded Ladder preserves compaction chronology through selection and rendering", async () => {
  const historical = [0, 1, 2].map((position) => ({
    ...chunk(`z-old-${position}`, position, `dolt_mode server on port 3308 old-${position}`),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-old",
      sourceDigest: `sha256:source-old-${position}`,
    },
  }));
  const current = [0, 1].map((position) => ({
    ...chunk(`a-new-${position}`, position, `dolt_mode embedded with no listener new-${position}`),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-new",
      sourceDigest: `sha256:source-new-${position}`,
    },
  }));
  const shortlist = shortlistLadderCorpus(
    [...historical, ...current],
    "current dolt_mode",
    "ordinary",
    { maxCandidateChunks: 4, recentChunks: 1, maxStateTokens: 5_000 },
  );

  assert.equal(shortlist.strategy, "lexical-recency");
  assert.deepEqual(
    shortlist.corpus.map((item) => item.provenance.compactionAttemptId),
    ["sha256:attempt-old", "sha256:attempt-old", "sha256:attempt-new", "sha256:attempt-new"],
  );

  const projection = await selectLadderProjection(
    shortlist.corpus,
    "current dolt_mode",
    {
      async evaluate(request) {
        return validJevResponse(request, (_id, question) =>
          question.type === "choice"
            ? {
              type: "choice",
              choice: "full",
              probabilities: { hide: 0, short: 0, long: 0, full: 1 },
              confidence: 1,
            }
            : undefined,
        );
      },
    },
    new AbortController().signal,
  );
  const rendered = renderProjection(projection, shortlist.corpus);
  assert.ok(rendered.indexOf("dolt_mode server") < rendered.indexOf("dolt_mode embedded"));
});

test("Ladder renderer frames selected sources with chronological precedence", () => {
  const historical = {
    ...chunk("historical-server", 99, "dolt_mode server on port 3308"),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-old",
      sourceDigest: "sha256:source-old",
    },
  };
  const current = {
    ...chunk("current-embedded", 0, "dolt_mode embedded with no listener"),
    provenance: {
      branchId: "sha256:branch",
      compactionAttemptId: "sha256:attempt-new",
      sourceDigest: "sha256:source-new",
    },
  };
  const timeline = [historical, current];
  const rendered = renderProjection({
    queryDigest: "sha256:query",
    corpusDigest: corpusDigest(timeline),
    selections: [
      { chunkId: current.id, level: "full", spans: [] },
      { chunkId: historical.id, level: "full", spans: [] },
    ],
  }, timeline);

  assert.match(rendered, /Later source excerpts supersede conflicting earlier excerpts/);
  assert.ok(rendered.indexOf(historical.text) < rendered.indexOf(current.text));
  assert.match(rendered, /source 1\/2.*role=user/);
  assert.match(rendered, /source 2\/2.*role=user/);
});

test("failed Ladder leaves context_with_system unchanged", async () => {
  const context = { messages: [{ role: "system", content: "Pi normal", timestamp: 0 }] };
  const result = await applyContextProjection(context, async () => {
    throw new Error("Jev unavailable");
  });

  assert.equal(result, context);
  assert.equal(result.messages[0]?.content, "Pi normal");
});
