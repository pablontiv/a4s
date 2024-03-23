import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { currentStep, renderOffline, renderRun, renderWidget, runLabel, Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";

const labels = ["workspace=a4s", "dagu-feature-bundle=0.3.1"];
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

test("progress counts succeeded/skipped and renders the abbreviated workflow, identity and current step", () => {
  assert.equal(renderRun(run), "feat #157 ▰▰▱▱▱▱ 2/5 gate running");
  assert.equal(renderRun(run, "improve-widget"), "feat #157 improve-widget ▰▰▱▱▱▱ 2/5 gate running");
  assert.equal(currentStep({ ...run, statusLabel: "waiting" }), "approve");
  assert.equal(renderRun({ ...run, statusLabel: "waiting" }), "feat #157 ▰▰▱▱▱▱ 2/5 approve waiting");
  assert.equal(
    renderRun(run, undefined, "> npm test"),
    "feat #157 ▰▰▱▱▱▱ 2/5 gate running · > npm test",
  );
  assert.equal(currentStep({ ...run, nodes: [run.nodes![3]!] }), "approve");
});

test("queued summaries and empty DAGs render zero progress and fall back to run ID", () => {
  assert.equal(renderRun({ name: "poc", dagRunId: "run-1", statusLabel: "queued" }), "poc run-1 ▱▱▱▱▱▱ 0/0 queued");
  assert.equal(renderRun({ ...run, nodes: [] }), "feat #157 ▱▱▱▱▱▱ 0/0 running");
  assert.equal(renderRun({ ...run, nodes: [{ step: { name: "done" }, statusLabel: "succeeded" }] }), "feat #157 ▰▰▰▰▰▰ 1/1 running");
});

// Markup stub: keeps the HUD layout visible in plain assertions.
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
  tree: { branch: "├─", last: "└─" },
};

test("widget folds like OMP HUDs, ordering runs closest to completion first and keeping discovery order on ties", () => {
  const at = (issue: number, done: number, total: number): RunDetails => ({
    ...run,
    dagRunId: `run-${issue}`,
    params: `ISSUE=${issue}`,
    nodes: Array.from({ length: total }, (_, index) => ({
      step: { name: `s${index}` },
      statusLabel: index < done ? "succeeded" : index === done ? "running" : "pending",
    })),
  });
  const entries = [
    { run: at(1, 1, 4) },
    { run: { name: "poc", dagRunId: "queued", statusLabel: "queued", labels } },
    { run: at(2, 3, 4), slug: "almost" },
    { run: at(3, 2, 8) },
    { run: at(4, 4, 5) },
  ];
  const rows = [
    "feat #4 ▰▰▰▰▱▱ 4/5 s4 running",
    "feat #2 almost ▰▰▰▰▱▱ 3/4 s3 running",
    "feat #1 ▰▱▱▱▱▱ 1/4 s1 running",
    "feat #3 ▰▱▱▱▱▱ 2/8 s2 running",
    "poc queued ▱▱▱▱▱▱ 0/0 queued",
  ];
  const title = "<b><accent>Workflows</accent></b>";
  assert.deepEqual(renderWidget(entries, theme), [
    title,
    ` <dim>├─</dim> ${rows[0]}`,
    ` <dim>├─</dim> ${rows[1]}`,
    ` <dim>└─</dim> ${rows[2]}`,
    " <dim>… 2 more — /workflows</dim>",
  ]);
  assert.deepEqual(renderWidget(entries, theme, true), [
    title,
    ...rows.slice(0, -1).map(row => ` <dim>├─</dim> ${row}`),
    ` <dim>└─</dim> ${rows.at(-1)}`,
    " <dim>… show less — /workflows</dim>",
  ]);
  // Ten runs exceed OMP's 10-line widget budget: the expanded fold still reports the rest.
  const many = Array.from({ length: 10 }, (_, index) => ({ run: at(index + 10, 1, 2) }));
  const expanded = renderWidget(many, theme, true)!;
  assert.equal(expanded.length, 10);
  assert.equal(expanded.at(-1), " <dim>… 2 more · show less — /workflows</dim>");
  assert.deepEqual(renderWidget(entries.slice(0, 2), theme), [title, ` <dim>├─</dim> ${rows[2]}`, ` <dim>└─</dim> ${rows[4]}`]);
  assert.equal(renderWidget([], theme), undefined);
  assert.deepEqual(renderOffline(theme, 4), [title, " <dim>└─</dim> sin conexión · reintentando en 4s"]);
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

const waitingAt = (name: string, step: string, iteration = 0): RunDetails => ({
  ...run, name, dagRunId: "owned-run", params: "ISSUE=176 OMP_SESSION_ID=session-a",
  statusLabel: "waiting",
  nodes: [{ step: { id: step, name: step, humanTask: {} }, statusLabel: "waiting", approvalIteration: iteration }],
});

test("all human checkpoints wake the owner once per DAG, run, step and iteration", () => {
  const transitions = new Transitions("session-a");
  for (const [name, steps] of [
    ["feature", ["triage", "implement", "dependency_review", "conflict_review", "await_merge", "start_primary_unavailable", "close_primary_unavailable", "recover_start_gate", "recover_gate", "recover_push"]],
    ["poc", ["run_poc", "decide", "base_primary_unavailable"]],
    ["discovery", ["discover", "validate", "consolidate", "approve"]],
  ] as const) {
    for (const step of steps) for (const iteration of [0, 1]) {
      const candidate = waitingAt(name, step, iteration);
      const message = transitions.observe(candidate).wakeMessage!;
      assert.ok(message.includes(`step=${step} issue=176`), message);
      assert.ok(message.endsWith(`iteration=${iteration}`), message);
      assert.deepEqual(transitions.observe(candidate), {});
    }
  }
  assert.ok(transitions.observe({ ...waitingAt("feature", "triage"), dagRunId: "another-run" }).wakeMessage);
});

test("waiting nodes wake while the global run is running, including parallel human tasks", () => {
  const a = waitingAt("poc", "a");
  const b = waitingAt("poc", "b");
  const effects = new Transitions("session-a").observe({
    ...a, statusLabel: "running", nodes: [...a.nodes!, ...b.nodes!],
  });
  assert.equal(effects.wakeMessages?.length, 2);
  assert.ok(effects.wakeMessages?.[0]?.includes("step=a"));
  assert.ok(effects.wakeMessages?.[1]?.includes("step=b"));
});

test("omitted approval iteration is zero and logical replays preserve deduplication", () => {
  const transitions = new Transitions("session-a");
  const candidate = waitingAt("feature", "triage");
  delete candidate.nodes![0]!.approvalIteration;
  assert.ok(transitions.observe(candidate).wakeMessage?.endsWith("iteration=0"));
  transitions.observe({ ...candidate, statusLabel: "running", nodes: [] });
  assert.deepEqual(transitions.observe(waitingAt("feature", "triage", 0)), {});
  assert.ok(transitions.observe(waitingAt("feature", "triage", 1)).wakeMessage);
});

test("CLI and JSON ownership target only the matching main session", () => {
  for (const params of ["OMP_SESSION_ID=session-a", '{"OMP_SESSION_ID":"session-a"}']) {
    const candidate = { ...waitingAt("discovery", "discover"), params };
    assert.ok(new Transitions("session-a").observe(candidate).wakeMessage?.includes("dag=discovery"));
    assert.deepEqual(new Transitions("session-b").observe(candidate), {});
    assert.deepEqual(new Transitions().observe(candidate), {});
  }
});

test("startup baseline marks existing openings silently and subsequent iterations wake", () => {
  const transitions = new Transitions("session-a");
  assert.deepEqual(transitions.observe(waitingAt("feature", "triage"), { baseline: true }), {});
  assert.deepEqual(transitions.observe(waitingAt("feature", "triage")), {});
  assert.ok(transitions.observe(waitingAt("feature", "triage", 1)).wakeMessage);
});

test("succeeded wakes each owner once even when the terminal is the first durable snapshot", () => {
  for (const name of ["feature", "poc", "discovery"]) {
    const transitions = new Transitions("session-a");
    const terminal = { ...waitingAt(name, "done"), statusLabel: "succeeded", nodes: [] };
    assert.ok(transitions.observe(terminal).wakeMessage?.includes("status=succeeded"));
    assert.deepEqual(transitions.observe(terminal), {});
    assert.deepEqual(new Transitions("other").observe(terminal), {});
  }
});

test("terminal toasts and targeted feature/discovery failure notices remain deduplicated", () => {
  for (const name of ["feature", "discovery"]) for (const statusLabel of ["succeeded", "failed", "aborted"]) {
    const transitions = new Transitions("session-a");
    const candidate = waitingAt(name, "gate");
    transitions.observe({ ...candidate, statusLabel: "running", nodes: [] });
    const effects = transitions.observe({ ...candidate, statusLabel, nodes: [{ step: { name: "gate" }, statusLabel }] });
    assert.ok(effects.notification?.message.endsWith(statusLabel));
    assert.ok(effects.wakeMessage?.includes(`status=${statusLabel}`));
    assert.deepEqual(transitions.observe({ ...candidate, statusLabel, nodes: [] }), {});
  }
});

test("primary availability notices preserve the concrete sanitized cause", () => {
  const candidate = waitingAt("poc", "base_primary_unavailable");
  candidate.nodes![0]!.step.humanTask = { prompt: "primary dirty: tracked.txt\nRestore clean main." };
  assert.ok(new Transitions("session-a").observe(candidate).wakeMessage?.includes("cause=primary dirty: tracked.txt Restore clean main."));
});

for (const step of ["start_gate", "gate", "push"]) {
  test(`${step} recovery notice names the failed command and sanitized cause`, () => {
    const transitions = new Transitions("session-a");
    const candidate = waitingAt("feature", `recover_${step}`, 2);
    candidate.nodes![0]!.step.humanTask = { prompt: `${step} failed.\nInspect logs.` };
    const message = transitions.observe(candidate).wakeMessage!;
    assert.ok(message.includes(`step=recover_${step} issue=176`), message);
    assert.ok(message.endsWith(`iteration=2 cause=${step} failed. Inspect logs.`), message);
    assert.deepEqual(transitions.observe(candidate), {});
    const repaired = waitingAt("feature", "implement", 3);
    assert.ok(transitions.observe(repaired).wakeMessage?.includes("step=implement"));
  });
}

test("bundle compatibility remains visible in targeted notices", () => {
  const candidate = { ...waitingAt("feature", "implement"), labels: ["dagu-feature-bundle=0.2.0"] };
  assert.ok(new Transitions("session-a").observe(candidate).wakeMessage?.includes("compat=incompatible"));
});

test("notices compare extension, bundle and main on each opening and request stale aborts", () => {
  const primary = mkdtempSync(join(tmpdir(), "omp-dagu-main-"));
  const manifest = join(primary, "packages/omp-dagu/package.json");
  mkdirSync(join(primary, "packages/omp-dagu"), { recursive: true });
  const transitions = new Transitions("session-a");
  const candidate = {
    ...waitingAt("feature", "implement"),
    params: `ISSUE=176 OMP_SESSION_ID=session-a PRIMARY=${primary}`,
    labels: [`dagu-feature-bundle=${BUNDLE_VERSION}`],
  };
  try {
    writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
    const equal = transitions.observe(candidate);
    assert.ok(equal.wakeMessage?.includes(`bundle=${BUNDLE_VERSION} extension=${BUNDLE_VERSION} main=${BUNDLE_VERSION} compat=ok`));
    assert.deepEqual(Object.keys(equal), ["wakeMessage"]);
    writeFileSync(manifest, JSON.stringify({ version: "0.3.8" }));
    candidate.nodes![0]!.approvalIteration = 1;
    const staleMain = transitions.observe(candidate);
    assert.ok(staleMain.wakeMessage?.includes(`extension=${BUNDLE_VERSION} main=0.3.8 compat=stale`));
    assert.match(staleMain.abortMessage!, /Restart.*session.*bootstrap re-seal/);
    writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
    candidate.labels = ["dagu-feature-bundle=0.3.8"];
    candidate.nodes![0]!.approvalIteration = 2;
    const staleBundle = transitions.observe(candidate);
    assert.ok(staleBundle.wakeMessage?.includes(`bundle=0.3.8 extension=${BUNDLE_VERSION} main=${BUNDLE_VERSION} compat=stale`));
    assert.match(staleBundle.abortMessage!, /Restart.*session.*bootstrap re-seal/);
  } finally {
    rmSync(primary, { recursive: true, force: true });
  }
});

test("rewound PoC notice includes the first scope failure diagnostic", () => {
  const effects = new Transitions("owner").observe({
    name: "poc", dagRunId: "scope-retry", statusLabel: "waiting",
    params: "OMP_SESSION_ID=owner", labels,
    scopeFailureCause: "## Pregunta differs from QUESTION (normalized)",
    nodes: [{ step: { name: "run_poc", humanTask: {} }, statusLabel: "waiting", approvalIteration: 1 }],
  });
  assert.match(effects.wakeMessage!, /iteration=1 cause=## Pregunta differs from QUESTION \(normalized\)$/);
});
