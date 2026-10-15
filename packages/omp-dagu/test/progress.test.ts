import assert from "node:assert/strict";
import test from "node:test";
import { currentStep, renderRun, runLabel, Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";

const run: RunDetails = {
  name: "feature", dagRunId: "a4s-issue-157", statusLabel: "running", params: "ISSUE=157 PRIMARY=/tmp/a4s",
  nodes: [
    { step: { name: "triage" }, statusLabel: "succeeded" },
    { step: { name: "optional" }, statusLabel: "skipped" },
    { step: { name: "gate" }, statusLabel: "running" },
    { step: { name: "approve" }, statusLabel: "waiting" },
    { step: { name: "cancelled" }, statusLabel: "aborted" },
  ],
};

test("progress counts succeeded/skipped and renders the DAG identity and current step", () => {
  assert.equal(renderRun(run), "dagu · feature #157 ▰▰▱▱▱▱ 2/5 gate running");
  assert.equal(renderRun(run, "improve-widget"), "dagu · feature #157 improve-widget ▰▰▱▱▱▱ 2/5 gate running");
  assert.equal(currentStep({ ...run, statusLabel: "waiting" }), "approve");
  assert.equal(renderRun({ ...run, statusLabel: "waiting" }), "dagu · feature #157 ▰▰▱▱▱▱ 2/5 approve waiting");
  assert.equal(currentStep({ ...run, nodes: [run.nodes![3]!] }), "approve");
});

test("queued summaries and empty DAGs render zero progress and fall back to run ID", () => {
  assert.equal(renderRun({ name: "poc", dagRunId: "run-1", statusLabel: "queued" }), "dagu · poc run-1 ▱▱▱▱▱▱ 0/0 queued");
  assert.equal(renderRun({ ...run, nodes: [] }), "dagu · feature #157 ▱▱▱▱▱▱ 0/0 running");
  assert.equal(renderRun({ ...run, nodes: [{ step: { name: "done" }, statusLabel: "succeeded" }] }), "dagu · feature #157 ▰▰▰▰▰▰ 1/1 running");
});

test("identity extracts ISSUE from CLI and JSON params and sanitizes Dagu data", () => {
  for (const params of ['ISSUE=127', 'PRIMARY=/tmp ISSUE="127" BRANCH=x', '{"ISSUE":"127","PRIMARY":"x"}', '{"ISSUE":127}']) {
    assert.equal(runLabel({ ...run, params }), "feature #127", params);
  }
  for (const params of ["OTHER_ISSUE=99", "ISSUE=12bad", "ISSUE=", ""]) {
    assert.equal(runLabel({ ...run, params }), `feature ${run.dagRunId}`, params);
  }
  assert.equal(runLabel({ ...run, name: "fea\u001bture\n", params: "", dagRunId: "run\u001b\n" }), "fea ture  run  ");
});

test("notifications include the DAG identity and deduplicate reconnects and waiting gates", () => {
  const transitions = new Transitions();
  assert.equal(transitions.observe(run), undefined);
  const waiting = { ...run, statusLabel: "waiting" };
  assert.deepEqual(transitions.observe(waiting, "improve-widget"), {
    message: "dagu · feature #157 improve-widget waiting · approve",
    type: "warning",
  });
  assert.equal(transitions.observe(waiting), undefined);
  assert.equal(transitions.observe(run), undefined);
  assert.equal(transitions.observe(waiting)?.type, "warning");
  assert.equal(transitions.observe({ ...waiting, nodes: [{ step: { name: "merge" }, statusLabel: "waiting" }] })?.message,
    "dagu · feature #157 waiting · merge");
  for (const [statusLabel, type] of [["succeeded", "info"], ["failed", "error"], ["aborted", "warning"]] as const) {
    const terminal = { ...run, dagRunId: statusLabel, statusLabel };
    assert.equal(transitions.observe({ ...terminal, statusLabel: "running" }), undefined);
    assert.deepEqual(transitions.observe(terminal), { message: `dagu · feature #157 ${statusLabel}`, type });
    assert.equal(transitions.observe(terminal), undefined);
    assert.equal(transitions.observe({ ...terminal, name: "poc" }), undefined);
    assert.equal(transitions.observe({ ...terminal, name: "poc", statusLabel: "running" }), undefined);
    assert.equal(transitions.observe({ ...terminal, name: "poc" })?.type, type);
  }
});

test("each newly discovered run establishes a quiet baseline, including waiting and terminal states", () => {
  const transitions = new Transitions();
  for (const statusLabel of ["waiting", "succeeded", "failed", "aborted"]) {
    const first = { ...run, dagRunId: `initial-${statusLabel}`, statusLabel };
    assert.equal(transitions.observe(first), undefined);
    assert.equal(transitions.observe(first), undefined);
    assert.equal(transitions.observe({ ...first, statusLabel: "running" }), undefined);
    assert.ok(transitions.observe(first));
    assert.equal(transitions.observe(first), undefined);
  }
});

test("a waiting REST summary gains its initial step quietly, then reports a real gate change", () => {
  const transitions = new Transitions();
  const waiting = { ...run, statusLabel: "waiting" };
  const { nodes: _nodes, ...summary } = waiting;
  assert.equal(transitions.observe(summary), undefined);
  assert.equal(transitions.observe(waiting), undefined);
  assert.equal(transitions.observe(waiting), undefined);
  assert.equal(transitions.observe({ ...waiting, nodes: [{ step: { name: "merge" }, statusLabel: "waiting" }] })?.message,
    "dagu · feature #157 waiting · merge");
  assert.equal(transitions.observe({ ...waiting, statusLabel: "succeeded" })?.message, "dagu · feature #157 succeeded");
});
