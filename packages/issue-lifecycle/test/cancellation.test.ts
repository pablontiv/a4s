import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import { assertNotCancelled, cancellationRoute, parseCancelDetails, readCancellation, saveCancellation, type Cancellation } from "../src/cancellation.ts";
import { isActive, renderRun, Transitions } from "../src/status/progress.ts";

const snapshot = stringify({ queue: "feature", steps: [{ id: "review", action: "human.task", with: { form: { properties: { CANCEL: { enum: ["yes", "no"] } } } } }, { id: "review_cancellation", depends: "review" }] });
test("cancellation chooses exact queue, declared wait, or request-only running mechanism", () => {
  assert.deepEqual(cancellationRoute({ statusLabel: "queued", nodes: [] }, snapshot), { route: "queued", step: "queue", iteration: 0, queue: "feature" });
  assert.deepEqual(cancellationRoute({ statusLabel: "waiting", nodes: [{ step: { name: "review" }, statusLabel: "waiting", approvalIteration: 3 }] }, snapshot), { route: "waiting", step: "review", iteration: 3 });
  assert.deepEqual(cancellationRoute({ statusLabel: "running", nodes: [{ step: { name: "implement" }, statusLabel: "running", approvalIteration: 4 }] }, snapshot), { route: "running", step: "implement", iteration: 4 });
  assert.throws(() => cancellationRoute({ statusLabel: "queued", startedAt: "2026-11-01T00:00:00Z", nodes: [] }, snapshot), /previously started/);
  assert.throws(() => cancellationRoute({ statusLabel: "waiting", nodes: [{ step: { name: "old" }, statusLabel: "waiting" }] }, snapshot), /immutable snapshot/);
  assert.throws(() => cancellationRoute({ statusLabel: "succeeded", nodes: [] }, snapshot), /no cancellation mutation/);
  assert.throws(() => parseCancelDetails({ statusLabel: "queued", nodes: [{}] }), /Malformed/);
});
const record: Cancellation = { schemaVersion: 1, run: "cancelled-run", dag: "feature", checkpoint: "queue", iteration: 0, requester: "operator", requestedAt: "2026-11-01T00:00:00Z", outcome: "cancelled", nativeExpected: "not_found", nativeObserved: "not_found", unexecutedEffects: ["push"], retained: [{ location: "candidate", owner: "cancelled-run", kind: "candidate" }] };
test("durable domain cancellation retains native absence and blocks readmission; pending is not terminal", () => {
  const root = mkdtempSync(join(tmpdir(), "cancel-record-"));
  try {
    saveCancellation(root, record);
    assert.deepEqual(readCancellation(root), record);
    assert.throws(() => assertNotCancelled(root), /cancelled/);
    saveCancellation(root, { ...record, outcome: "pending", nativeExpected: "running" });
    assert.doesNotThrow(() => assertNotCancelled(root));
    saveCancellation(root, { ...record, outcome: "pending", nativeExpected: "not_found" });
    assert.throws(() => assertNotCancelled(root), /cancelled/);
    writeFileSync(join(root, "cancellation.json"), "{}");
    assert.throws(() => readCancellation(root), /Invalid cancellation record/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("cancelled/native not_found is terminal in widgets and notices without relabeling sibling nodes", () => {
  const run = { name: "feature", dagRunId: record.run, statusLabel: "not_found", cancellation: record, params: "OMP_SESSION_ID=owner", nodes: [{ step: { name: "await_merge", humanTask: {} }, statusLabel: "waiting" }] };
  assert.equal(isActive(run), false);
  assert.match(renderRun(run), /cancelled\/not_found.*retained=candidate/);
  const transitions = new Transitions("owner");
  const effects = transitions.observe(run);
  assert.match(effects.wakeMessage || "", /cancelled\/not_found.*retained=candidate/);
  assert.equal(run.nodes[0]!.statusLabel, "waiting");
});
interface ContractStep { id: string; action?: string; depends?: string | string[]; with?: { form?: { properties?: { CANCEL?: { enum?: string[] } } } } }
function humanCancellationContract(text: string): void {
  for (const document of parseAllDocuments(text)) {
    if (document.errors.length) throw document.errors[0];
    const dag = document.toJS() as { steps?: ContractStep[] } | null;
    if (!dag?.steps) continue;
    for (const step of dag.steps.filter(step => step.action === "human.task")) {
      assert.deepEqual(step.with?.form?.properties?.CANCEL?.enum, ["yes", "no"], `${step.id}: CANCEL enum`);
      const gate: ContractStep | undefined = dag.steps.find(candidate => candidate.id === `${step.id}_cancellation`);
      assert.ok(gate, `${step.id}: immediate cancellation gate`);
      assert.ok((Array.isArray(gate.depends) ? gate.depends : [gate.depends]).includes(step.id), `${step.id}: gate dependency`);
      for (const dependent of dag.steps.filter(candidate => (Array.isArray(candidate.depends) ? candidate.depends : [candidate.depends]).includes(step.id))) {
        assert.ok(dependent === gate || (Array.isArray(dependent.depends) ? dependent.depends : [dependent.depends]).includes(gate.id), `${step.id}: ${dependent.id} bypasses cancellation gate`);
      }
    }
  }
}
test("every maintained human task declares cancellation and an immediate gate", () => {
  const directory = new URL("../skills/issue-execution/", import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith(".yaml"))) humanCancellationContract(readFileSync(new URL(name, directory), "utf8"));
  assert.throws(() => humanCancellationContract("steps:\n  - id: missing\n    action: human.task\n"), /CANCEL/);
  assert.throws(() => humanCancellationContract(stringify({ steps: [{ id: "missing_gate", action: "human.task", with: { form: { required: ["CANCEL"], properties: { CANCEL: { enum: ["yes", "no"] } } } } }] })), /gate/);
  assert.throws(() => humanCancellationContract(stringify({ steps: [{ id: "review", action: "human.task", with: { form: { properties: { CANCEL: { enum: ["yes", "no"] } } } } }, { id: "review_cancellation", depends: "review" }, { id: "unsafe_effect", depends: "review" }] })), /bypasses/);
});
