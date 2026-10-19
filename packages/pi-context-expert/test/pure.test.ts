import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuleObservationPlan,
  canProvideRuleAuthority,
  DEFAULT_JEV_MODEL,
  estimateJevTokens,
  fitWholeSessionState,
  normalizeCompactionMessages,
  normalizeSessionMessages,
  parseScoreAnswer,
  prepareRuleObservations,
  redactPrivateData,
  stableDigest,
  StateFitError,
} from "../src/index.ts";

test("normalization redacts private values, omits thinking, and ignores timestamps", () => {
  const messages = normalizeSessionMessages([
    {
      role: "user",
      content:
        'Authorization: Bearer top-secret-token\napi_key="supersecret"\n<private>customer 42</private> alice@example.com /Users/alice/project',
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Keep tests deterministic." },
      ],
      timestamp: 2,
    },
  ]);

  assert.equal(messages.length, 2);
  const user = messages[0];
  const assistant = messages[1];
  assert.ok(user);
  assert.ok(assistant);
  assert.doesNotMatch(user.text, /top-secret-token|supersecret|customer 42|alice@example\.com|\/Users\/alice/);
  assert.match(user.text, /REDACTED/);
  assert.ok(user.redactionCount >= 5);
  assert.equal(assistant.text, "Keep tests deterministic.");
  assert.doesNotMatch(assistant.text, /private reasoning/);

  const sameWithoutTimestamps = normalizeSessionMessages([
    { role: "user", content: user.text, timestamp: 99 },
    { role: "assistant", content: [{ type: "text", text: assistant.text }], timestamp: 100 },
  ]);
  assert.equal(messages[1]?.sourceDigest, sameWithoutTimestamps[1]?.sourceDigest);
});

test("tool argument normalization and stable digests ignore object key insertion order", () => {
  const first = normalizeSessionMessages([
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "write", arguments: { z: 1, a: "value" } }],
    },
  ]);
  const second = normalizeSessionMessages([
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "write", arguments: { a: "value", z: 1 } }],
    },
  ]);

  assert.equal(first[0]?.text, second[0]?.text);
  assert.equal(first[0]?.sourceDigest, second[0]?.sourceDigest);
  assert.equal(stableDigest({ z: 1, a: 2 }), stableDigest({ a: 2, z: 1 }));
});

test("whole-session fitting preserves every message and fails rather than dropping an oversized envelope", () => {
  const normalized = normalizeCompactionMessages({
    previousSummary: "Earlier decision",
    messagesToSummarize: [
      { role: "user", content: "A".repeat(2_000) },
      { role: "assistant", content: [{ type: "text", text: "B".repeat(2_000) }] },
    ],
    turnPrefixMessages: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "C".repeat(2_000) }] }],
  });
  const fitted = fitWholeSessionState(normalized, {
    maxStateTokens: 500,
    maxExcerptChars: 1_000,
    minimumExcerptChars: 24,
  });

  assert.equal(fitted.messages.length, normalized.length);
  assert.deepEqual(
    fitted.messages.map((message) => message.sourceDigest),
    normalized.map((message) => message.sourceDigest),
  );
  assert.ok(estimateJevTokens(JSON.stringify(fitted.state)) <= 500);
  assert.ok(fitted.messages.every((message) => message.excerpt.length > 0));

  assert.throws(
    () =>
      fitWholeSessionState(normalized, {
        maxStateTokens: 1,
        maxExcerptChars: 24,
        minimumExcerptChars: 24,
      }),
    (error: unknown) => error instanceof StateFitError && error.code === "oversized_state",
  );
});

test("question batching keeps candidate triplets together and repeats the identical fitted state", () => {
  const normalized = normalizeSessionMessages([
    { role: "user", content: "Always run tests." },
    { role: "assistant", content: [{ type: "text", text: "I will run tests." }] },
    { role: "user", content: "Never expose credentials." },
  ]);
  const fitted = fitWholeSessionState(normalized);
  const plan = buildRuleObservationPlan(fitted, { maxQuestionsPerRequest: 5 });

  assert.equal(plan.requests.length, 3);
  assert.ok(plan.requests.every((request) => request.state === plan.requests[0]?.state));
  assert.ok(plan.requests.every((request) => request.model === DEFAULT_JEV_MODEL));
  assert.deepEqual(plan.requests.map((request) => Object.keys(request.questions).length), [5, 2, 5]);
  for (const candidate of plan.candidates) {
    const containing = plan.requests.filter((request) => candidate.questionIds.candidate in request.questions);
    assert.equal(containing.length, 1);
    assert.ok(candidate.questionIds.generality in containing[0]!.questions);
    assert.ok(candidate.questionIds.authority in containing[0]!.questions);
    const compaction = plan.compactionMessages.find(
      (message) => message.sourceMessageIndex === candidate.sourceMessageIndex,
    );
    assert.ok(compaction);
    assert.ok(compaction.questionIds.action in containing[0]!.questions);
    assert.ok(compaction.questionIds.continuity in containing[0]!.questions);
  }
});

test("1000-message planning preserves retention coverage and verified Jev budgets", () => {
  const roles = [
    "user",
    "assistant",
    "toolResult",
    "bashExecution",
    "custom",
    "branchSummary",
    "compactionSummary",
  ] as const;
  const messages = Array.from({ length: 1_000 }, (_, index) => {
    const role = roles[index % roles.length]!;
    const text = `Message ${index}: always preserve an explicit rule candidate when its scope matches.`;
    if (role === "toolResult") return { role, toolName: "read", content: [{ type: "text", text }] };
    if (role === "bashExecution") return { role, command: "printf evidence", output: text, exitCode: 0 };
    if (role === "branchSummary" || role === "compactionSummary") return { role, summary: text };
    return { role, content: text };
  });
  const plans = prepareRuleObservations({ messagesToSummarize: messages, turnPrefixMessages: [] });
  const actionQuestionIds = plans.flatMap((plan) =>
    plan.requests.flatMap((request) =>
      Object.keys(request.questions).filter((id) => id.startsWith("compaction_action_")),
    ),
  );
  const eligibleMessages = messages.filter((message) => canProvideRuleAuthority(message.role)).length;

  assert.equal(plans.length, 11);
  assert.equal(plans.reduce((total, plan) => total + plan.compactionMessages.length, 0), 1_000);
  assert.equal(actionQuestionIds.length, 1_000);
  assert.equal(new Set(actionQuestionIds).size, 1_000);
  assert.equal(plans.reduce((total, plan) => total + plan.candidates.length, 0), eligibleMessages);
  assert.ok(plans.every((plan) => plan.requests.length > 0));
  assert.ok(plans.every((plan) => plan.requests.every((request) => request.state === plan.requests[0]?.state)));
  for (const plan of plans) {
    const stateTokens = estimateJevTokens(JSON.stringify(plan.state.state));
    for (const request of plan.requests) {
      assert.ok(Object.keys(request.questions).length <= 120);
      assert.ok(estimateJevTokens(JSON.stringify(request)) <= 60_000);
      const longestQuestion = Math.max(
        ...Object.values(request.questions).map((question) => estimateJevTokens(JSON.stringify(question))),
      );
      assert.ok(stateTokens + longestQuestion <= 30_000);
    }
  }
});

test("Pi-normalized Score parsing validates bounds and exact fields", () => {
  const criteria = ["low", "medium", "high"];
  const parsed = parseScoreAnswer({ type: "score", score: 0.8, confidence: 0.7 }, criteria);
  assert.deepEqual(parsed, { type: "score", score: 0.8, confidence: 0.7 });

  assert.throws(() =>
    parseScoreAnswer({ type: "score", score: 1.2, confidence: 0.7 }, criteria),
  );
  assert.throws(() =>
    parseScoreAnswer({ type: "score", score: 0.8, confidence: 0.7, extra: true }, criteria),
  );
  assert.throws(() =>
    parseScoreAnswer({ type: "score", score: 0.8, confidence: 0.7 }, ["only"]),
  );
});

test("redaction handles credential forms without retaining raw values", () => {
  const raw = [
    "password=hunter2",
    "https://alice:swordfish@example.com/path",
    "sk-abcdefghijklmnop",
    "eyJabcdefgh.abcdefgh.abcdefgh",
  ].join("\n");
  const result = redactPrivateData(raw);
  assert.equal(result.redactionCount, 4);
  assert.doesNotMatch(result.text, /hunter2|alice:swordfish|sk-abcdefghijklmnop|eyJabcdefgh/);
});
