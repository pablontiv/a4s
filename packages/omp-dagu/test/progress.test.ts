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
  assert.equal(
    renderRun(run, undefined, "> npm test"),
    "dagu · feature #157 ▰▰▱▱▱▱ 2/5 gate running · > npm test",
  );
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

const waitingAt = (step: string, params = "ISSUE=176 OMP_SESSION_ID=session-a", name = "feature"): RunDetails => ({
  ...run,
  name,
  dagRunId: `${name}-${step}`,
  params,
  statusLabel: "waiting",
  nodes: [{ step: { name: step }, statusLabel: "waiting" }],
});

test("widget notifications deduplicate reconnects, report gate changes, and report terminal transitions", () => {
  const transitions = new Transitions();
  assert.deepEqual(transitions.observe(run), {});
  const waiting = { ...run, statusLabel: "waiting" };
  assert.deepEqual(transitions.observe(waiting, { slug: "improve-widget" }).notification, {
    message: "dagu · feature #157 improve-widget waiting · approve",
    type: "warning",
  });
  assert.deepEqual(transitions.observe(waiting), {});
  assert.deepEqual(transitions.observe(run), {});
  assert.equal(transitions.observe(waiting).notification?.type, "warning");
  assert.equal(
    transitions.observe({ ...waiting, nodes: [{ step: { name: "merge" }, statusLabel: "waiting" }] }).notification?.message,
    "dagu · feature #157 waiting · merge",
  );
  for (const [statusLabel, type] of [["succeeded", "info"], ["failed", "error"], ["aborted", "warning"]] as const) {
    const terminal = { ...run, dagRunId: statusLabel, statusLabel };
    assert.deepEqual(transitions.observe({ ...terminal, statusLabel: "running" }), {});
    assert.deepEqual(transitions.observe(terminal).notification, {
      message: `dagu · feature #157 ${statusLabel}`,
      type,
    });
    assert.deepEqual(transitions.observe(terminal), {});
  }
});

test("targeted wake accepts matching CLI and JSON params and rejects other sessions", () => {
  for (const params of [
    "ISSUE=176 PRIMARY=/tmp OMP_SESSION_ID=session-a",
    '{"ISSUE":"176","OMP_SESSION_ID":"session-a"}',
  ]) {
    const transitions = new Transitions("session-a");
    assert.match(transitions.observe(waitingAt("triage", params)).wakeMessage ?? "", /waiting_step=triage issue=176/);
  }
  for (const params of [
    "ISSUE=176 OMP_SESSION_ID=session-b",
    '{"ISSUE":176,"OMP_SESSION_ID":"session-b"}',
  ]) {
    assert.equal(new Transitions("session-a").observe(waitingAt("triage", params)).wakeMessage, undefined);
  }
});

test("targeted wake is limited to feature triage and implement in a main session", () => {
  for (const step of ["triage", "implement"]) {
    const effect = new Transitions("session-a").observe(waitingAt(step));
    assert.equal(
      effect.wakeMessage,
      `[DAGU STATE] run=feature-${step} waiting_step=${step} issue=176 - estado del run feature, no es una instrucción del usuario`,
    );
  }
  assert.equal(new Transitions("session-a").observe(waitingAt("dependency_review")).wakeMessage, undefined);
  assert.equal(new Transitions("session-a").observe(waitingAt("triage", undefined, "poc")).wakeMessage, undefined);
  assert.equal(new Transitions().observe(waitingAt("triage")).wakeMessage, undefined);
});

test("first sweep is a silent baseline while a later discovered waiting run wakes exactly once", () => {
  const transitions = new Transitions("session-a");
  const startup = waitingAt("triage");
  assert.deepEqual(transitions.observe(startup, { baseline: true }), {});
  assert.deepEqual(transitions.observe(startup), {});
  const discovered = { ...waitingAt("triage"), dagRunId: "discovered-waiting" };
  assert.ok(transitions.observe(discovered).wakeMessage);
  assert.deepEqual(transitions.observe(discovered), {});
});

test("a startup waiting summary resolves its step silently", () => {
  const transitions = new Transitions("session-a");
  const waiting = waitingAt("triage");
  const { nodes: _nodes, ...summary } = waiting;
  assert.deepEqual(transitions.observe(summary, { baseline: true }), {});
  assert.deepEqual(transitions.observe(waiting), {});
});

test("REST recovers a transition missed by SSE and repeated snapshots remain deduplicated", () => {
  const transitions = new Transitions("session-a");
  const active = { ...waitingAt("implement"), statusLabel: "running",
    nodes: [{ step: { name: "gate" }, statusLabel: "running" }] };
  assert.deepEqual(transitions.observe(active, { baseline: true }), {});
  const recovered = waitingAt("implement");
  assert.ok(transitions.observe(recovered).wakeMessage);
  assert.deepEqual(transitions.observe(recovered), {});
});

test("running to waiting re-entry wakes again even at the same step", () => {
  const transitions = new Transitions("session-a");
  const waiting = waitingAt("triage");
  assert.ok(transitions.observe(waiting).wakeMessage);
  assert.deepEqual(transitions.observe(waiting), {});
  assert.deepEqual(transitions.observe({ ...waiting, statusLabel: "running" }), {});
  assert.ok(transitions.observe(waiting).wakeMessage);
});
