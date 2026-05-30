import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { currentStep, renderOffline, renderRun, renderWidget, runBundleState, runLabel, Transitions } from "../src/status/progress.ts";
import { resolveRunPrimary } from "../src/run-primary.ts";
import type { RunDetails } from "../src/status/progress.ts";

const labels = ["workspace=a4s", `dagu-feature-bundle=${BUNDLE_VERSION}`];
const run: RunDetails = {
  name: "feature", dagRunId: "a4s-issue-157", statusLabel: "running", params: "ISSUE=157 PRIMARY=/tmp/a4s",
  labels,
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
    ["feature", ["triage", "implement", "dependency_review", "conflict_review", "await_ci", "await_merge", "start_primary_unavailable", "close_primary_unavailable", "recover_start_gate", "recover_gate", "recover_push"]],
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
  for (const name of ["feature", "poc", "discovery", "planning"]) {
    const transitions = new Transitions("session-a");
    const terminal = { ...waitingAt(name, "done"), statusLabel: "succeeded", nodes: [] };
    assert.ok(transitions.observe(terminal).wakeMessage?.includes("status=succeeded"));
    assert.deepEqual(transitions.observe(terminal), {});
    assert.deepEqual(new Transitions("other").observe(terminal), {});
  }
});

test("terminal toasts and targeted failure notices remain deduplicated", () => {
  for (const name of ["feature", "discovery", "planning"]) for (const statusLabel of ["succeeded", "failed", "aborted"]) {
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
    candidate.nodes!.unshift({
      step: { id: step, name: `${step} display name` }, statusLabel: "failed",
      error: "exit status 1\nrecent stderr (tail):\ncontext before rule\nrule=head expected=abc observed=def\nrule=later expected=x observed=y",
    });
    const message = transitions.observe(candidate).wakeMessage!;
    assert.ok(message.includes(`step=recover_${step} issue=176`), message);
    assert.ok(message.endsWith("iteration=2 cause=rule=head expected=abc observed=def"), message);
    assert.deepEqual(transitions.observe(candidate), {});
    const repaired = waitingAt("feature", "implement", 3);
    assert.ok(transitions.observe(repaired).wakeMessage?.includes("step=implement"));
  });
}

for (const tail of [
  ["context\nrule=head expected=abc observed=def\nrule=later expected=x observed=y", "rule=head expected=abc observed=def"],
  ["\npermission denied\u001b\nmore detail", "permission denied "],
  ["", undefined],
] as const) {
  test(`recovery and terminal notices select stderr cause ${JSON.stringify(tail[1])}`, () => {
    const failed = { step: { name: "push" }, statusLabel: "failed", error: `exit status 1\nrecent stderr (tail):\n${tail[0]}` };
    for (const terminal of [false, true]) {
      const candidate = waitingAt("feature", "recover_push");
      candidate.nodes![0]!.step.humanTask = { prompt: "Static prompt is not a failure cause." };
      candidate.nodes = terminal ? [failed] : [failed, ...candidate.nodes!];
      if (terminal) candidate.statusLabel = "failed";
      const message = new Transitions("session-a").observe(candidate).wakeMessage!;
      if (tail[1]) assert.ok(message.endsWith(`cause=${tail[1]}`), message);
      else assert.ok(!message.includes("cause="), message);
      assert.ok(!message.includes("Static prompt"), message);
    }
  });
}

test("bundle compatibility remains visible in targeted notices", () => {
  const candidate = { ...waitingAt("feature", "implement"), labels: ["dagu-feature-bundle=0.2.0"] };
  assert.ok(new Transitions("session-a").observe(candidate).wakeMessage?.includes("compat=incompatible"));
});

test("notices distinguish release pending from restart pending and refresh the installed plugin link", () => {
  const primary = mkdtempSync(join(tmpdir(), "omp-dagu-main-"));
  const manifest = join(primary, "packages/issue-lifecycle/package.json");
  const plugin = join(homedir(), ".omp/plugins/node_modules/@a4s/issue-lifecycle");
  // The test preload gives each test-file process its own HOME.
  assert.equal(homedir(), process.env.DAGU_HOME);
  mkdirSync(join(primary, "packages/issue-lifecycle"), { recursive: true });
  mkdirSync(join(plugin, ".."), { recursive: true });
  const transitions = new Transitions("session-a", "0.7.4");
  const candidate = {
    ...waitingAt("feature", "implement"),
    params: "ISSUE=176 OMP_SESSION_ID=session-a",
    resolvedPrimary: primary,
    labels: ["dagu-feature-bundle=0.7.4"],
  };
  const install = (version: string): void => {
    const release = join(primary, version);
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "package.json"), JSON.stringify({ name: "@a4s/issue-lifecycle", version }));
    rmSync(plugin, { force: true });
    symlinkSync(release, plugin, "dir");
  };
  try {
    writeFileSync(manifest, JSON.stringify({ version: "0.7.7" }));
    install("0.7.4");
    const releasePending = transitions.observe(candidate);
    assert.match(releasePending.wakeMessage!, /extension=0\.7\.4 main=0\.7\.7 compat=ok installed=0\.7\.4/);
    assert.equal(releasePending.warningMessage, undefined);
    assert.equal(runBundleState(candidate, "0.7.4").restartPending, false);
    assert.deepEqual(transitions.observe(candidate), {});

    install("0.7.7");
    candidate.nodes![0]!.approvalIteration = 1;
    const restartPending = transitions.observe(candidate);
    assert.match(restartPending.wakeMessage!, /extension=0\.7\.4 main=0\.7\.7 compat=stale installed=0\.7\.7/);
    assert.match(restartPending.warningMessage!, /^Restart OMP/);
    assert.equal(runBundleState(candidate, "0.7.4").restartPending, true);
    assert.deepEqual(transitions.observe(candidate), {});

    // One warning per new notice batch, regardless of the primary's version.
    writeFileSync(manifest, JSON.stringify({ version: "0.7.4" }));
    candidate.nodes = [...waitingAt("feature", "triage").nodes!, ...waitingAt("feature", "implement", 2).nodes!];
    const batch = transitions.observe(candidate);
    assert.equal(batch.wakeMessages?.length, 2);
    assert.match(batch.warningMessage!, /^Restart OMP/);
    assert.deepEqual(transitions.observe(candidate), {});

    rmSync(manifest);
    candidate.nodes = waitingAt("feature", "implement", 3).nodes!;
    const consumer = transitions.observe(candidate);
    assert.match(consumer.wakeMessage!, /main=n\/a compat=stale installed=0\.7\.7/);
    assert.match(consumer.warningMessage!, /^Restart OMP/);

    install("0.7.3");
    candidate.nodes = waitingAt("feature", "implement", 4).nodes!;
    assert.equal(transitions.observe(candidate).warningMessage, undefined, "an older installed release cannot fix the loaded version");
    writeFileSync(join(plugin, "package.json"), "{");
    candidate.nodes![0]!.approvalIteration = 5;
    const unknown = transitions.observe(candidate);
    assert.match(unknown.wakeMessage!, /installed=unknown/);
    assert.equal(unknown.warningMessage, undefined, "an unreadable installed version is not evidence a restart helps");
  } finally {
    rmSync(plugin, { force: true });
    rmSync(primary, { recursive: true, force: true });
  }
});

for (const scenario of [
  "consumer equal", "consumer patch", "consumer minor", "consumer major", "consumer unstamped",
  "all equal", "primary patch", "primary minor", "primary unstamped", "main mismatch",
  "invalid JSON", "unreadable manifest", "invalid version", "missing version",
] as const) {
  test(`notices classify ${scenario} without treating main drift as restart pending`, () => {
    const primary = mkdtempSync(join(tmpdir(), "omp-dagu-compat-"));
    const manifest = join(primary, "packages/issue-lifecycle/package.json");
    const consumer = scenario.startsWith("consumer");
    const stale = ["main mismatch", "invalid JSON", "unreadable manifest", "invalid version", "missing version"].includes(scenario);
    const [major, minor, patch] = BUNDLE_VERSION.split(".").map(Number);
    const version = scenario.endsWith("patch") ? `${major}.${minor}.${patch! + 1}`
      : scenario.endsWith("minor") ? `${major}.${minor! + 1}.0`
      : scenario.endsWith("major") ? `${major! + 1}.${minor}.0`
      : scenario.endsWith("unstamped") ? undefined : BUNDLE_VERSION;
    const mainVersion = consumer ? "n/a" : scenario === "main mismatch" ? "0.3.8"
      : stale ? "unknown" : BUNDLE_VERSION;
    const compat = version === undefined ? "unstamped"
      : scenario.endsWith("minor") || scenario.endsWith("major") ? "incompatible" : "ok";
    try {
      if (!consumer) {
        mkdirSync(join(primary, "packages/issue-lifecycle"), { recursive: true });
        if (scenario === "unreadable manifest") mkdirSync(manifest);
        else writeFileSync(manifest, scenario === "invalid JSON" ? "{"
          : scenario === "missing version" ? "{}"
          : JSON.stringify({ version: scenario === "invalid version" ? "n/a" : mainVersion }));
      }
      const candidate = {
        ...waitingAt("feature", "implement"),
        params: `ISSUE=176 OMP_SESSION_ID=session-a PRIMARY=${primary}`,
        labels: version === undefined ? [] : [`dagu-feature-bundle=${version}`],
      };
      const transitions = new Transitions("session-a");
      const effects = transitions.observe(candidate);
      assert.ok(effects.wakeMessage?.includes(`bundle=${version ?? "unstamped"} extension=${BUNDLE_VERSION} main=${mainVersion} compat=${compat}`), effects.wakeMessage ?? "Expected a waiting notice");
      assert.equal(effects.warningMessage, undefined);
      assert.deepEqual(transitions.observe(candidate), {});
    } finally {
      rmSync(primary, { recursive: true, force: true });
    }
  });
}

test("rewound PoC notice includes the first scope failure diagnostic", () => {
  const effects = new Transitions("owner").observe({
    name: "poc", dagRunId: "scope-retry", statusLabel: "waiting",
    params: "OMP_SESSION_ID=owner", labels,
    scopeFailureCause: "## Pregunta differs from QUESTION (normalized)",
    nodes: [{ step: { name: "run_poc", humanTask: {} }, statusLabel: "waiting", approvalIteration: 1 }],
  });
  assert.match(effects.wakeMessage!, /iteration=1 cause=## Pregunta differs from QUESTION \(normalized\)$/);
});

test("planning renders plan workflow and wakes its owner at each human checkpoint", () => {
  const transitions = new Transitions("session-a");
  for (const step of ["plan", "review", "approve"]) {
    const candidate = { ...waitingAt("planning", step), params: "OMP_SESSION_ID=session-a" };
    assert.match(renderRun(candidate), new RegExp(`^plan .* ${step} waiting$`));
    assert.match(transitions.observe(candidate).wakeMessage!, new RegExp(`step=${step} dag=planning`));
    assert.deepEqual(transitions.observe(candidate), {});
  }
});

test("validation notice carries the operator procedure, SHA and iteration-bound commands", () => {
  const sha = "a".repeat(40);
  const transitions = new Transitions("session-a");
  const waiting: RunDetails = {
    ...run, statusLabel: "waiting", dagRunId: "repo-validation",
    params: "ISSUE=276 PRIMARY=/repo OMP_SESSION_ID=session-a",
    nodes: [{
      step: { id: "validation", name: "validation", humanTask: {
        prompt: `Repository: /repo\nRun: repo-validation; step: validation\nTested SHA: ${sha}\nRepository procedure:\nRun isolated smoke`,
      } },
      statusLabel: "waiting", approvalIteration: 3,
    }],
  };
  const notice = transitions.observe(waiting).wakeMessage!;
  assert.match(notice, /run=repo-validation status=waiting step=validation/);
  assert.match(notice, /repo=a4s/);
  assert.ok(notice.includes(`Tested SHA: ${sha}`));
  assert.match(notice, /Repository procedure:\nRun isolated smoke/);
  assert.ok(notice.includes(`dagu human-task complete feature --run-id 'repo-validation' --step validation --input APPROVED=yes --input TESTED_SHA='${sha}'`));
  assert.ok(notice.includes("--expected-iteration 3 --input REASON='<operator reason>'"));
  assert.equal(transitions.observe(waiting).wakeMessage, undefined);
});

test("integration protection is shown to the owning session, including the silent baseline, and again when held runs change", () => {
  const transitions = new Transitions("session-a");
  const candidate: RunDetails = {
    ...run, dagRunId: "owned-run", params: "ISSUE=290 OMP_SESSION_ID=session-a", statusLabel: "running",
    nodes: [{ step: { name: "gate" }, statusLabel: "running" }],
  };
  const protection = { protectedRun: "feature-290", issue: "290", held: ["feature-548"], recordedAt: "2026-10-25T00:00:00.000Z" };
  const first = transitions.observe(candidate, { baseline: true, integrationProtection: protection }).wakeMessage;
  assert.match(first ?? "", /\[DAGU STATE\] integration-protection protected_run=feature-290 issue=290 held=feature-548/);
  assert.equal(transitions.observe(candidate, { integrationProtection: protection }).wakeMessage, undefined);
  const changed = transitions.observe(candidate, { integrationProtection: { ...protection, held: [] } }).wakeMessage;
  assert.match(changed ?? "", /held=none/);
  assert.equal(new Transitions("other").observe(candidate, { integrationProtection: protection }).wakeMessage, undefined);
});

test("runtime primary resolves the enqueued adoption spec including spaces and Unicode", async t => {
  const primary = "/tmp/Repo con espacio/ñ";
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "http://dagu/api/v1/dag-runs/feature/run-274/spec");
    return new Response(JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(primary)}\n` }));
  });
  assert.equal(await resolveRunPrimary("http://dagu", { ...run, dagRunId: "run-274", params: "ISSUE=274" }, new AbortController().signal), primary);
  assert.equal(await resolveRunPrimary("http://dagu", run, new AbortController().signal), "/tmp/a4s");
  assert.equal(fetch.mock.callCount(), 1);
});

test("runtime primary resolves the enqueued host binding through its workspace mapping", async t => {
  const home = mkdtempSync(join(tmpdir(), "run-primary-"));
  const primary = join(home, "Repo con espacio", "ñ");
  const previous = { DAGU_HOME: process.env.DAGU_HOME, A4S_PRIMARY: process.env.A4S_PRIMARY };
  process.env.DAGU_HOME = home;
  process.env.A4S_PRIMARY = join(home, "fallback");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(join(home, "primaries"));
  writeFileSync(join(home, "primaries", "a4s"), `${primary}\n`);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    spec: 'env:\n  - PRIMARY: "${A4S_PRIMARY}"\nlabels:\n  - workspace=a4s\n',
  })));
  assert.equal(await resolveRunPrimary("http://dagu", { ...run, params: "ISSUE=623" }, new AbortController().signal), primary);
  assert.equal(await resolveRunPrimary("http://dagu", { ...run, resolvedPrimary: "/recorded/primary" }, new AbortController().signal), "/recorded/primary");
});

for (const statusLabel of ["succeeded", "failed", "aborted"]) {
  test(`${statusLabel} terminal notices work as the first snapshot and never replay stale waiting nodes`, () => {
    const terminal = { ...waitingAt("poc", "old-task"), statusLabel };
    const effects = new Transitions("session-a").observe(terminal);
    assert.match(effects.wakeMessage!, new RegExp(`status=${statusLabel}\\b`));
    assert.equal(effects.wakeMessages, undefined, "stale waiting nodes cannot add checkpoint wakes");
    const transitions = new Transitions("session-a");
    assert.equal(transitions.observe(terminal, { baseline: true }).wakeMessage, undefined);
    assert.deepEqual(transitions.observe(terminal), {}, "a startup terminal stays silent");
    assert.equal(new Transitions("other").observe(terminal).wakeMessage, undefined);
  });

  test(`widget-only observations produce a ${statusLabel} toast but no duplicate owner wake`, () => {
    const transitions = new Transitions("session-a");
    transitions.observe(waitingAt("feature", "gate"), { checkpoints: false });
    const effects = transitions.observe({
      ...waitingAt("feature", "gate"), statusLabel, nodes: [{ step: { name: "gate" }, statusLabel }],
    }, { checkpoints: false });
    assert.ok(effects.notification?.message.endsWith(statusLabel));
    assert.equal(effects.wakeMessage, undefined);
    assert.equal(effects.wakeMessages, undefined);
  });
}
