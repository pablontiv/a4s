import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { renderedFeature } from "./fixtures/templates-rendered.ts";

const definitions = [
  ["template", fileURLToPath(new URL("../skills/issue-execution/feature.yaml", import.meta.url))],
  ["rendered fixture", renderedFeature],
] as const;

function extractStep(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, `missing step ${id}`);
  const end = source.indexOf("\n  - id:", start + 1);
  return source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
}

for (const [name, definition] of definitions) {
  test(`${name} every candidate publication follows the gate and optional validation`, () => {
    const source = readFileSync(definition, "utf8");
    for (const [step, dependency] of [
      ["recover_gate", "gate"], ["validation", "recover_gate_cancellation"],
      ["push", "validation_cancellation"], ["pr", "recover_push_cancellation"], ["code_scanning", "pr"], ["auto_merge", "code_scanning"],
    ]) assert.match(extractStep(source, step!), new RegExp(`depends: ${dependency}`));
    const publications = source.split("\n  - id:").filter(block => block.includes('push "--force-with-lease=$remote_ref:$expected" --set-upstream origin "$sha:$remote_ref"'));
    assert.equal(publications.length, 1);
    assert.match(publications[0]!, /^ push\n/);
    assert.match(extractStep(source, "await_merge"), /rewind_to: rebase/);
    assert.match(extractStep(source, "await_ci"), /rewind_to: implement/);
  });
  for (const [step, downstream] of [["start_gate", "implement"], ["gate", "validation"], ["push", "pr"]]) {
    test(`${name} ${step} routes failure through its recovery checkpoint`, () => {
      const source = readFileSync(definition, "utf8");
      assert.match(extractStep(source, step!), /continue_on:\n      failure: true/);
      const recovery = extractStep(source, `recover_${step}`);
      assert.ok(recovery.includes(`condition: "\${${step}.exit_code}"`));
      const rewind = step === "gate" ? "implement_budget" : step;
      assert.match(recovery, new RegExp(`^        rewind_to: ${rewind}$`, "m"));
      assert.match(recovery, /continue_on: skipped/);
      const path = step === "start_gate"
        ? ["recover_start_gate", "recover_start_gate_cancellation", "implement_budget", "escalation",
          "escalation_cancellation", "escalation_decision", downstream]
        : [`recover_${step}`, `recover_${step}_cancellation`, downstream];
      for (let index = 1; index < path.length; index++) {
        assert.match(extractStep(source, path[index]!), new RegExp(`^    depends: ${path[index - 1]}$`, "m"));
      }
    });
  }
}
