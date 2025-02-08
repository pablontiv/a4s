import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { waitingSnapshot } from "./fixtures/waiting-snapshot.ts";

type Step = { id: string; action?: string; depends?: string | string[]; run?: string; env?: Record<string, string>[]; continue_on?: unknown; preconditions?: unknown; with?: { form: { properties: Record<string, unknown>; required?: string[] } } };
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
    }
    assert.ok(source.handler_on.exit.run);
    if (kind === "poc") assert.match(source.handler_on.failure!.run, /cancellation\.json/);
  });
}

test("planning approval guards cancellation and normal materialization as separate branches", () => {
  const source: { steps: Step[] } = parse(readFileSync(new URL("../skills/issue-execution/planning.yaml", import.meta.url), "utf8"));
  for (const id of ["import_units", "check_plan", "check_review"]) {
    assert.deepEqual(source.steps.find(step => step.id === id)?.continue_on, { failure: true, mark_success: true },
      `${id} must not rewind a completed cancellation checkpoint when resuming`);
  }
  const approve = source.steps.find(step => step.id === "approve")!;
  assert.deepEqual(approve.with?.form.properties.CANCEL, { type: "string", enum: ["yes", "no"] });
  assert.deepEqual(approve.with?.form.required, ["CANCEL"], "cancellation needs no APPROVED; publication requires an explicit choice");
  const gate = source.steps.find(step => step.id === "approve_cancellation")!;
  assert.equal(gate.depends, "approve");
  assert.equal(gate.continue_on, undefined, "cancellation failure must stop materialization");
  assert.match(gate.run!, /if \[\[ "\$CANCEL" == yes \]\]; then[\s\S]*outcome:"cancelled"[\s\S]*exit 77/);
  assert.match(gate.run!, /nativeExpected:"aborted"[\s\S]*dagu stop --run-id "\$RUN" planning/);
  assert.match(gate.run!, /Normal completion requires APPROVED/);
  assert.deepEqual(source.steps.filter(step => step.depends === "approve").map(step => step.id), ["approve_cancellation"]);
  const materialize = source.steps.find(step => step.id === "materialize")!;
  assert.equal(materialize.depends, gate.id);
  assert.deepEqual(materialize.preconditions, [{ condition: "${steps.approve.outputs.CANCEL}", expected: "no" }]);
  const conditions = materialize.preconditions as { condition: string; expected: string }[];
  for (const [CANCEL, allowed] of [["yes", false], ["no", true]] as const) {
    assert.equal(conditions.every(condition => condition.expected === CANCEL), allowed, `CANCEL=${CANCEL} publication gate`);
  }
});

test("feature and PoC suites leave cancellation scenarios registered once", () => {
  for (const file of ["feature-template.test.ts", "poc-template.test.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(source.includes("waiting-cancellation.test.ts"), false, `${file} re-registers cancellation scenarios`);
  }
});

test("native feature role stages retain historical cancellation snapshot coverage", () => {
  const template = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
  const current = parse(template);
  const historical = parse(waitingSnapshot(template));
  for (const [id, fields] of [
    ["triage", ["POC", "QUESTION", "BASIS"]],
    ["implement", ["SUMMARY", "MESSAGE", "IMPLEMENTER"]],
  ] as const) {
    const native = current.steps.find((step: Step) => step.id === id);
    assert.match(native.run, new RegExp(`"\\$A4S_BIN" role-jobs stage ${id}`));
    const checkpoint = historical.steps.find((step: Step) => step.id === id);
    assert.equal(checkpoint.action, "human.task");
    assert.deepEqual(checkpoint.with.form.properties.CANCEL, { type: "string", enum: ["yes", "no"] });
    const gate = historical.steps.find((step: Step) => step.id === `${id}_cancellation`);
    assert.equal(gate.depends, id);
    assert.ok(gate.env.some((entry: { REQUIRED_FIELDS?: string }) => entry.REQUIRED_FIELDS === fields.join(" ")));
    assert.match(gate.run, /exit 77/);
  }
});
