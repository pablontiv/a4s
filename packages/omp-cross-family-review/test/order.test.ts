import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { registerReviewHook } from "../src/index.ts";
import { orderReviewModels } from "../src/order.ts";
import type { Model, Models, ReviewModels } from "../src/order.ts";

const opus = { provider: "anthropic", id: "opus" };
const sonnet = { provider: "anthropic", id: "sonnet" };
const gpt = { provider: "openai", id: "gpt" };
const gemini = { provider: "google", id: "gemini" };
const specs: Record<string, Model> = {
  opus, sonnet, gpt, gemini, "gpt:high": gpt, "@task": gpt,
  "@slow": sonnet, "@default": opus, "@custom": gemini,
};
function facade(parent: Model | undefined = opus): Models {
  return { current: () => parent, resolve: spec => specs[spec], family: model => model.provider };
}
const root = mkdtempSync(join(tmpdir(), "cross-family-settings-"));
after(() => rmSync(root, { recursive: true, force: true }));
let configId = 0;
async function initialScope(policies: unknown) {
  const file = join(root, `overlay-${configId++}.yml`);
  writeFileSync(file, JSON.stringify({ crossFamilyReview: { policies } }));
  return Settings.loadReadOnly({ cwd: root, agentDir: root, configFiles: [file] });
}
const parentOnly = { fallbackRoles: ["@task", "@slow", "@default"], excludeTaskFamily: false };
const parentAndTask = { fallbackRoles: ["@slow", "@default"], excludeTaskFamily: true };
const configured = await initialScope({
  custom: parentOnly, "custom-strict": parentAndTask,
  qa: parentAndTask, reviewer: parentAndTask,
  "security-reviewer": parentAndTask, "triage-reviewer": parentOnly, "plan-reviewer": parentOnly,
  ordered: { fallbackRoles: ["@custom", "gpt:high", "@task"], excludeTaskFamily: false },
});
const unconfigured = Settings.isolated();
// Construct these before extension registration, just like initial CLI config.
const malformed = await Promise.all([
  [], "bad", 1,
  { custom: null },
  { custom: { fallbackRoles: [123], excludeTaskFamily: false } },
  { custom: { fallbackRoles: "@task", excludeTaskFamily: false } },
  { custom: { fallbackRoles: [], excludeTaskFamily: "false" } },
  { custom: { fallbackRoles: [] } },
  { custom: { ...parentOnly, strict: true } },
].map(initialScope));
type SpawnEvent = { agent: string; patterns: readonly string[]; spawnKey?: string };
type SpawnHandler = (event: SpawnEvent, ctx: { cwd: string; models: Models }) => ReviewModels | undefined;
let handler: SpawnHandler;
// Intentional late-registration boundary matching native initial CLI config.
const { readReviewPolicies } = await import("../src/settings.ts");
registerReviewHook({ on(event, callback) {
  assert.equal(event, "before_subagent_spawn");
  handler = callback;
} }, readReviewPolicies);
function spawn(event: SpawnEvent, models = facade(), scope = configured) {
  return withActiveSettings(scope, () => handler(event, { cwd: process.cwd(), models }));
}

test("registers a typed empty-default record in the native registry", () => {
  const setting = lookup("crossFamilyReview.policies")!;
  assert.equal(setting.type, "record");
  assert.deepEqual(setting.default, {});
  setting.assertWritable({ custom: parentOnly });
  assert.throws(() => setting.assertWritable({ custom: { ...parentOnly, extra: true } }), /invalid policy/);
});
test("configured custom names choose parent versus parent and task families", () => {
  assert.deepEqual(spawn({ agent: "custom", patterns: ["opus", "gpt", "gemini"] })?.model, ["gpt", "gemini"]);
  assert.deepEqual(spawn({ agent: "custom-strict", patterns: ["opus", "gpt", "gemini"] })?.model, ["gemini"]);
});
test("all configured names strictly block exhaustion with identity diagnostics", () => {
  const result = spawn({ agent: "custom-strict", patterns: ["gpt"] });
  assert.equal(result?.block, true);
  for (const detail of ["CROSS_FAMILY_EXHAUSTED", 'excluded families ["anthropic","openai"]',
    '"spec":"gpt"', '"spec":"@slow"', '"spec":"@default"', '"provider":"openai"']) {
    assert.ok(result?.reason?.includes(detail), result?.reason ?? detail);
  }
});
test("configured fallback order follows native candidates and preserves first aliases", () => {
  assert.deepEqual(spawn({ agent: "ordered", patterns: ["opus"] })?.model, ["@custom", "gpt:high"]);
  assert.deepEqual(spawn({ agent: "ordered", patterns: ["gpt:high"] })?.model, ["gpt:high", "@custom"]);
});
test("deduplicates resolved provider/id pairs and preserves thinking suffixes", () => {
  assert.deepEqual(orderReviewModels(["gpt:high", "gpt", "sonnet", "gemini"], ["@task", "@custom"], facade(),
    [{ model: opus }]).model, ["gpt:high", "gemini"]);
  const models = facade();
  models.resolve = spec => spec === "other" ? { provider: "other", id: "gpt" } : specs[spec];
  assert.deepEqual(orderReviewModels(["gpt", "other"], [], models, [{ model: opus }]).model, ["gpt", "other"]);
});
test("unresolved candidates are excluded while resolved alternatives remain eligible", () => {
  assert.deepEqual(orderReviewModels(["missing", "gemini", "gpt"], ["@unknown"], facade(),
    [{ model: opus }]).model, ["gemini", "gpt"]);
  assert.equal(orderReviewModels(["missing"], [], facade(), [{ model: opus }]).block, true);
});
test("unknown reference identities fail closed", () => {
  assert.equal(orderReviewModels(["gpt"], [], facade(), []).block, true);
  const noParent = facade();
  noParent.current = () => undefined;
  assert.match(spawn({ agent: "custom", patterns: ["gemini"] }, noParent)?.reason ?? "", /INDETERMINATE.*parent/);
  const noTask = facade();
  noTask.resolve = spec => spec === "@task" ? undefined : specs[spec];
  assert.match(spawn({ agent: "custom-strict", patterns: ["gemini"] }, noTask)?.reason ?? "", /INDETERMINATE.*@task/);
  const noFamily = facade();
  noFamily.family = () => "";
  assert.equal(spawn({ agent: "custom", patterns: ["gpt"] }, noFamily)?.block, true);
  assert.deepEqual(spawn({ agent: "custom", patterns: [] })?.model, ["@task"]);
});

// Repository adoption remains data; every configured name uses the same strict API.
for (const agent of ["reviewer", "qa", "security-reviewer", "triage-reviewer", "plan-reviewer", "custom"]) {
  test(`${agent} blocks when the parent model is unavailable`, () => {
    const models = facade();
    models.current = () => undefined;
    const result = spawn({ agent, patterns: ["gemini"] }, models);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /INDETERMINATE.*parent/);
  });

  test(`${agent} blocks an unresolved parent family`, () => {
    const models = facade();
    models.family = model => model === opus ? "" : model.provider;
    const result = spawn({ agent, patterns: ["gemini"] }, models);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /INDETERMINATE.*family cannot be verified/);
  });

  test(`${agent} reports actual excluded families and every exhausted candidate`, () => {
    const models = facade();
    models.resolve = spec => spec === "unknown-family" ? { provider: "unknown", id: "opaque" }
      : spec === "@task" ? opus : specs[spec];
    models.family = model => model.provider === "unknown" ? "" : model.provider;
    const result = spawn({ agent, patterns: ["opus", "missing", "unknown-family"] }, models);
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
    assert.deepEqual(spawn({ agent, patterns: ["gemini", "gpt:high", "gpt", "opus"] })?.model,
      ["triage-reviewer", "plan-reviewer", "custom"].includes(agent) ? ["gemini", "gpt:high"] : ["gemini"]);
  });
}
test("an unresolved candidate family cannot qualify", () => {
  const models = facade();
  models.family = model => model === gpt ? "" : model.provider;
  assert.deepEqual(orderReviewModels(["gpt", "gemini"], [], models, [{ model: opus }]).model, ["gemini"]);
});
test("unconfigured exact names retain native inputs, including adoption names by default", () => {
  const event = { agent: "reviewer", patterns: ["opus:high", "missing"] };
  for (const agent of ["worker", "CUSTOM", "toString", "constructor", "reviewer", "qa", "security-reviewer", "triage-reviewer", "plan-reviewer"]) {
    assert.equal(spawn({ ...event, agent }, facade(), unconfigured), undefined);
  }
  assert.deepEqual(event.patterns, ["opus:high", "missing"]);
});
test("the same policy, candidates and families produce deterministic output", () => {
  const event = { agent: "ordered", patterns: ["opus", "gpt:high", "gpt"] };
  assert.deepEqual(spawn(event), spawn(event));
});
test("malformed effective initial values block before model resolution or spawn", () => {
  for (const scope of malformed) {
    const models = facade();
    models.resolve = () => { throw new Error("model resolution must follow config validation"); };
    const result = spawn({ agent: "custom", patterns: ["gpt"] }, models, scope);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /^CROSS_FAMILY_CONFIG: crossFamilyReview.policies/);
  }
});
test("candidate diagnostics contain model identity and family", () => {
  const models = facade();
  models.resolve = () => ({ ...opus, contextWindow: 100000 });
  const result = orderReviewModels(["opus"], [], models, [{ model: opus }]);
  assert.equal(result.block, true);
  assert.ok(result.reason?.includes('"model":{"provider":"anthropic","id":"opus"},"family":"anthropic"'));
});
