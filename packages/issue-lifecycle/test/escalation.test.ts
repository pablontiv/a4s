import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import YAML from "yaml";

const feature = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
interface FixtureStep {
  id: string;
  depends?: string;
  preconditions?: unknown;
  run?: string;
  with: {
    push_back: { rewind_to: string };
    form: { properties: { ACTION: { enum: string[] } } };
  };
}
interface FixtureDag { steps: FixtureStep[] }
test("repair paths enter budget boundaries while preserving native static destinations", () => {
  const dag: FixtureDag = YAML.parse(feature);
  const steps = new Map(dag.steps.map(step => [step.id, step]));
  for (const id of ["conflict_review", "recover_gate", "validation", "await_ci"]) {
    assert.equal(steps.get(id)!.with.push_back.rewind_to, "implement_budget", id);
  }
  assert.equal(steps.get("await_merge")!.with.push_back.rewind_to, "rebase_budget");
  assert.equal(steps.get("implement")!.depends, "escalation_decision");
  assert.equal(steps.get("rebase")!.depends, "rebase_escalation_decision");
  assert.equal(steps.get("escalation")!.with.push_back.rewind_to, "triage");
  assert.deepEqual(steps.get("escalation")!.with.form.properties.ACTION.enum, ["continue", "stop"]);
  assert.match(steps.get("gate")!.run!, /escalation finding gate/);
  assert.match(steps.get("rebase")!.run!, /escalation finding conflict/);
});
