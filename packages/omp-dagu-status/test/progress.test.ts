import assert from "node:assert/strict";
import test from "node:test";
import { currentStep, renderRun, runLabel, Transitions } from "../src/progress.ts";
import type { RunDetails } from "../src/progress.ts";

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

test("progress counts succeeded/skipped and selects the current running or waiting step", () => {
  assert.equal(renderRun(run), "dagu · #157 ▰▰▱▱▱▱ 2/5 gate running");
  assert.equal(currentStep({ ...run, statusLabel: "waiting" }), "approve");
  assert.equal(renderRun({ ...run, statusLabel: "waiting" }), "dagu · #157 ▰▰▱▱▱▱ 2/5 approve waiting");
  assert.equal(currentStep({ ...run, nodes: [run.nodes![3]!] }), "approve");
});

test("queued summaries and empty DAGs render zero progress and fall back to run ID", () => {
  assert.equal(renderRun({ name: "poc", dagRunId: "run-1", statusLabel: "queued" }), "dagu · run-1 ▱▱▱▱▱▱ 0/0 queued");
  assert.equal(renderRun({ ...run, nodes: [] }), "dagu · #157 ▱▱▱▱▱▱ 0/0 running");
  assert.equal(renderRun({ ...run, nodes: [{ step: { name: "done" }, statusLabel: "succeeded" }] }), "dagu · #157 ▰▰▰▰▰▰ 1/1 running");
});

test("issue extraction supports CLI and JSON params with exact ISSUE boundaries", () => {
  for (const params of ['ISSUE=127', 'PRIMARY=/tmp ISSUE="127" BRANCH=x', '{"ISSUE":"127","PRIMARY":"x"}', '{"ISSUE":127}']) {
    assert.equal(runLabel({ ...run, params }), "#127", params);
  }
  for (const params of ["OTHER_ISSUE=99", "ISSUE=12bad", "ISSUE=", ""]) {
    assert.equal(runLabel({ ...run, params }), run.dagRunId, params);
  }
  assert.equal(runLabel({ ...run, params: "", dagRunId: "run\x1b\n" }), "run  ");
});

test("notifications deduplicate snapshots per run and state, including reconnects and waiting gates", () => {
  const transitions = new Transitions();
  assert.equal(transitions.observe(run), undefined);
  const waiting = { ...run, statusLabel: "waiting" };
  assert.deepEqual(transitions.observe(waiting), { message: "dagu · #157 waiting · approve", type: "warning" });
  assert.equal(transitions.observe(waiting), undefined);
  assert.equal(transitions.observe(run), undefined);
  assert.equal(transitions.observe(waiting)?.type, "warning");
  assert.equal(transitions.observe({ ...waiting, nodes: [{ step: { name: "merge" }, statusLabel: "waiting" }] })?.message, "dagu · #157 waiting · merge");
  for (const [statusLabel, type] of [["succeeded", "info"], ["failed", "error"], ["aborted", "warning"]] as const) {
    const terminal = { ...run, dagRunId: statusLabel, statusLabel };
    assert.equal(transitions.observe({ ...terminal, statusLabel: "running" }), undefined);
    assert.deepEqual(transitions.observe(terminal), { message: `dagu · #157 ${statusLabel}`, type });
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
    "dagu · #157 waiting · merge");
  assert.equal(transitions.observe({ ...waiting, statusLabel: "succeeded" })?.message, "dagu · #157 succeeded");
});
