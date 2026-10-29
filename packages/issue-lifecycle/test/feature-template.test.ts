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
  test(`${name} yes-triage publication follows deterministic PoC reuse or admission`, () => {
    const source = readFileSync(definition, "utf8");
    const decision = extractStep(source, "triage_decision");
    assert.match(decision, /if \[\[ "\$POC" == no \]\]; then\n        cd "\$PRIMARY"\n        gh issue comment/);
    const admission = extractStep(source, "poc_admit");
    assert.match(admission, /if ! dagu status --run-id "poc-\$RUN" poc >\/dev\/null 2>&1; then/);
    assert.match(admission, /--run-id "poc-\$RUN" "\$PRIMARY\/\.workspace\/dagu\/dags\/poc.yaml"/);
    assert.ok(admission.indexOf("dagu status") < admission.indexOf('"$A4S_BIN" enqueue'));
    assert.match(admission, /SCOPE_REQUEST="\$SCOPE_REQUEST"\n      fi\n[\s\S]*gh issue comment/);
    assert.doesNotMatch(decision, /enqueue/);
  });
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
  test(`${name} scope rejects rewind only correctable decisions and guard admission`, () => {
    const source = readFileSync(definition, "utf8");
    assert.match(extractStep(source, "poc_scope_resolve"), /exit_code: \[23\]/);
    const recovery = extractStep(source, "recover_poc_scope");
    assert.match(recovery, /condition: "\$\{poc_scope_resolve.exit_code\}"\n        expected: "23"/);
    assert.match(recovery, /rewind_to: poc_scope_prepare/);
    const admit = extractStep(source, "poc_admit");
    assert.match(admit, /depends: recover_poc_scope_cancellation/);
    assert.match(admit, /condition: "\$\{poc_scope_resolve.exit_code\}"\n        expected: "0"/);
    assert.match(extractStep(source, "poc_scope_prepare"), /name: SCOPE_REJECTION/);
    assert.match(extractStep(source, "poc_scope_decision"), /outputs.SCOPE_REJECTION/);
    assert.match(source, /"recover_poc_scope - scope-transition.log"/);
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
