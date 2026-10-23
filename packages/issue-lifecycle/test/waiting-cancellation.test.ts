import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { waitingSnapshot } from "./fixtures/waiting-snapshot.ts";

type Step = { id: string; action?: string; depends?: string | string[]; run?: string; env?: Record<string, string>[]; continue_on?: unknown; preconditions?: unknown; with?: { form: { properties: Record<string, unknown> } } };
for (const kind of ["feature", "poc", "discovery"]) {
  test(`${kind} declares cancellation-only input and gates every checkpoint successor`, () => {
    const source: { steps: Step[]; handler_on: { exit: { run: string }; failure?: { run: string } } } = parse(readFileSync(new URL(`../skills/issue-execution/${kind}.yaml`, import.meta.url), "utf8"));
    for (const checkpoint of source.steps.filter(step => step.action === "human.task")) {
      assert.deepEqual(checkpoint.with?.form.properties.CANCEL, { type: "string", enum: ["yes", "no"] });
      const gate = source.steps.find(step => step.id === `${checkpoint.id}_cancellation`)!;
      assert.ok(gate, checkpoint.id);
      assert.equal(gate.depends, checkpoint.id);
      assert.ok(gate.continue_on === undefined || gate.continue_on === "skipped", `${gate.id} failure stops recovery descendants`);
      const skips = (value: unknown) => value === "skipped" || (value as { skipped?: boolean } | undefined)?.skipped === true;
      assert.equal(skips(gate.continue_on), skips(checkpoint.continue_on), `${gate.id} preserves optional-branch continuation`);
      assert.deepEqual(gate.preconditions, checkpoint.preconditions, `${gate.id} preserves optional-branch conditions`);
      assert.match(gate.run!, /exit 77/);
      const successors = source.steps.filter(step => (Array.isArray(step.depends) ? step.depends : [step.depends]).includes(checkpoint.id));
      assert.deepEqual(successors.map(step => step.id), [gate.id], `${checkpoint.id} has one guarded outgoing edge`);
      const environment: NodeJS.ProcessEnv = { ...process.env, ...Object.assign({}, ...gate.env ?? []), CANCEL: "no" };
      const required = (environment.REQUIRED_FIELDS ?? "").split(" ").filter(Boolean);
      for (const field of required) environment[field] = "normal";
      const normal = spawnSync("bash", ["-c", gate.run!], { encoding: "utf8", env: environment });
      assert.equal(normal.status, 0, normal.stderr);
      assert.equal(normal.stdout, "");
      for (const field of required) {
        const missing = spawnSync("bash", ["-c", gate.run!], { encoding: "utf8", env: { ...environment, [field]: "" } });
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, new RegExp(`Normal completion requires ${field}`));
      }
    }
    assert.ok(source.handler_on.exit.run);
    for (const handler of [source.handler_on.exit, source.handler_on.failure]) if (handler) {
      const syntax = spawnSync("bash", ["-n", "-c", handler.run], { encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    if (kind === "poc") assert.match(source.handler_on.failure!.run, /cancellation\.json/);
  });
}

test("native feature role stages retain historical cancellation snapshot coverage", () => {
  const template = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
  const current = parse(template);
  const historical = parse(waitingSnapshot(template));
  for (const [id, fields] of [
    ["triage", ["POC", "QUESTION", "BASIS"]],
    ["implement", ["SUMMARY", "MESSAGE", "IMPLEMENTER"]],
  ] as const) {
    const native = current.steps.find((step: Step) => step.id === id);
    assert.match(native.run, new RegExp(`dagu-role-jobs stage ${id}`));
    const checkpoint = historical.steps.find((step: Step) => step.id === id);
    assert.equal(checkpoint.action, "human.task");
    assert.deepEqual(checkpoint.with.form.properties.CANCEL, { type: "string", enum: ["yes", "no"] });
    const gate = historical.steps.find((step: Step) => step.id === `${id}_cancellation`);
    assert.equal(gate.depends, id);
    assert.ok(gate.env.some((entry: { REQUIRED_FIELDS?: string }) => entry.REQUIRED_FIELDS === fields.join(" ")));
    assert.match(gate.run, /exit 77/);
  }
});

