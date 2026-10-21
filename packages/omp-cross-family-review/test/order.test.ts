import assert from "node:assert/strict";
import { test } from "node:test";
import crossFamilyReview, { bindQualityImplementer } from "../src/index.ts";
import type * as CrossFamilyModule from "../src/index.ts";
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
  for (const detail of ["CROSS_FAMILY_EXHAUSTED", 'excluded families ["anthropic","openai"]',
    '"spec":"gpt"', '"spec":"@slow"', '"spec":"@default"']) {
    assert.ok(result?.reason?.includes(detail));
  }
});

test("security-reviewer excludes both the parent and task families", () => {
  assert.deepEqual(
    spawn(
      { agent: "security-reviewer", patterns: ["gpt", "gemini"] },
      { models: facade() },
    )?.model,
    ["gemini"],
  );
});

test("triage-reviewer compares candidates only with the parent", () => {
  assert.deepEqual(
    spawn({ agent: "triage-reviewer", patterns: ["@slow"] }, {
      models: facade(),
    })?.model,
    ["@task"],
  );
});

test("plan-reviewer selects a model outside the parent family", () => {
  assert.deepEqual(
    spawn({ agent: "plan-reviewer", patterns: ["@slow"] }, { models: facade() })?.model,
    ["@task"],
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
    ["gpt:high", "gemini"],
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
    ["gpt:high"],
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

const configuredAgents = ["reviewer", "qa", "security-reviewer", "triage-reviewer", "plan-reviewer"];

for (const agent of configuredAgents) {
  test(`${agent} blocks when the parent model is unavailable`, () => {
    const models = facade();
    models.current = () => undefined;
    const result = spawn({ agent, patterns: ["gemini"] }, { models });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /parent model unresolved; parent family cannot be verified/);
  });

  test(`${agent} blocks an unresolved parent family`, () => {
    const models = facade();
    models.family = model => model === opus ? "" : model.provider;
    const result = spawn({ agent, patterns: ["gemini"] }, { models });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /INDETERMINATE.*family cannot be verified/);
  });

  test(`${agent} reports actual excluded families and every exhausted candidate`, () => {
    const models = facade();
    models.resolve = spec => spec === "unknown-family" ? { provider: "unknown", id: "opaque" }
      : spec === "@task" ? opus : specs[spec];
    models.family = model => model.provider === "unknown" ? "" : model.provider;
    const result = spawn({ agent, patterns: ["opus", "missing", "unknown-family"] }, { models });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /EXHAUSTED.*excluded families \["anthropic"\]/);
    for (const spec of ["opus", "missing", "unknown-family", "@slow", "@default"]) {
      assert.ok(result?.reason?.includes(`"spec":"${spec}"`));
    }
    assert.match(result?.reason ?? "", /"family":"anthropic","cause":"excluded family"/);
    assert.match(result?.reason ?? "", /"spec":"missing","cause":"unavailable"/);
    assert.match(result?.reason ?? "", /"family":"","cause":"unresolved family"/);
    assert.match(result?.reason ?? "", /an available model with a resolved family outside the excluded families is required/);
  });

  test(`${agent} preserves eligible candidate order, aliases and thinking suffixes`, () => {
    assert.deepEqual(spawn({ agent, patterns: ["gemini", "gpt:high", "gpt", "opus"] },
      { models: facade() })?.model,
    ["triage-reviewer", "plan-reviewer"].includes(agent) ? ["gemini", "gpt:high"] : ["gemini"]);
  });
}

test("requires a resolved family reference and evaluates fallbacks with empty patterns", () => {
  assert.equal(orderReviewModels(["gpt"], roles, facade(), []).block, true);
  assert.deepEqual(orderReviewModels([], roles, facade(), [{ model: opus }]).model, ["@task"]);
});

test("ignores agents outside the review policy", () => {
  for (const agent of ["worker", "toString", "constructor"]) {
    assert.equal(
      spawn({ agent, patterns: ["opus"] }, { models: facade() }),
      undefined,
    );
  }
});


test("quality routing compares only the runtime-effective implementer", () => {
  for (const agent of ["qa", "reviewer"]) {
    bindQualityImplementer(agent, gpt);
    const result = spawn({ agent, spawnKey: agent, patterns: ["gpt", "opus", "gemini"] }, { models: facade() });
    assert.deepEqual(result?.model, ["opus", "gemini", "@slow"]);
  }
});

test("quality bindings reach the hook from a separately loaded module instance", async () => {
  // OMP loads each extension graph with its own query tag, so @a4s/omp-dagu binds
  // through a different instance of this module than the registered hook; a
  // dynamic import with a distinct query reproduces that loading boundary.
  const binder: typeof CrossFamilyModule = await import(`../src/index.ts?instance=${Date.now()}`);
  assert.notEqual(binder.bindQualityImplementer, bindQualityImplementer);
  binder.bindQualityImplementer("SeparateQA", gpt);
  const result = spawn({ agent: "qa", spawnKey: "SeparateQA", patterns: ["gpt", "opus"] }, { models: facade() });
  assert.deepEqual(result?.model, ["opus", "@slow"]);
});

test("strict eligibility resolves alternatives when a primary is unavailable", () => {
  assert.deepEqual(orderReviewModels(["missing", "gemini", "gpt"], roles, facade(),
    [{ model: opus }])?.model, ["gemini", "gpt"]);
});

test("candidate diagnostics contain model identity and family", () => {
  const models = facade();
  models.resolve = () => ({ ...opus, contextWindow: 100000 });
  const result = orderReviewModels(["opus"], [], models, [{ model: opus }]);
  assert.ok(result.reason?.includes('"model":{"provider":"anthropic","id":"opus"},"family":"anthropic"'));
});

test("selects a resolved alternative after candidates with unresolved family", () => {
  const models = facade();
  models.family = model => model === gpt ? "" : model.provider;
  assert.deepEqual(orderReviewModels(["gpt", "gemini"], roles, models,
    [{ model: opus }]).model, ["gemini"]);
  assert.equal(orderReviewModels([], [], models, [{ model: opus }]).block, true);
});
