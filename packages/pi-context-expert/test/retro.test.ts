import assert from "node:assert/strict";
import test from "node:test";
import {
  createRetroProposal,
  extractCurrentModelJson,
  extractRuleSignals,
  observeCompactionRules,
  parseRuleCandidatesJson,
  RetroValidationError,
  selectEvidenceContext,
  stableDigest,
  stageCorpus,
  type CurrentModelGateway,
  type JevClient,
  type JevQuestion,
  type JevRequest,
} from "../src/index.ts";
import { choiceAnswer, scoreAnswer, validJevResponse } from "./fixtures.ts";

class ValidJev implements JevClient {
  readonly requests: JevRequest[] = [];

  async evaluate(request: JevRequest): Promise<unknown> {
    this.requests.push(request);
    return validJevResponse(request, (id: string, question: JevQuestion) => {
      if (id.startsWith("ladder_visibility_") && question.type === "choice") {
        return choiceAnswer(Object.keys(question.criteria), "current");
      }
      if (id.startsWith("retro_evidence_relation_") && question.type === "choice") {
        return choiceAnswer(Object.keys(question.criteria), "direct");
      }
      if (id.startsWith("retro_authority_") && question.type === "choice") {
        return choiceAnswer(Object.keys(question.criteria), "repository_policy");
      }
      if (id.startsWith("retro_rule_class_") && question.type === "choice") {
        return choiceAnswer(Object.keys(question.criteria), "workflow");
      }
      if (
        (id.startsWith("retro_support_") ||
          id.startsWith("retro_generality_") ||
          id.startsWith("retro_enforceability_")) &&
        question.type === "score"
      ) {
        return scoreAnswer(question.criteria, question.criteria.length - 1);
      }
      return undefined;
    });
  }
}

async function signalBatch() {
  return observeCompactionRules(
    {
      messagesToSummarize: [{ role: "user", content: "Always run repository checks before completion." }],
      turnPrefixMessages: [],
    },
    { reason: "manual", willRetry: false, observedAt: "2026-09-18T13:00:00.000Z" },
    new ValidJev(),
    new AbortController().signal,
  );
}

test("current-model JSON parser accepts only the normalized candidate schema and known source refs", () => {
  const sourceRef = `sha256:${"a".repeat(64)}`;
  const valid = JSON.stringify({
    candidates: [
      {
        scope: { kind: "project", target: null },
        trigger: "before declaring work complete",
        obligation: "Run the applicable repository checks.",
        exceptions: [],
        source_refs: [sourceRef],
        proposed_check: { kind: "command", description: "Run the test command.", command: "npm test" },
      },
    ],
  });
  const parsed = parseRuleCandidatesJson(valid, new Set([sourceRef]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.sourceRefs[0], sourceRef);
  assert.equal(parsed[0]?.scope.kind, "project");

  assert.throws(
    () => parseRuleCandidatesJson(`\`\`\`json\n${valid}\n\`\`\``, new Set([sourceRef])),
    (error: unknown) => error instanceof RetroValidationError && error.code === "malformed_model_json",
  );
  assert.throws(() =>
    parseRuleCandidatesJson(
      JSON.stringify({
        candidates: [
          {
            scope: { kind: "project", target: null },
            trigger: "always",
            obligation: "Do something.",
            exceptions: [],
            source_refs: [`sha256:${"b".repeat(64)}`],
            proposed_check: { kind: "manual", description: "Review.", command: null },
            extra: true,
          },
        ],
      }),
      new Set([sourceRef]),
    ),
  );
});

test("current model envelope rejects partial completions and non-text actions", () => {
  assert.equal(
    extractCurrentModelJson({
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: '{"candidates":[]}' },
      ],
    }),
    '{"candidates":[]}',
  );
  assert.equal(
    extractCurrentModelJson({
      stopReason: "stop",
      content: [{ type: "text", text: "```json\n{\"candidates\":[]}\n```" }],
    }),
    '{"candidates":[]}',
  );
  assert.throws(() => extractCurrentModelJson({ stopReason: "length", content: [{ type: "text", text: "{}" }] }));
  assert.throws(() =>
    extractCurrentModelJson({ stopReason: "stop", content: [{ type: "toolCall", name: "write", arguments: {} }] }),
  );
});

test("retro synthesis uses the supplied current model then one stage-2 Jev evaluation", async () => {
  const batch = await signalBatch();
  const signal = batch.signals[0];
  assert.ok(signal);
  const prompts: string[] = [];
  const currentModel: CurrentModelGateway = {
    async complete(prompt, abortSignal): Promise<unknown> {
      assert.equal(abortSignal.aborted, false);
      prompts.push(prompt.userPrompt);
      return {
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              candidates: [
                {
                  scope: { kind: "project", target: null },
                  trigger: "before declaring repository work complete",
                  obligation: "Run every applicable repository check.",
                  exceptions: ["A check may be reported as deferred when its runtime is unavailable."],
                  source_refs: [signal.id],
                  proposed_check: {
                    kind: "command",
                    description: "Run the repository test command.",
                    command: "npm test",
                  },
                },
              ],
            }),
          },
        ],
      };
    },
  };
  const stageTwoJev = new ValidJev();
  const proposal = await createRetroProposal(
    [batch],
    {
      model: { provider: "fake-provider", id: "current-model" },
      createdAt: "2026-09-18T13:10:00.000Z",
    },
    currentModel,
    stageTwoJev,
    new AbortController().signal,
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", new RegExp(signal.id));
  assert.equal(stageTwoJev.requests.length, 1);
  assert.equal(Object.keys(stageTwoJev.requests[0]!.questions).length, 6);
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.candidates[0]?.evaluation.evidenceRelation, "direct");
  assert.equal(proposal.candidates[0]?.evaluation.authority, "repository_policy");
  assert.equal(proposal.candidates[0]?.evaluation.ruleClass, "workflow");
  assert.equal(proposal.candidates[0]?.evaluation.disposition, "propose");
});

test("retro consumes Evidence-selected signals as review-only proposal input", async () => {
  const chunks = stageCorpus([{
    index: 0,
    role: "user",
    text: "Always preserve deterministic validation evidence.",
    sourceDigest: stableDigest({ source: "evidence-retro" }),
    redactionCount: 0,
  }]);
  const jev = new ValidJev();
  const projection = await selectEvidenceContext(chunks, jev);
  const extracted = await extractRuleSignals({
    projection,
    corpus: chunks,
    jev,
    compactionAttemptId: stableDigest({ attempt: "evidence-retro" }),
    observedAt: "2026-09-22T13:15:00.000Z",
    reason: "manual",
    willRetry: false,
  });
  const sourceRef = extracted.signals[0]?.id;
  assert.ok(sourceRef);
  const proposal = await createRetroProposal(
    extracted.batches,
    {
      model: { provider: "fake-provider", id: "current-model" },
      createdAt: "2026-09-22T13:16:00.000Z",
    },
    {
      async complete(): Promise<unknown> {
        return {
          stopReason: "stop",
          content: [{
            type: "text",
            text: JSON.stringify({
              candidates: [{
                scope: { kind: "project", target: null },
                trigger: "before completion",
                obligation: "Preserve deterministic validation evidence.",
                exceptions: [],
                source_refs: [sourceRef],
                proposed_check: { kind: "manual", description: "Review the evidence.", command: null },
              }],
            }),
          }],
        };
      },
    },
    jev,
    new AbortController().signal,
  );

  assert.equal(proposal.schema, "a4s.rule-proposal-batch/v1");
  assert.equal(proposal.candidates[0]?.evaluation.disposition, "propose");
  assert.equal("active" in proposal, false);
});

test("retro rejects an oversized stage-2 state before calling Jev", async () => {
  const batch = await signalBatch();
  const signal = batch.signals[0];
  assert.ok(signal);
  const currentModel: CurrentModelGateway = {
    async complete(): Promise<unknown> {
      return {
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              candidates: [
                {
                  scope: { kind: "project", target: null },
                  trigger: "before completion",
                  obligation: "Run all applicable checks and preserve their evidence.",
                  exceptions: [],
                  source_refs: [signal.id],
                  proposed_check: { kind: "manual", description: "Review the recorded checks.", command: null },
                },
              ],
            }),
          },
        ],
      };
    },
  };
  const stageTwoJev = new ValidJev();

  await assert.rejects(
    createRetroProposal(
      [batch],
      {
        model: { provider: "fake-provider", id: "current-model" },
        createdAt: "2026-09-18T13:20:00.000Z",
      },
      currentModel,
      stageTwoJev,
      new AbortController().signal,
      { maxStageTwoStateChars: 100 },
    ),
    (error: unknown) =>
      error instanceof RetroValidationError &&
      error.code === "oversized_state" &&
      error.path === "$.stageTwo.state",
  );
  assert.equal(stageTwoJev.requests.length, 0);
});
