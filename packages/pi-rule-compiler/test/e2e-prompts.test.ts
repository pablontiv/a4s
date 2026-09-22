import assert from "node:assert/strict";
import test from "node:test";
import {
  CONSERVATIVE_PROMPT_CONTENT_TOKEN_FLOOR,
  createCompactionE2ePrompts,
  createEvidenceE2ePrompts,
  estimatePiContentTokens,
  PRODUCTION_KEEP_RECENT_TOKENS,
} from "../scripts/e2e-prompts.ts";

const PRIOR_BRIEF_PROMPTS = new Set([
  "Reply with the single word ready.",
  "Reply with the single word acknowledged.",
]);

test("generates four distinct run-scoped benign prompts above the conservative content floor", () => {
  const runId = "offline-run-scope";
  const prompts = createCompactionE2ePrompts(runId);

  const otherRunPrompts = createCompactionE2ePrompts("another-offline-run-scope");

  assert.equal(prompts.length, 4);
  assert.equal(new Set(prompts).size, 4);
  assert.ok(prompts.every((prompt) => prompt.includes(runId)));
  assert.equal(prompts.some((prompt) => otherRunPrompts.includes(prompt)), false);
  assert.ok(prompts.every((prompt) => !PRIOR_BRIEF_PROMPTS.has(prompt)));
  assert.ok(prompts.every((prompt) => !prompt.includes("Reply with the single word")));
  assert.ok(prompts.every((prompt) => prompt.includes("benign synthetic compaction input")));
  assert.ok(CONSERVATIVE_PROMPT_CONTENT_TOKEN_FLOOR > PRODUCTION_KEEP_RECENT_TOKENS);
  assert.ok(
    prompts.reduce((total, prompt) => total + estimatePiContentTokens(prompt), 0)
      > CONSERVATIVE_PROMPT_CONTENT_TOKEN_FLOOR,
  );
});

test("generates compactable Evidence prompts with an explicit benign durable rule", () => {
  const runId = "offline-evidence-run-scope";
  const prompts = createEvidenceE2ePrompts(runId);

  assert.equal(prompts.length, 4);
  assert.equal(new Set(prompts).size, 4);
  assert.ok(prompts.every((prompt) => prompt.includes(runId)));
  assert.ok(prompts.every((prompt) => /durable repository policy/i.test(prompt)));
  assert.ok(prompts.every((prompt) => /deterministic tests before completion/i.test(prompt)));
  assert.ok(
    prompts.reduce((total, prompt) => total + estimatePiContentTokens(prompt), 0)
      > CONSERVATIVE_PROMPT_CONTENT_TOKEN_FLOOR,
  );
});
