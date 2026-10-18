import assert from "node:assert/strict";
import { test } from "node:test";
import crossFamilyReview, { bindQualityImplementer } from "../src/index.ts";
import { orderReviewModels } from "../src/order.ts";
import type {
  FamilyReference,
  Model,
  Models,
  ReviewModels,
} from "../src/order.ts";

const opus = { provider: "anthropic", id: "opus" };
const sonnet = { provider: "anthropic", id: "sonnet" };
const gpt = { provider: "openai", id: "gpt" };
const gemini = { provider: "google", id: "gemini" };
const specs: Record<string, Model> = {
  opus,
  sonnet,
  gpt,
  gemini,
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

function parentReference(models: Models): FamilyReference[] {
  const parent = models.current();
  return parent ? [{ model: parent }] : [];
}

type SpawnHandler = (
  event: { agent: string; patterns: readonly string[]; spawnKey?: string },
  ctx: { models: Models },
) => ReviewModels | undefined;

function register(): SpawnHandler {
  let handler: SpawnHandler | undefined;
  crossFamilyReview({
    on(event, callback) {
      assert.equal(event, "before_subagent_spawn");
      assert.equal(handler, undefined);
      handler = callback;
    },
  });
  assert.ok(handler);
  return handler;
}

const spawn = register();

test("reviewer swaps a task-family primary and omits the task fallback", () => {
  assert.deepEqual(
    spawn({ agent: "reviewer", patterns: ["gpt", "gemini"] }, {
      models: facade(),
    }),
    {
      model: ["gemini"],
      note: "strict cross-family eligibility; effective transcript identity must pass the publication gate",
    },
  );
});

test("reviewer keeps a primary outside the parent and task families", () => {
  assert.deepEqual(
    spawn({ agent: "reviewer", patterns: ["gemini", "gpt"] }, {
      models: facade(),
    })?.model,
    ["gemini"],
  );
});

test("reviewer blocks exhaustion with attempted candidates and excluded families", () => {
  const result = spawn({ agent: "reviewer", patterns: ["gpt"] }, { models: facade() });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /EXHAUSTED.*gpt.*@slow.*anthropic.*openai/);
});

test("security-reviewer excludes both the parent and task families", () => {
  assert.deepEqual(
    spawn(
      { agent: "security-reviewer", patterns: ["gpt", "gemini"] },
      { models: facade() },
    )?.model,
    ["gemini", "gpt", "@slow", "@default"],
  );
});

test("triage-reviewer compares candidates only with the parent", () => {
  assert.deepEqual(
    spawn({ agent: "triage-reviewer", patterns: ["@slow"] }, {
      models: facade(),
    })?.model,
    ["@task", "@slow", "@default"],
  );
});

test("reviewer excludes only the parent family when task is unresolved", () => {
  const models = facade();
  models.resolve = (spec) => spec === "@task" ? undefined : specs[spec];
  assert.deepEqual(
    spawn({ agent: "reviewer", patterns: ["opus", "gpt"] }, { models }),
    {
      model: ["gpt"],
      note: "strict cross-family eligibility; effective transcript identity must pass the publication gate",
    },
  );
});

test("keeps a qualifying primary and its original thinking suffix", () => {
  const models = facade();
  assert.deepEqual(
    orderReviewModels(
      ["gpt:high", "gemini"],
      roles,
      models,
      parentReference(models),
    )?.model,
    ["gpt:high", "gemini", "@slow", "@default"],
  );
});

test("deduplicates resolved provider/id pairs while preserving first specs", () => {
  const models = facade();
  assert.deepEqual(
    orderReviewModels(
      ["gpt:high", "gpt", "sonnet", "opus"],
      roles,
      models,
      parentReference(models),
    )?.model,
    ["gpt:high", "sonnet", "opus"],
  );
  models.resolve = (spec) =>
    spec === "other" ? { provider: "other", id: "gpt" } : specs[spec];
  assert.deepEqual(
    orderReviewModels(
      ["gpt", "other"],
      [],
      models,
      parentReference(models),
    )?.model,
    ["gpt", "other"],
  );
});

test("returns undefined without a parent, patterns, or a resolved primary", () => {
  const noParent = facade();
  noParent.current = () => undefined;
  assert.equal(
    orderReviewModels(["gpt"], roles, noParent, parentReference(noParent)),
    undefined,
  );
  const models = facade();
  const excluded = parentReference(models);
  assert.equal(orderReviewModels([], roles, models, excluded), undefined);
  assert.equal(
    orderReviewModels(["missing", "gpt"], roles, models, excluded),
    undefined,
  );
  assert.equal(
    spawn({ agent: "reviewer", patterns: ["gpt"] }, { models: noParent })?.block,
    true,
  );
});

test("ignores agents outside the review policy", () => {
  for (const agent of ["worker", "toString", "constructor"]) {
    assert.equal(
      spawn({ agent, patterns: ["opus"] }, { models: facade() }),
      undefined,
    );
  }
});

test("QA has strict eligibility and blocks indeterminate identity", () => {
  assert.deepEqual(spawn({ agent: "qa", patterns: ["gpt", "gemini"] }, { models: facade() })?.model, ["gemini"]);
  assert.equal(orderReviewModels([], roles, facade(), [], true)?.block, true);
  const models = facade();
  models.family = () => "";
  assert.equal(orderReviewModels(["gpt"], roles, models, parentReference(models), true)?.block, true);
});

test("quality routing compares only the runtime-effective implementer", () => {
  for (const agent of ["qa", "reviewer"]) {
    bindQualityImplementer(agent, gpt);
    const result = spawn({ agent, spawnKey: agent, patterns: ["gpt", "opus", "gemini"] }, { models: facade() });
    assert.deepEqual(result?.model, ["opus", "gemini", "@slow"]);
  }
});

test("strict eligibility resolves alternatives when a primary is unavailable", () => {
  assert.deepEqual(orderReviewModels(["missing", "gemini", "gpt"], roles, facade(),
    [{ model: opus }], true)?.model, ["gemini", "gpt"]);
});
