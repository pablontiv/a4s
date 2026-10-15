import assert from "node:assert/strict";
import { test } from "node:test";
import crossFamilyReview from "../src/index.ts";
import { orderReviewModels } from "../src/order.ts";
import type { Model, Models, ReviewModels } from "../src/order.ts";

const opus = { provider: "anthropic", id: "opus" };
const sonnet = { provider: "anthropic", id: "sonnet" };
const gpt = { provider: "openai", id: "gpt" };
const gemini = { provider: "google", id: "gemini" };
const specs: Record<string, Model> = {
  opus, sonnet, gpt, gemini,
  "gpt:high": gpt,
  "@task": gpt,
  "@slow": sonnet,
  "@default": opus,
};
const roles = ["@task", "@slow", "@default"];
function facade(parent: Model | undefined = opus): Models {
  return {
    current: () => parent,
    resolve: (spec) => specs[spec],
    family: (model) => model.provider,
  };
}

test("keeps a cross-family primary and its original thinking suffix", () => {
  assert.deepEqual(orderReviewModels(["gpt:high", "gemini"], roles, facade())?.model,
    ["gpt:high", "gemini", "@slow", "@default"]);
});

test("swaps a same-family primary for the first cross-family candidate", () => {
  assert.deepEqual(orderReviewModels(["opus", "sonnet", "gemini"], roles, facade())?.model,
    ["gemini", "@task", "opus", "sonnet"]);
});

test("orders cross-family candidates ahead of same-family candidates", () => {
  assert.deepEqual(orderReviewModels(["gpt", "sonnet", "gemini", "opus"], [], facade())?.model,
    ["gpt", "gemini", "sonnet", "opus"]);
});

test("deduplicates resolved provider/id pairs while preserving first specs", () => {
  assert.deepEqual(orderReviewModels(["gpt:high", "gpt", "sonnet", "opus"], roles, facade())?.model,
    ["gpt:high", "sonnet", "opus"]);
  const models = facade();
  models.resolve = (spec) => spec === "other" ? { provider: "other", id: "gpt" } : specs[spec];
  assert.deepEqual(orderReviewModels(["gpt", "other"], [], models)?.model, ["gpt", "other"]);
});

test("keeps primary and same-family candidates when all resolved families match", () => {
  assert.deepEqual(orderReviewModels(["opus", "missing", "sonnet"], ["@default"], facade())?.model,
    ["opus", "sonnet"]);
});

test("leaves absent parent, empty patterns and unresolved primary unchanged", () => {
  const noParent = facade();
  noParent.current = () => undefined;
  assert.equal(orderReviewModels(["gpt"], roles, noParent), undefined);
  assert.equal(orderReviewModels([], roles, facade()), undefined);
  assert.equal(orderReviewModels(["missing", "gpt"], roles, facade()), undefined);
});

test("registers the spawn hook and routes every review role cross-family", () => {
  let handler: ((event: { agent: string; patterns: readonly string[] }, ctx: { models: Models }) => ReviewModels | undefined) | undefined;
  crossFamilyReview({ on(event, callback) {
    assert.equal(event, "before_subagent_spawn");
    assert.equal(handler, undefined);
    handler = callback;
  } });
  assert.ok(handler);
  for (const agent of ["reviewer", "triage-reviewer", "security-reviewer"]) {
    assert.deepEqual(handler({ agent, patterns: ["opus"] }, { models: facade() })?.model,
      ["@task", "opus", "@slow"]);
  }
  for (const agent of ["worker", "toString", "constructor"]) {
    assert.equal(handler({ agent, patterns: ["opus"] }, { models: facade() }), undefined);
  }
});
