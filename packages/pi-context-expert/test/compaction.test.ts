import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBasicCompactionResult,
  buildJevCompactionResult,
  CompactionBuildError,
  observePreparedCompactionRules,
  prepareRuleObservation,
  recoverRuleSignalBatchesFromDetails,
  stableDigest,
  type JevClient,
} from "../src/index.ts";
import { choiceAnswer, scoreAnswer, validJevResponse } from "./fixtures.ts";

test("historical pinned-model compaction details remain readable after native Jev migration", () => {
  const attemptId = stableDigest({ test: "historical-native-migration" });
  const sourceDigest = stableDigest({ source: "historical-native-migration" });
  assert.deepEqual(recoverRuleSignalBatchesFromDetails({
    schema: "a4s.jev-compaction-details/v1",
    attemptId,
    sourceDigest,
    jevModel: "jev-1.13.0",
    ruleSignalBatches: [],
  }), { attemptId, sourceDigest, batches: [] });
});

test("basic preserves the established deterministic compaction fixture", async () => {
  const plan = prepareRuleObservation({
    messagesToSummarize: [
      { role: "user", content: `MARKER-0 ${"alpha ".repeat(120)}` },
      { role: "assistant", content: "MARKER-1 should be dropped" },
      { role: "assistant", content: `MARKER-2 ${"beta ".repeat(120)}` },
      { role: "user", content: `MARKER-3 ${"gamma ".repeat(120)}` },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "MARKER-4 drop" }] },
    ],
    turnPrefixMessages: [],
  });
  const attemptId = stableDigest({ test: "compaction" });
  const jev: JevClient = {
    async evaluate(request) {
      return validJevResponse(request, (id, question) => {
        if (id.startsWith("compaction_action_") && question.type === "choice") {
          const index = Number(id.slice(-6));
          const selected = index === 0 || index === 3 ? "keep" : index === 2 ? "truncate" : "drop";
          return choiceAnswer(Object.keys(question.criteria), selected);
        }
        if (id.startsWith("compaction_continuity_") && question.type === "score") {
          return scoreAnswer(question.criteria, 0);
        }
        if (id.startsWith("rule_candidate_") && question.type === "noul") {
          return { type: "noul", noul: 0.1 };
        }
        return undefined;
      });
    },
  };
  const batch = await observePreparedCompactionRules(
    plan,
    {
      attemptId,
      reason: "manual",
      willRetry: false,
      observedAt: "2026-09-18T15:00:00.000Z",
      windowIndex: 0,
      windowCount: 1,
      pins: { boundary: new Set(), newest: new Set() },
    },
    jev,
    new AbortController().signal,
  );
  const input = {
    attemptId,
    sourceDigest: stableDigest({ source: "all" }),
    createdAt: "2026-09-18T15:00:00.000Z",
    firstKeptEntryId: "entry-kept",
    tokensBefore: 42_000,
    messageCount: 5,
    scheduler: {
      maxConcurrency: 1,
      maxRetries: 3,
      logicalRequests: plan.requests.length,
      attempts: plan.requests.length,
      retries: 0,
      maxObservedConcurrency: 1,
    },
    ruleSignalBatches: [batch],
  };
  const before = buildJevCompactionResult(input, { maxSummaryChars: 900, minimumSummaryExcerptChars: 24 });
  const first = buildBasicCompactionResult(
    {
      attemptId: input.attemptId,
      sourceDigest: input.sourceDigest,
      createdAt: input.createdAt,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      decisions: input.ruleSignalBatches.flatMap((ruleSignalBatch) => ruleSignalBatch.compaction.decisions),
      scheduler: input.scheduler,
    },
    { maxSummaryChars: 900, minimumSummaryExcerptChars: 24 },
  );
  const second = buildBasicCompactionResult(
    {
      attemptId: input.attemptId,
      sourceDigest: input.sourceDigest,
      createdAt: input.createdAt,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      decisions: input.ruleSignalBatches.flatMap((ruleSignalBatch) => ruleSignalBatch.compaction.decisions),
      scheduler: input.scheduler,
    },
    { maxSummaryChars: 900, minimumSummaryExcerptChars: 24 },
  );

  assert.deepEqual(first, before, "basic preserves the established deterministic compaction fixture");
  assert.equal(first.summary, second.summary);
  assert.equal(first.details.summary.digest, second.details.summary.digest);
  assert.equal(first.firstKeptEntryId, "entry-kept");
  assert.equal(first.tokensBefore, 42_000);
  assert.ok(first.summary.length <= 900);
  assert.doesNotMatch(first.summary, /MARKER-1|MARKER-4/);
  const marker0 = first.summary.indexOf("MARKER-0");
  const marker2 = first.summary.indexOf("MARKER-2");
  const marker3 = first.summary.indexOf("MARKER-3");
  assert.ok(marker0 >= 0 && marker0 < marker2 && marker2 < marker3);
  if (!("schema" in first.details)) assert.fail("expected legacy details");
  assert.deepEqual(first.details.decisions.map((decision) => decision.sourceMessageIndex), [0, 1, 2, 3, 4]);
  assert.equal(first.details.schema, "a4s.jev-compaction-details/v1");
  assert.ok(first.details.summary.budgetTruncatedMessages > 0);
  assert.match(first.summary, /…\[truncated\]…/);
  assert.equal(first.details.ruleSignalBatches.length, 0);

  assert.throws(
    () => buildJevCompactionResult(input, { maxSummaryChars: 50, minimumSummaryExcerptChars: 24 }),
    (error: unknown) => error instanceof CompactionBuildError && error.code === "oversized_summary",
  );
});
