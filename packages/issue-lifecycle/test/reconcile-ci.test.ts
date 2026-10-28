import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { recordNoProgress } from "../src/ci-no-progress.ts";
import { observeCodeScanning } from "../src/code-scanning.ts";
import { finishRun, inspectRun, type ReconcileRunDependencies } from "../src/reconcile-run.ts";
import { Transitions, type CiDiagnostic, type RunDetails } from "../src/status/progress.ts";
import { readCiDiagnostic, readEscalationDiagnostic } from "../src/status/repository.ts";

const root = mkdtempSync(join(tmpdir(), "a4s-reconcile-unit-"));
const primary = join(root, "primary");
const sha = "a".repeat(40);
const nextSha = "b".repeat(40);
const row = { RUN: "ci226", PRIMARY: "/receipt/primary", ISSUE: "226", BRANCH: "dagu/issue-226", PR_NUMBER: "77", REPO: "example/repo" };
const env = { RUN: row.RUN, PRIMARY: row.PRIMARY, CI_OBSERVATION_ID: "tick-1" };
const withoutLock = <T>(_path: string, body: () => T): T => body();

before(() => {
  mkdirSync(primary);
  // One temporary repository supplies Git's own metadata-path resolution only.
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "ignore" });
});
after(() => rmSync(root, { recursive: true, force: true }));

function statePath(run: string): string {
  const state = join(primary, ".git", "dagu-feature", "runs", run);
  mkdirSync(state, { recursive: true });
  return state;
}
function observation(changes: Partial<CiDiagnostic & { run: string; action: string }> = {}) {
  return { run: "ci226", iteration: 0, sha, class: "BLOCKED", action: "WAIT", check: "validate", log: "Approval required by environment owner", cause: "Unproven cause for validate (CANCELLED)", ...changes };
}
function waiting(run = "ci226", steps = ["await_ci", "await_merge"], iteration = 0): RunDetails {
  return { name: "feature", dagRunId: run, statusLabel: "waiting", params: "ISSUE=226 OMP_SESSION_ID=owner",
    nodes: steps.map(name => ({ step: { name, humanTask: {} }, statusLabel: "waiting", approvalIteration: iteration })) };
}
function inspectFixture(status = "Waiting - fixture\n├─await_ci [waiting]\n│ └─push-back iteration: 3\n", repo = "example/repo") {
  const calls: { command: string; args: string[]; timeout: number | undefined }[] = [];
  const dependencies: ReconcileRunDependencies = {
    env, executingRunArtifact: () => true, now: () => 1000,
    spawnSync(command, args, options) {
      calls.push({ command, args, timeout: options.timeout });
      if (command === "git") return { status: 0, stdout: "git@github.com:example/repo.git\n" };
      if (command === "gh") return { status: 0, stdout: `${repo}\n` };
      assert.equal(command, "dagu");
      return { status: 0, stdout: status };
    },
  };
  return { dependencies, calls, inspect: (changes: Record<string, string> = {}) => inspectRun({ ...row, ...changes }, dependencies) };
}

// The corresponding YAML/compiled/Dagu boundary assertions live in test/live/reconcile-ci.test.ts.
test("waiting checkpoints parse both tree connectors in-process", () => {
  for (const connector of ["├─", "└─"]) {
    for (const checkpoint of ["await_ci", "await_merge"]) {
      const f = inspectFixture(`Waiting - fixture\n${connector}${checkpoint} [waiting]\n│ └─push-back iteration: 3\n`);
      const item = f.inspect();
      assert.equal(item.step, checkpoint);
      assert.equal(item.observation, checkpoint);
      assert.equal(item.iteration, 3);
      assert.equal(item.route, "child");
      assert.equal(item.class, "PENDING");
      assert.equal(item.action, "WAIT");
      assert.equal(item.worktree, join(row.PRIMARY, ".workspace", "worktrees", "issue-226"));
      assert.deepEqual(f.calls, [{ command: "dagu", args: ["status", "feature", "--run-id", "ci226"], timeout: 8000 }]);
      assert.equal(item.skipped, 1);
      assert.equal(item.calls, 1);
    }
  }
});

test("run inspection routes issue checkpoints, unavailable observations and active runs without side effects", () => {
  const lookup = inspectFixture("Waiting - fixture\n├─implement [waiting]\n");
  const issue = lookup.inspect({ REPO: "" });
  assert.equal(issue.route, "issue");
  assert.equal(issue.step, "implement");
  assert.equal(issue.repo, "example/repo");
  assert.equal(issue.skipped, 0);
  assert.equal(issue.calls, 2);
  assert.deepEqual(lookup.calls.map(call => [call.command, call.args]), [
    ["git", ["-C", row.PRIMARY, "remote", "get-url", "origin"]],
    ["gh", ["repo", "view", "git@github.com:example/repo.git", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]],
    ["dagu", ["status", "feature", "--run-id", row.RUN]],
  ]);
  const running = inspectFixture("Running - fixture\n").inspect();
  assert.equal(running.action, "NONE");
  assert.equal(running.observation, "NOT_WAITING");
  assert.equal(running.route, "root");
  assert.equal(inspectFixture("Waiting - fixture\n").inspect().route, "root");
  for (const f of [inspectFixture(""), inspectFixture("Waiting - fixture\n", "")]) {
    const blocked = f.inspect({ REPO: "" });
    assert.equal(blocked.class, "BLOCKED");
    assert.equal(blocked.action, "WAIT");
    assert.equal(blocked.route, "root");
    assert.equal(blocked.observation, "UNAVAILABLE");
    assert.match(blocked.cause, /repository permissions and authentication/);
  }
});

test("inspection enforces receipt identity and bounded calls with fake execution and time", () => {
  assert.throws(() => inspectRun(row), /verified receipt-bound dispatch/);
  const f = inspectFixture();
  assert.throws(() => f.inspect({ RUN: "other" }), /discovery\/receipt identity mismatch/);
  assert.throws(() => f.inspect({ PRIMARY: "/other" }), /discovery\/receipt identity mismatch/);
  assert.deepEqual(f.calls, []);
  const times = [1000, 22_000];
  const expired = inspectRun(row, { ...f.dependencies, now: () => times.shift()! });
  assert.equal(expired.deadline, 1);
  assert.equal(expired.class, "BLOCKED");
  assert.deepEqual(f.calls, []);
  let timeout: number | undefined;
  const timedOut = inspectRun(row, { ...f.dependencies, env: { ...env, RECONCILE_CALL_TIMEOUT_SECONDS: "2" },
    spawnSync(_command, _args, options) {
      timeout = options.timeout;
      return { status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
    } });
  assert.equal(timeout, 2000);
  assert.equal(timedOut.deadline, 1);
  assert.equal(timedOut.class, "BLOCKED");
});

test("finishing a routed run writes receipt-bound evidence and reports closed issue orphans", () => {
  const state = statePath("finished");
  const metrics: string[] = [];
  const f = inspectFixture("Waiting - fixture\n├─implement [waiting]\n");
  const dependencies: ReconcileRunDependencies = { ...f.dependencies, runArtifactState: () => state,
    recordNoProgress: (directory, id, threshold) => recordNoProgress(directory, id, threshold, withoutLock), error: message => metrics.push(message) };
  const item = f.inspect();
  assert.throws(() => finishRun({ ...item }, null), /verified receipt-bound dispatch/);
  assert.throws(() => finishRun({ ...item, run: "other" }, null, dependencies), /routed run\/receipt identity mismatch/);
  const orphan = finishRun({ ...item }, { state: "closed", closed_at: "2026-10-25T00:00:00Z" }, dependencies);
  assert.equal(orphan, "ORPHAN example/repo#226 ci226 implement issue=CLOSED closed_at=2026-10-25T00:00:00Z");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "ci-observation.json"), "utf8")), {
    repo: "example/repo", run: "ci226", pr: "", worktree: item.worktree, step: "implement", iteration: 0,
    sha: "", class: "PENDING", action: "WAIT", check: "", log: "", cause: "", retry_run: "", findings: [],
  });
  assert.equal(finishRun({ ...item }, null, dependencies), "");
  const unavailable = JSON.parse(readFileSync(join(state, "ci-observation.json"), "utf8"));
  assert.equal(unavailable.class, "BLOCKED");
  assert.equal(unavailable.action, "WAIT");
  assert.match(unavailable.cause, /GitHub issue observation unavailable/);
  const parsed = metrics.map(message => JSON.parse(message.slice("reconcile-metric ".length)));
  assert.deepEqual(parsed.map(metric => [metric.phase, metric.calls]), [["observe", 1], ["transition", 0], ["observe", 1], ["transition", 0]]);
  assert.equal(parsed[0].skippedRepoLookup, true);
  assert.equal(parsed[0].latencyMs, 0);
  assert.equal(parsed[1].applied, false);
});

test("consecutive BLOCKED ticks retain one durable owner decision per fingerprint", async () => {
  const state = statePath("ci226");
  const path = join(state, "ci-observation.json");
  const tick = (id: string, changes: Parameters<typeof observation>[0] = {}) => {
    writeFileSync(path, JSON.stringify(observation(changes)));
    recordNoProgress(state, id, "2", withoutLock);
    return JSON.parse(readFileSync(path, "utf8")) as CiDiagnostic;
  };
  const transitions = new Transitions("owner");
  const run = waiting();
  const first = tick("first");
  assert.equal(first.decisionRequest, undefined);
  transitions.observe(run, { ciDiagnostic: first });
  tick("first");
  assert.equal(JSON.parse(readFileSync(join(state, "ci-no-progress.json"), "utf8")).observations, 1);
  const second = tick("second");
  assert.equal(second.decisionRequest?.observations, 2);
  const diagnostic = await readCiDiagnostic(primary, "ci226", false, new AbortController().signal);
  assert.deepEqual(diagnostic?.decisionRequest, second.decisionRequest);
  const request = transitions.observe(run, { ciDiagnostic: diagnostic! });
  assert.match(request.wakeMessage!, /\[DAGU DECISION\].*ci=BLOCKED.*check=validate.*Approval required/);
  assert.match(request.wakeMessage!, /continue with a renewed budget; change scope or delivery route; stop/);
  assert.equal(request.wakeMessages, undefined);
  for (const id of ["third", "fourth"]) {
    const repeated = tick(id);
    assert.deepEqual(repeated.decisionRequest, second.decisionRequest);
    assert.deepEqual(transitions.observe(run, { ciDiagnostic: repeated }), {});
  }
  assert.deepEqual(new Transitions("another-owner").observe(run, { ciDiagnostic: second }), {});
  const cause = "Approval required by another environment owner";
  assert.equal(tick("fifth", { cause }).decisionRequest, undefined);
  const changedCause = tick("sixth", { cause });
  assert.notEqual(changedCause.decisionRequest?.id, second.decisionRequest?.id);
  assert.match(JSON.stringify(transitions.observe(run, { ciDiagnostic: changedCause })), /DAGU DECISION/);
  assert.equal(tick("seventh", { cause, sha: nextSha }).decisionRequest, undefined);
  const changedSha = tick("eighth", { cause, sha: nextSha });
  assert.notEqual(changedSha.decisionRequest?.id, changedCause.decisionRequest?.id);
  assert.match(JSON.stringify(transitions.observe(run, { ciDiagnostic: changedSha })), /DAGU DECISION/);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(state, "ci-no-progress.json"), "utf8")).requests).length, 3);
});

test("configured no-progress budgets reset on non-BLOCKED ticks and reject invalid thresholds", () => {
  const state = statePath("policy558");
  const path = join(state, "ci-observation.json");
  let tickId = 0;
  function tick(changes: Parameters<typeof observation>[0] = {}) {
    writeFileSync(path, JSON.stringify(observation({ run: "policy558", ...changes })));
    recordNoProgress(state, String(++tickId), "3", withoutLock);
    return JSON.parse(readFileSync(path, "utf8")) as CiDiagnostic;
  }
  assert.equal(tick().decisionRequest, undefined);
  assert.equal(tick({ class: "PENDING" }).decisionRequest, undefined);
  assert.equal(tick().decisionRequest, undefined);
  assert.equal(tick().decisionRequest, undefined);
  assert.equal(tick().decisionRequest?.observations, 3);
  assert.equal(tick({ class: "PASS", action: "MERGE" }).decisionRequest, undefined);
  assert.equal(JSON.parse(readFileSync(join(state, "ci-no-progress.json"), "utf8")).observations, 0);
  assert.equal(tick().decisionRequest, undefined);
  for (const threshold of ["0", "-1", "1.5", "NaN"]) {
    assert.throws(() => recordNoProgress(state, "invalid", threshold, () => assert.fail("invalid threshold acquired the lock")), /positive integer/);
  }
});

test("returned candidate failures reach their owner with durable SHA, check and log evidence", async () => {
  const state = statePath("returned226");
  writeFileSync(join(state, "ci-return.json"), JSON.stringify(observation({ run: "returned226", class: "CODE_FAIL", action: "IMPLEMENT", log: "AssertionError: candidate test failed", cause: "Candidate failure in validate (FAILURE)" })));
  const diagnostic = await readCiDiagnostic(primary, "returned226", true, new AbortController().signal);
  assert.ok(diagnostic);
  const run = waiting("returned226", ["implement"], 1);
  const transitions = new Transitions("owner");
  const notice = transitions.observe(run, { ciDiagnostic: diagnostic }).wakeMessage!;
  assert.match(notice, /step=implement.*ci=CODE_FAIL/);
  assert.ok(notice.includes(sha) && notice.includes("validate") && notice.includes("AssertionError"), notice);
  assert.deepEqual(transitions.observe(run, { ciDiagnostic: diagnostic }), {});
  assert.deepEqual(new Transitions("other").observe(run, { ciDiagnostic: diagnostic }), {});
});

test("escalation diagnostics target the owner with budget evidence and decision options", async () => {
  const state = statePath("escalation558");
  writeFileSync(join(state, "escalation.json"), JSON.stringify({
    schemaVersion: 1, run: "escalation558", findings: [], trigger: {
      id: "budget558", reasons: ["repeated finding"], iteration: 3, sha,
      latestFindings: [{ text: "Repeated documentation finding", fingerprint: "finding558", iteration: 3 }], elapsedSeconds: 7200,
      spend: { state: "unknown", cause: "session attribution unavailable" },
    },
  }));
  const diagnostic = await readEscalationDiagnostic(primary, "escalation558", new AbortController().signal);
  assert.match(diagnostic!, /findings=Repeated documentation finding elapsedSeconds=7200 spend=unknown \(session attribution unavailable\)/);
  for (const step of ["escalation", "rebase_escalation"]) {
    const run = waiting("escalation558", [step], 3);
    const transitions = new Transitions("owner");
    const notice = transitions.observe(run, { escalationDiagnostic: diagnostic! }).wakeMessage!;
    assert.match(notice, /escalation=budget558.*iteration=3.*repeated finding.*continue with a renewed budget/);
    assert.deepEqual(transitions.observe(run, { escalationDiagnostic: diagnostic! }), {});
    assert.deepEqual(new Transitions("other").observe(run, { escalationDiagnostic: diagnostic! }), {});
  }
});

test("CodeQL waits for current-head results, returns findings and passes the fixed candidate with a fake GitHub API", () => {
  const policy = { security: "high_or_higher", alerts: "errors" };
  let head = sha;
  let pending = true;
  let forbidden = false;
  let findings: unknown[] = [];
  const calls: string[][] = [];
  const github = (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr") return { headRefOid: head };
    if (args.at(-1)!.includes("/check-runs")) return [{ check_runs: [{ id: 457, name: "CodeQL", app: { slug: "github-advanced-security" }, head_sha: head,
      status: pending ? "in_progress" : "completed", conclusion: pending ? null : "success" }] }];
    if (forbidden) throw new Error("HTTP 403: Code scanning is not enabled for this repository");
    return [findings];
  };
  const observe = (candidate = sha) => observeCodeScanning("example/repo", "77", candidate, policy, github);
  assert.equal(observe().class, "PENDING");
  pending = false;
  findings = [{ number: 43, state: "open", tool: { name: "CodeQL" }, html_url: "https://github.com/example/repo/security/code-scanning/43",
    rule: { id: "js/redos", security_severity_level: "high", severity: "warning" },
    most_recent_instance: { ref: "refs/pull/77/head", commit_sha: sha, location: { path: "src/server.ts", start_line: 4 }, message: { text: "Polynomial backtracking on user input" } } }];
  const failed = observe();
  assert.equal(failed.class, "CODE_FAIL");
  assert.deepEqual(failed.findings[0], { number: 43, rule: "js/redos", severity: "high", path: "src/server.ts", line: 4,
    message: "Polynomial backtracking on user input", url: "https://github.com/example/repo/security/code-scanning/43" });
  head = nextSha;
  assert.equal(observe().class, "STALE_SHA");
  findings = [];
  assert.equal(observe(nextSha).class, "PASS");
  forbidden = true;
  const blocked = observe(nextSha);
  assert.equal(blocked.class, "BLOCKED");
  assert.match(blocked.cause, /403/);
  assert.ok(calls.some(args => args.includes("--paginate") && args.at(-1)!.includes("/code-scanning/alerts")));
});
