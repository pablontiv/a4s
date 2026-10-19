import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_JEV_MODEL,
  observeCompactionRules,
  observePreparedCompactionRules,
  parseRuleSignalBatch,
  prepareRuleObservation,
  stableDigest,
  type JevClient,
  type JevQuestion,
  type JevRequest,
  type RuleObservationPlan,
} from "../src/index.ts";
import { choiceAnswer, scoreAnswer, validJevResponse } from "./fixtures.ts";

class RecordingJev implements JevClient {
  readonly requests: JevRequest[] = [];

  async evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown> {
    assert.equal(options.signal.aborted, false);
    this.requests.push(request);
    return validJevResponse(request, (id: string, question: JevQuestion) => {
      if (question.type === "noul" && id.endsWith("000000")) return { type: "noul", noul: 0.71 };
      return undefined;
    });
  }
}

function observationContext(plan: RuleObservationPlan) {
  return {
    attemptId: stableDigest({ attempt: plan.state.sourceDigest }),
    reason: "threshold" as const,
    willRetry: false,
    observedAt: "2026-09-18T09:59:00.000Z",
    windowIndex: 0,
    windowCount: 1,
    pins: { boundary: new Set<number>(), newest: new Set<number>() },
  };
}

test("independent Jev batches run concurrently against the same fitted state", async () => {
  const plan = prepareRuleObservation(
    {
      messagesToSummarize: Array.from({ length: 4 }, (_, index) => ({
        role: "user",
        content: `Rule candidate ${index}`,
      })),
      turnPrefixMessages: [],
    },
    { maxQuestionsPerRequest: 5 },
  );
  assert.ok(plan.requests.length > 1);

  let started = 0;
  const releases: Array<() => void> = [];
  const jev: JevClient = {
    async evaluate(request, options) {
      assert.equal(options.signal.aborted, false);
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return validJevResponse(request);
    },
  };

  const pending = observePreparedCompactionRules(
    plan,
    observationContext(plan),
    jev,
    new AbortController().signal,
    { maxQuestionsPerRequest: 5 },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, plan.requests.length);
  for (const release of releases) release();
  const batch = await pending;
  assert.equal(batch.provenance.requestCount, plan.requests.length);
});

test("RuleSignal selection uses independent configurable thresholds and Pi's latest Jev selector", async () => {
  const jev = new RecordingJev();
  const controller = new AbortController();
  const batch = await observeCompactionRules(
    {
      messagesToSummarize: [
        { role: "user", content: "One transient action." },
        { role: "user", content: "Always run the applicable checks before completion." },
      ],
      turnPrefixMessages: [],
    },
    { reason: "threshold", willRetry: false, observedAt: "2026-09-18T10:00:00.000Z" },
    jev,
    controller.signal,
  );

  assert.ok(jev.requests.length > 0);
  assert.ok(jev.requests.every((request) => request.model === DEFAULT_JEV_MODEL));
  assert.equal(batch.schema, "a4s.rule-signal-batch/v2");
  assert.equal(batch.compaction.schema, "a4s.compaction-window-observation/v1");
  assert.equal(batch.signals.length, 1);
  assert.equal(batch.signals[0]?.sourceMessageIndex, 1);
  assert.equal(batch.ruleThresholds.candidateProbabilityMinimum, 0.72);
  assert.equal(batch.provenance.requestCount, jev.requests.length);

  const relaxed = await observeCompactionRules(
    {
      messagesToSummarize: [
        { role: "user", content: "One transient action." },
        { role: "user", content: "Always run the applicable checks before completion." },
      ],
      turnPrefixMessages: [],
    },
    { reason: "manual", willRetry: false, observedAt: "2026-09-18T10:01:00.000Z" },
    new RecordingJev(),
    controller.signal,
    {
      ruleThresholds: {
        candidateProbabilityMinimum: 0.7,
        generalityMinimum: 0.5,
        authorityProbabilityMinimum: 0.5,
        authorityConfidenceMinimum: 0,
        allowedAuthorities: ["explicit_user"],
      },
    },
  );
  assert.equal(relaxed.signals.length, 2);
});

test("thinking-only messages persist a deterministic non-empty retention marker", async () => {
  const batch = await observeCompactionRules(
    {
      messagesToSummarize: [{ role: "assistant", content: [{ type: "thinking", thinking: "omitted" }] }],
      turnPrefixMessages: [],
    },
    { reason: "manual", willRetry: false, observedAt: "2026-09-18T10:02:00.000Z" },
    new RecordingJev(),
    new AbortController().signal,
  );

  assert.equal(batch.signals.length, 0);
  assert.equal(batch.compaction.decisions[0]?.action, "keep");
  assert.equal(batch.compaction.decisions[0]?.selectedExcerpt, "[empty sanitized message]");
  assert.deepEqual(parseRuleSignalBatch(batch), batch);
});

test("compaction selects keep, truncate, and drop while a durable rule forces keep", async () => {
  const plan = prepareRuleObservation({
    messagesToSummarize: [
      { role: "assistant", content: "Keep this detailed state." },
      { role: "assistant", content: "This only needs a short gist. ".repeat(30) },
      { role: "user", content: "Always preserve accepted safety constraints." },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "redundant output" }] },
    ],
    turnPrefixMessages: [],
  });
  const jev: JevClient = {
    async evaluate(request) {
      return validJevResponse(request, (id, question) => {
        if (id.startsWith("compaction_action_") && question.type === "choice") {
          const sourceIndex = Number(id.slice(-6));
          const selected = sourceIndex === 0 ? "keep" : sourceIndex === 1 ? "truncate" : "drop";
          return choiceAnswer(Object.keys(question.criteria), selected);
        }
        if (id.startsWith("compaction_continuity_") && question.type === "score") {
          return scoreAnswer(question.criteria, 0);
        }
        if (id.startsWith("rule_candidate_") && question.type === "noul") {
          return { type: "noul", noul: id.endsWith("000002") ? 0.99 : 0.1 };
        }
        return undefined;
      });
    },
  };
  const batch = await observePreparedCompactionRules(
    plan,
    observationContext(plan),
    jev,
    new AbortController().signal,
  );

  assert.deepEqual(batch.compaction.decisions.map((decision) => decision.action), ["keep", "truncate", "keep", "drop"]);
  assert.deepEqual(batch.compaction.decisions[2]?.forcedBy, ["rule_candidate"]);
  assert.ok((batch.compaction.decisions[1]?.selectedExcerpt.length ?? 0) <= 240);
  assert.equal(batch.compaction.decisions[3]?.selectedExcerpt, "");
});
