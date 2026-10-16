import assert from "node:assert/strict";
import test from "node:test";
import { currentStep, renderRun, runLabel, Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";

const run: RunDetails = {
  name: "feature", dagRunId: "a4s-issue-157", statusLabel: "running", params: "ISSUE=157 PRIMARY=/tmp/a4s",
  labels: ["workspace=a4s", "dagu-feature-bundle=0.3.1"],
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
  assert.equal(renderRun({ name: "poc", dagRunId: "run-1", statusLabel: "queued" }), "dagu · poc run-1 ▱▱▱▱▱▱ 0/0 queued · bundle=unstamped extension=0.3.1 compat=unstamped");
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
const terminalAt = (
  statusLabel: "succeeded" | "failed" | "aborted",
  step: string,
  params = "ISSUE=176 OMP_SESSION_ID=session-a",
  name = "feature",
): RunDetails => ({
  ...run,
  name,
  dagRunId: `${name}-${statusLabel}`,
  params,
  statusLabel,
  nodes: [
    { step: { name: "triage" }, statusLabel: "succeeded" },
    { step: { name: step }, statusLabel },
  ],
});


test("waiting transitions have no toast and terminal toasts remain deduplicated", () => {
  const transitions = new Transitions();
  assert.deepEqual(transitions.observe(run), {});
  const waiting = { ...run, statusLabel: "waiting" };
  assert.deepEqual(transitions.observe(waiting, { slug: "improve-widget" }), {});
  assert.deepEqual(transitions.observe(waiting), {});
  assert.deepEqual(transitions.observe(run), {});
  assert.deepEqual(transitions.observe(waiting), {});
  assert.deepEqual(
    transitions.observe({ ...waiting, nodes: [{ step: { name: "merge" }, statusLabel: "waiting" }] }),
    {},
  );
  for (const [statusLabel, type] of [["succeeded", "info"], ["failed", "error"], ["aborted", "warning"]] as const) {
    const terminal = terminalAt(statusLabel, "gate");
    assert.deepEqual(transitions.observe({
      ...terminal,
      statusLabel: "running",
      nodes: [{ step: { name: "gate" }, statusLabel: "running" }],
    }), {});
    assert.deepEqual(transitions.observe(terminal).notification, {
      message: `dagu · feature #176 ${statusLabel}`,
      type,
    });
    assert.deepEqual(transitions.observe(terminal), {});
  }
});

test("targeted waiting notices accept CLI and JSON params and reject other sessions", () => {
  for (const params of [
    "ISSUE=176 PRIMARY=/tmp OMP_SESSION_ID=session-a",
    '{"ISSUE":"176","OMP_SESSION_ID":"session-a"}',
  ]) {
    const transitions = new Transitions("session-a");
    assert.equal(
      transitions.observe(waitingAt("triage", params)).wakeMessage,
      "[DAGU STATE] run=feature-triage status=waiting step=triage issue=176 bundle=0.3.1 extension=0.3.1 compat=ok",
    );
  }
  for (const params of [
    "ISSUE=176 OMP_SESSION_ID=session-b",
    '{"ISSUE":176,"OMP_SESSION_ID":"session-b"}',
  ]) {
    assert.equal(new Transitions("session-a").observe(waitingAt("triage", params)).wakeMessage, undefined);
  }
});

test("targeted waiting notices are limited to feature triage and implement in a main session", () => {
  for (const step of ["triage", "implement"]) {
    const effect = new Transitions("session-a").observe(waitingAt(step));
    assert.deepEqual(effect, {
      wakeMessage: `[DAGU STATE] run=feature-${step} status=waiting step=${step} issue=176 bundle=0.3.1 extension=0.3.1 compat=ok`,
    });
  }
  assert.equal(new Transitions("session-a").observe(waitingAt("dependency_review")).wakeMessage, undefined);
  assert.equal(new Transitions("session-a").observe(waitingAt("triage", undefined, "poc")).wakeMessage, undefined);
  assert.equal(new Transitions().observe(waitingAt("triage")).wakeMessage, undefined);
});

test("targeted discovery checkpoints wake once per waiting entry", () => {
  for (const step of ["discover", "validate", "consolidate", "approve"]) {
    const transitions = new Transitions("session-a");
    const waiting = waitingAt(step, "OMP_SESSION_ID=session-a", "discovery");
    assert.deepEqual(transitions.observe(waiting), {
      wakeMessage: `[DAGU STATE] run=discovery-${step} status=waiting step=${step} dag=discovery bundle=0.3.1 extension=0.3.1 compat=ok`,
    });
    assert.deepEqual(transitions.observe(waiting), {});
  }
});

test("discovery waiting notices reject other sessions and non-checkpoint steps", () => {
  assert.equal(
    new Transitions("session-a")
      .observe(waitingAt("discover", "OMP_SESSION_ID=session-b", "discovery")).wakeMessage,
    undefined,
  );
  assert.equal(
    new Transitions("session-a")
      .observe(waitingAt("snapshot", "OMP_SESSION_ID=session-a", "discovery")).wakeMessage,
    undefined,
  );
});

test("targeted discovery failures and aborts wake with the DAG identity", () => {
  for (const statusLabel of ["failed", "aborted"] as const) {
    const transitions = new Transitions("session-a");
    const terminal = terminalAt(statusLabel, "check_units", "OMP_SESSION_ID=session-a", "discovery");
    transitions.observe({
      ...terminal,
      statusLabel: "running",
      nodes: [{ step: { name: "check_units" }, statusLabel: "running" }],
    });
    assert.equal(
      transitions.observe(terminal).wakeMessage,
      `[DAGU STATE] run=discovery-${statusLabel} status=${statusLabel} step=check_units dag=discovery bundle=0.3.1 extension=0.3.1 compat=ok`,
    );
    assert.deepEqual(transitions.observe(terminal), {});
  }
});

test("targeted terminal notices report failed and aborted steps exactly once", () => {
  for (const statusLabel of ["failed", "aborted"] as const) {
    const transitions = new Transitions("session-a");
    const terminal = terminalAt(statusLabel, statusLabel === "failed" ? "gate" : "close_gate");
    assert.deepEqual(transitions.observe({
      ...terminal,
      statusLabel: "running",
      nodes: [{ step: { name: terminal.nodes![1]!.step.name }, statusLabel: "running" }],
    }), {});
    const effect = transitions.observe(terminal);
    assert.equal(
      effect.wakeMessage,
      `[DAGU STATE] run=feature-${statusLabel} status=${statusLabel} step=${terminal.nodes![1]!.step.name} issue=176 bundle=0.3.1 extension=0.3.1 compat=ok`,
    );
    assert.ok(effect.notification);
    assert.deepEqual(transitions.observe(terminal), {});
  }
});

test("terminal notices reject other sessions and other DAGs while preserving terminal toasts", () => {
  for (const [params, name] of [
    ["ISSUE=176 OMP_SESSION_ID=session-b", "feature"],
    ["ISSUE=176 OMP_SESSION_ID=session-a", "poc"],
  ]) {
    for (const statusLabel of ["failed", "aborted"] as const) {
      const transitions = new Transitions("session-a");
      const terminal = terminalAt(statusLabel, "gate", params, name);
      transitions.observe({
        ...terminal,
        statusLabel: "running",
        nodes: [{ step: { name: "gate" }, statusLabel: "running" }],
      });
      const effect = transitions.observe(terminal);
      assert.equal(effect.wakeMessage, undefined);
      assert.ok(effect.notification);
    }
  }
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

test("widget and DAGU STATE notice report ok, incompatible and unstamped bundle states", () => {
  for (const [labels, display, compat, widgetSuffix] of [
    [[`dagu-feature-bundle=0.3.9`], "0.3.9", "ok", ""],
    [[`dagu-feature-bundle=0.2.0`], "0.2.0", "incompatible",
      " · bundle=0.2.0 extension=0.3.1 compat=incompatible"],
    [undefined, "unstamped", "unstamped",
      " · bundle=unstamped extension=0.3.1 compat=unstamped"],
  ] as const) {
    const candidate = waitingAt("implement");
    if (labels) candidate.labels = [...labels];
    else delete candidate.labels;
    assert.equal(
      renderRun(candidate),
      `dagu · feature #176 ▱▱▱▱▱▱ 0/1 implement waiting${widgetSuffix}`,
    );
    assert.equal(
      new Transitions("session-a").observe(candidate).wakeMessage,
      `[DAGU STATE] run=feature-implement status=waiting step=implement issue=176 bundle=${display} extension=0.3.1 compat=${compat}`,
    );
  }
});

for (const [name, step] of [
  ["feature", "start_primary_unavailable"],
  ["feature", "close_primary_unavailable"],
  ["poc", "base_primary_unavailable"],
] as const) {
  test(`${name} ${step} wakes only its owner with the resolved cause`, () => {
    const waiting: RunDetails = {
      ...run, name, statusLabel: "waiting", params: "ISSUE=228 OMP_SESSION_ID=owner",
      nodes: [{
        statusLabel: "waiting",
        step: { id: step, name: step, humanTask: { prompt: "primary dirty:  M tracked.txt\nRestore clean main; push back." } },
      }],
    };
    const transitions = new Transitions("owner");
    const message = transitions.observe(waiting).wakeMessage!;
    assert.match(message, /^\[DAGU STATE\] run=a4s-issue-157 status=waiting step=/);
    assert.ok(message.includes(`step=${step} issue=228 bundle=0.3.1`));
    assert.ok(message.includes("cause=primary dirty:  M tracked.txt Restore clean main; push back."));
    assert.deepEqual(transitions.observe(waiting), {});
    assert.deepEqual(new Transitions("another-owner").observe(waiting), {});
    assert.deepEqual(new Transitions().observe(waiting), {});
    transitions.observe({ ...waiting, statusLabel: "queued" });
    assert.ok(transitions.observe(waiting).wakeMessage, "a repeated unavailable recheck wakes again");
    assert.deepEqual(new Transitions("owner").observe(waiting, { baseline: true }), {});
  });
}
