import { liveDagu, liveDaguVersion } from "./fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";
import { readCiDiagnostic, readEscalationDiagnostic } from "../src/status/repository.ts";
import { BUNDLE_VERSION, REQUIRED_DAGU_VERSION } from "../src/bundle.ts";
import { admissionFixture } from "./fixtures/admission.ts";
import { withResourceGuard } from "./resource-fixtures.ts";
import { testRunId } from "./fixtures/run-id.ts";
const feature = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
const reconcile = readFileSync(new URL("../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8");


test("Dagu accepts materialized lifecycle templates", {
  ...liveDagu,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "omp-ci226-validate-"));
  try {
    for (const file of ["feature.yaml", "reconcile.yaml"]) {
      const template = readFileSync(new URL(`../skills/issue-execution/${file}`, import.meta.url), "utf8");
      const materialized = join(root, file);
      writeFileSync(materialized, template.replaceAll("__DAGU_FEATURE_VERSION__", BUNDLE_VERSION));
      execFileSync("dagu", ["validate", materialized], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("waiting checkpoints parse both tree connectors in the bytewise service locale", () => {
    const parser = script(reconcile, "observe").split("\n").find(line => line.startsWith("STEP="));
    assert.ok(parser);
    for (const connector of ["├─", "└─"]) {
      for (const checkpoint of ["await_ci", "await_merge"]) {
        const output: string = execFileSync("bash", ["-c", `${parser}\nprintf '%s' "$STEP"`], {
          env: { PATH: process.env.PATH, LC_ALL: "C", STATUS: `Waiting - fixture\n${connector}${checkpoint} [waiting]\n` },
          encoding: "utf8",
        });
        assert.equal(output, checkpoint);
      }
    }
});

function step(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, id);
  const end = source.indexOf("\n  - id:", start + 1);
  const block = source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
  return block.replace("    run: *cancellation_gate", () =>
    source.match(/    run: &cancellation_gate \|[\s\S]*?(?=\n  - id:)/)![0]!.replace(" &cancellation_gate", ""));
}
function script(source: string, id: string): string {
  const block = step(source, id).split("    run: |\n")[1];
  assert.ok(block, id);
  const lines = block.split("\n");
  const end = lines.findIndex(line => line && !line.startsWith("      "));
  return lines.slice(0, end < 0 ? lines.length : end).map(line => line.slice(6)).join("\n");
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
interface Fixture {
  root: string;
  primary: string;
  remote: string;
  worktree: string;
  bin: string;
  branch: string;
  control: string;
  calls: string;
  state: string;
  env: NodeJS.ProcessEnv;
  base: string;
}
function fixture(run = "ci226"): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-ci226-")));
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  const worktree = join(primary, ".workspace/worktrees/issue-226");
  const bin = join(root, "bin");
  const branch = "dagu/issue-226";
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
  git(primary, "config", "user.name", "CI fixture");
  git(primary, "config", "user.email", "ci@example.test");
  git(primary, "remote", "add", "origin", remote);
  writeFileSync(join(primary, "candidate"), "base\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "base");
  git(primary, "push", "-u", "origin", "main");
  writeFileSync(join(primary, ".git/info/exclude"), "/.workspace/\n");
  git(primary, "worktree", "add", "-b", branch, worktree, "origin/main");
  mkdirSync(bin);
  symlinkSync(fileURLToPath(new URL("../bin/dagu-pr-body.mjs", import.meta.url)), join(bin, "dagu-pr-body"));
  symlinkSync(fileURLToPath(new URL("../bin/dagu-codeql.ts", import.meta.url)), join(bin, "dagu-codeql"));
  symlinkSync(fileURLToPath(new URL("../bin/dagu-gate.cjs", import.meta.url)), join(bin, "dagu-gate"));
  symlinkSync(fileURLToPath(new URL("../bin/dagu-feature-protect.ts", import.meta.url)), join(bin, "dagu-feature-protect"));
  const control = join(root, "control.json");
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(control, JSON.stringify({ conclusion: "success", log: "", iteration: 0, statusStep: "both", mergeState: "BLOCKED", prState: "OPEN", prExists: false }));
  const common = `const fs=require('node:fs'), cp=require('node:child_process');
const c=JSON.parse(fs.readFileSync(process.env.CI_CONTROL,'utf8')), a=process.argv.slice(2);
const head=()=>cp.execFileSync('git',['--git-dir',process.env.CI_REMOTE,'rev-parse','refs/heads/'+process.env.BRANCH],{encoding:'utf8'}).trim();
const save=()=>fs.writeFileSync(process.env.CI_CONTROL,JSON.stringify(c));
const emit=x=>console.log(typeof x==='string'?x:JSON.stringify(x));
fs.appendFileSync(process.env.CI_CALLS,JSON.stringify({tool:process.argv[1].split('/').pop(),args:a,run:process.env.RUN,worktree:process.env.WORKTREE,pr:77,sha:head()})+'\\n');
`;
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\n${common}
if(a[0]==='repo'&&a[1]==='view') emit('example/repo');
else if(a[0]==='pr'&&a[1]==='create') { c.prExists=true; save(); emit('https://github.com/example/repo/pull/77'); }
else if(a[0]==='pr'&&a[1]==='edit') { if(!c.prExists) process.exit(1); }
else if(a[0]==='pr'&&a[1]==='view') {
 const fields=a[a.indexOf('--json')+1];
 if(fields==='number'&&!c.prExists) process.exit(1);
 if(a.includes('--jq')) emit(fields==='headRefOid'?head():fields==='number'?77:fields==='state'?c.prState:fields==='autoMergeRequest'?c.auto!==false:process.env.BRANCH);
 else emit({number:77,state:c.prState,mergeStateStatus:c.mergeState,autoMergeRequest:c.auto===false?null:{},headRefOid:head(),headRefName:process.env.BRANCH,statusCheckRollup:[],mergeCommit:c.mergeOid?{oid:c.mergeOid}:null});
} else if(a[0]==='pr'&&a[1]==='checks') {
 const payload=c.required??[{name:'validate',state:c.pending?'IN_PROGRESS':c.conclusion.toUpperCase(),link:'https://github.com/example/repo/actions/runs/123/job/456'}];
 if(a.includes('--jq')) {
  const row=payload.find(x=>x.name===(process.env.REQUIRED_CHECK||'validate'));
  emit(row?row.state:'MISSING');
 } else emit(payload);
 if(c.pending) process.exit(8);
 if(c.conclusion!=='success') process.exit(1);
} else if(a[0]==='api') {
 if(c.apiError) { console.error(c.apiError); process.exit(4); }
 const endpoint=a.at(-1);
 if(endpoint.includes('/check-runs')) emit([{check_runs:[...(c.checks??[{id:456,name:'validate',head_sha:c.checksSha??head(),status:c.pending?'in_progress':'completed',conclusion:c.conclusion,details_url:'https://github.com/example/repo/actions/runs/123/job/456',output:{summary:c.summary??''}}]),{id:457,name:'CodeQL',app:{slug:'github-advanced-security'},head_sha:head(),status:c.codeqlPending?'in_progress':'completed',conclusion:c.codeqlConclusion??'success'}]}]);
 else if(endpoint.endsWith('/status')) emit({sha:head(),statuses:c.statuses??[]});
 else if(endpoint.includes('/code-scanning/alerts')) {
  if(c.codeScanningStatus===403) { console.error('HTTP 403: Code scanning is not enabled for this repository'); process.exit(1); }
  emit([c.alerts??[]]);
 }
 else process.exit(91);
} else if(a[0]==='run'&&a[1]==='view') {
 const job=a.includes('--job');
 emit(job ? (c.jobLog??c.log) : (c.runLog??c.log));
}
else if(a[0]==='run'&&a[1]==='rerun') { c.reruns=(c.reruns??0)+1; save(); }
else if(a[0]==='pr'&&a[1]==='merge') { c.auto=!a.includes('--disable-auto'); save(); }
else { console.error('unexpected gh '+a.join(' ')); process.exit(92); }
`);
  writeFileSync(join(bin, "dagu"), `#!/usr/bin/env node\n${common}
if(a[0]==='status') {
 emit((c.running?'Running':'Waiting')+' - fixture');
 if(!c.running) {
  for(const s of c.statusStep==='both'?['await_ci','await_merge']:[c.statusStep]) emit('├─'+s+' [waiting]');
  emit('│ └─push-back iteration: '+c.iteration);
 }
} else if(a[0]==='history') emit([]);
else if(a[0]==='human-task') {
 const s=a[a.indexOf('--step')+1];
 if(a[1]==='push-back') {
  if(Number(a[a.indexOf('--expected-iteration')+1])!==c.iteration) { console.error('stale iteration'); process.exit(1); }
  c.iteration++; c.statusStep=s==='await_ci'?'implement':'both';
 } else c.statusStep=s==='await_ci'?'await_merge':'succeeded';
 save();
} else process.exit(93);
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "dagu"), 0o755);
  const state = join(primary, ".git/dagu-feature/runs", run);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "codeql-policy.json"), JSON.stringify({ sha: git(worktree, "rev-parse", "HEAD"), security: "high_or_higher", alerts: "errors" }));
  const identity = JSON.stringify({ primary, worktree, branch, run, session: "ci226-owner" }) + "\n";
  writeFileSync(join(state, "identity"), identity);
  writeFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
  writeFileSync(join(state, "base"), git(primary, "rev-parse", "HEAD") + "\n");
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary, WORKTREE: worktree, BRANCH: branch, ISSUE: "226", RUN: run, PR_NUMBER: "", BASE_BRANCH: "main", GATE: "true", OMP_SESSION_ID: "ci226-owner", CI_REMOTE: remote, CI_CONTROL: control, CI_CALLS: calls, DAGU_OUTPUT_FILE: join(root, "outputs") };
  env.CODEQL_SECURITY_THRESHOLD = "high_or_higher";
  env.CODEQL_ALERTS_THRESHOLD = "errors";
  env.IMPLEMENTER = "ImplementTest";
  delete env.DAGU_PARAMS_JSON;
  return { root, primary, remote, worktree, bin, branch, control, calls, state, env, base: git(primary, "rev-parse", "HEAD") };
}
function update(f: Fixture, changes: Record<string, unknown>): void {
  writeFileSync(f.control, JSON.stringify({ ...JSON.parse(readFileSync(f.control, "utf8")), ...changes }));
}
function execute(f: Fixture, source: string, id: string) {
  return spawnSync("bash", ["-c", script(source, id)], { env: f.env, cwd: f.root, encoding: "utf8" });
}
function observe(f: Fixture, source: string) {
  f.env.CI_OBSERVATION_ID = String(Number(f.env.CI_OBSERVATION_ID ?? 0) + 1);
  const result = execute(f, source, "observe");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(readFileSync(join(f.state, "ci-observation.json"), "utf8"));
}
function transition(f: Fixture, source: string): string {
  const result = execute(f, source, "transition");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
function publish(f: Fixture, feature: string, value: string): string {
  writeFileSync(join(f.worktree, "candidate"), value);
  f.env.SUMMARY = value;
  f.env.MESSAGE = `fix: ${value}`;
  for (const id of ["capture", "gate"]) {
    const result = execute(f, feature, id);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  for (const id of ["push", "pr", "code_scanning"]) {
    const result = execute(f, feature, id);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return git(f.worktree, "rev-parse", "HEAD");
}

  test("retained runs complete from checks and merge state under their original policy", () => {
    const f = fixture("retained-pre-codeql");
    try {
      git(f.worktree, "push", "origin", f.branch);
      rmSync(join(f.state, "codeql-policy.json"));
      update(f, { statusStep: "await_merge", prState: "MERGED", codeqlPending: true });
      const merged = observe(f, reconcile);
      assert.equal(merged.class, "PASS");
      assert.equal(merged.action, "COMPLETE");
      transition(f, reconcile);
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).statusStep, "succeeded");
      update(f, { statusStep: "await_ci", prState: "MERGED" });
      assert.equal(observe(f, reconcile).action, "COMPLETE");
      update(f, { statusStep: "await_merge", prState: "OPEN", auto: false });
      const disabled = observe(f, reconcile);
      assert.equal(disabled.class, "BLOCKED");
      assert.equal(disabled.action, "WAIT");
      update(f, { auto: true });
      const waiting = observe(f, reconcile);
      assert.equal(waiting.class, "PASS");
      assert.equal(waiting.action, "WAIT");
      const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(calls.every(call => !call.args.some((arg: string) => arg.includes("/code-scanning/alerts"))));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("CodeQL BLOCKED returns findings to implement and enables merge only after the fixed head passes", () => {
    const f = fixture("codeql570");
    try {
      update(f, { auto: false, codeqlPending: true });
      const a = publish(f, feature, "candidate with finding");
      assert.equal(observe(f, reconcile).class, "PENDING");
      assert.equal(execute(f, feature, "auto_merge").status, 0);
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).auto, false);
      const finding = { number: 43, state: "open", tool: { name: "CodeQL" }, html_url: "https://github.com/example/repo/security/code-scanning/43",
        rule: { id: "js/redos", security_severity_level: "high", severity: "warning" },
        most_recent_instance: { ref: "refs/pull/77/head", commit_sha: a, location: { path: "src/server.ts", start_line: 4 },
          message: { text: "Polynomial backtracking on user input" } } };
      update(f, { auto: true, codeqlPending: false, alerts: [finding] });
      const failed = observe(f, reconcile);
      assert.equal(failed.class, "CODE_FAIL");
      assert.equal(failed.action, "IMPLEMENT");
      assert.equal(failed.step, "await_ci");
      assert.match(failed.log, /js\/redos.*src\/server.ts:4.*Polynomial/);
      transition(f, reconcile);
      const retained = JSON.parse(readFileSync(join(f.state, "ci-return.json"), "utf8"));
      assert.equal(retained.findings[0].rule, "js/redos");
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).statusStep, "implement");
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).auto, false);
      const b = publish(f, feature, "fixed candidate");
      update(f, { alerts: [], statusStep: "both" });
      const passed = observe(f, reconcile);
      assert.equal(passed.sha, b);
      assert.equal(passed.class, "PASS");
      assert.equal(passed.action, "MERGE");
      transition(f, reconcile);
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).auto, true);
      const merge = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line))
        .find(call => call.tool === "gh" && call.args.includes("--auto"));
      assert.ok(merge.args.includes("--match-head-commit") && merge.args.includes(b));
      assert.ok(merge.args.includes("--body") && merge.args.some((value: string) => value.startsWith("Closes #226")));
      update(f, { prState: "MERGED" });
      assert.equal(observe(f, reconcile).action, "COMPLETE");
      transition(f, reconcile);
      const authorized = execute(f, feature, "authorize_ci");
      assert.equal(authorized.status, 0, authorized.stdout + authorized.stderr);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  test("A CODE_FAIL returns implement, B PASS uses the same PR and rejects late A", async t => {
    const f = fixture();
    try {
      const a = publish(f, feature, "candidate A");
      update(f, { conclusion: "failure", log: "AssertionError: candidate test failed" });
      const failed = observe(f, reconcile);
      assert.equal(failed.class, "CODE_FAIL");
      assert.equal(failed.sha, a);
      assert.equal(failed.step, "await_ci");
      transition(f, reconcile);
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).statusStep, "implement");
      const diagnostic = await readCiDiagnostic(f.primary, "ci226", true, new AbortController().signal);
      const returned: RunDetails = { name: "feature", dagRunId: "ci226", statusLabel: "waiting", params: "ISSUE=226 OMP_SESSION_ID=owner", nodes: [{ step: { name: "implement", humanTask: {} }, statusLabel: "waiting", approvalIteration: 1 }] };
      const notice = new Transitions("owner").observe(returned, { ciDiagnostic: diagnostic! }).wakeMessage!;
      assert.match(notice, /step=implement.*ci=CODE_FAIL/);
      assert.ok(notice.includes(a) && notice.includes("validate") && notice.includes("AssertionError"), notice);
      const b = publish(f, feature, "candidate B");
      update(f, { conclusion: "success", log: "", checksSha: a, statusStep: "both" });
      const late = observe(f, reconcile);
      assert.equal(late.class, "STALE_SHA");
      assert.equal(late.action, "WAIT");
      const rejected = execute(f, feature, "authorize_ci");
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stderr, /STALE_SHA/);
      update(f, { checksSha: b });
      const passed = observe(f, reconcile);
      assert.equal(passed.class, "PASS");
      assert.equal(passed.sha, b);
      const authorized = execute(f, feature, "authorize_ci");
      assert.equal(authorized.status, 0, authorized.stdout + authorized.stderr);
      const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(calls.filter(call => call.tool === "gh" && call.args[0] === "pr" && call.args[1] === "create").length, 1);
      assert.equal(git(f.primary, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], f.base);
      assert.equal(git(f.worktree, "rev-list", "--merges", "HEAD").length, 0);
      t.diagnostic(JSON.stringify({ run: "ci226", worktree: f.worktree, pr: 77, transitions: [failed, late, passed], notice }));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a failed aggregate required check is classified from the failed needed jobs of the same run", () => {
    const f = fixture("aggregate546");
    const summary = "changes=success test=success live=failure\nRequired CI jobs did not complete successfully";
    try {
      const sha = publish(f, feature, "aggregate candidate");
      update(f, { conclusion: "failure", summary, log: "", jobLog: summary, runLog: "live (other-live)\tnot ok 46 - real Dagu implement guard\nAssertionError: expected implement push-back" });
      const failed = observe(f, reconcile);
      assert.equal(failed.class, "CODE_FAIL");
      assert.equal(failed.action, "IMPLEMENT");
      assert.equal(failed.step, "await_ci");
      assert.equal(failed.check, "validate");
      assert.equal(failed.sha, sha);
      assert.equal(failed.retry_run, "123");
      assert.match(failed.cause, /Candidate failure in validate \(FAILURE\)/);
      assert.match(failed.log, /AssertionError: expected implement push-back/);
      const views = ghCalls(f).filter(call => call.tool === "gh" && call.args[0] === "run" && call.args[1] === "view");
      assert.ok(views.some(call => call.args.includes("--job") && call.args.includes("--log-failed") && call.args.includes("123")));
      assert.ok(views.some(call => call.args.includes("--log-failed") && !call.args.includes("--job") && call.args.includes("123")));
      transition(f, reconcile);
      const control = JSON.parse(readFileSync(f.control, "utf8"));
      assert.equal(control.statusStep, "implement");
      assert.equal(control.iteration, failed.iteration + 1);
      const push = ghCalls(f).filter(call => call.tool === "dagu" && call.args[1] === "push-back").at(-1);
      assert.ok(push);
      assert.equal(push.args[push.args.indexOf("--step") + 1], "await_ci");
      assert.equal(push.args[push.args.indexOf("--expected-iteration") + 1], String(failed.iteration));

      update(f, { statusStep: "both", jobLog: summary, runLog: "test\tRunner lost communication with the server" });
      const transient = observe(f, reconcile);
      assert.equal(transient.class, "TRANSIENT");
      assert.equal(transient.action, "RETRY");
      assert.equal(transient.sha, sha);
      assert.match(transition(f, reconcile), /rerun=123 attempt=1/);

      update(f, { jobLog: "AssertionError: candidate test failed", runLog: "live\tHTTP 429" });
      const precedence = observe(f, reconcile);
      assert.equal(precedence.class, "TRANSIENT");
      assert.equal(precedence.action, "RETRY");

      update(f, { jobLog: summary, runLog: "live (other-live)\tProcess completed with exit code 1." });
      const blocked = observe(f, reconcile);
      assert.equal(blocked.class, "BLOCKED");
      assert.equal(blocked.action, "WAIT");
      assert.match(blocked.cause, /Unproven cause for validate \(FAILURE\)/);
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).statusStep, "both");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("all classes, rebase routes, retry backoff/exhaustion and stale iteration", () => {
    const f = fixture();
    try {
      publish(f, feature, "candidate");
      update(f, { pending: true });
      assert.equal(observe(f, reconcile).class, "PENDING");
      update(f, { pending: false, conclusion: "cancelled", log: "Approval required by environment owner" });
      const blocked = observe(f, reconcile);
      assert.equal(blocked.class, "BLOCKED");
      assert.match(blocked.cause, /Unproven cause/);
      const waiting: RunDetails = { name: "feature", dagRunId: "ci226", statusLabel: "waiting", params: "ISSUE=226 OMP_SESSION_ID=owner", nodes: [{ step: { name: "await_ci", humanTask: {} }, statusLabel: "waiting", approvalIteration: 0 }] };
      const notices = new Transitions("owner").observe(waiting, { ciDiagnostic: blocked });
      assert.ok(JSON.stringify(notices).includes(blocked.cause));
      update(f, { conclusion: "timed_out", log: "Runner lost communication with the server" });
      assert.equal(observe(f, reconcile).class, "TRANSIENT");
      assert.match(transition(f, reconcile), /attempt=1/);
      assert.match(transition(f, reconcile), /backoff/);
      const retryPath = join(f.state, `ci-retry-${git(f.worktree, "rev-parse", "HEAD")}.json`);
      let retry = JSON.parse(readFileSync(retryPath, "utf8"));
      assert.ok(retry.next_at > Date.now() / 1000);
      writeFileSync(retryPath, JSON.stringify({ ...retry, next_at: 0 }));
      assert.match(transition(f, reconcile), /attempt=2/);
      retry = JSON.parse(readFileSync(retryPath, "utf8"));
      writeFileSync(retryPath, JSON.stringify({ ...retry, next_at: 0 }));
      assert.match(transition(f, reconcile), /retry exhausted/);
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).reruns, 2);
      assert.equal(JSON.parse(readFileSync(join(f.state, "ci-observation.json"), "utf8")).class, "BLOCKED");
      update(f, { conclusion: "success", log: "", mergeState: "BEHIND" });
      assert.equal(observe(f, reconcile).action, "REBASE");
      transition(f, reconcile);
      update(f, { mergeState: "DIRTY" });
      const dirty = observe(f, reconcile);
      assert.equal(dirty.step, "await_merge");
      transition(f, reconcile);
      update(f, { mergeState: "BLOCKED", conclusion: "failure", log: "Build failed" });
      observe(f, reconcile);
      update(f, { iteration: 3 });
      const stale = execute(f, reconcile, "transition");
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /Stale iteration/);
      assert.equal(JSON.parse(readFileSync(f.control, "utf8")).statusStep, "both");
      update(f, { running: true });
      assert.equal(observe(f, reconcile).action, "NONE");
      assert.equal(git(f.primary, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], f.base);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

test("template: consecutive BLOCKED ticks request one owner decision per fingerprint", async () => {
  const reconcile = readFileSync(new URL("../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8");
  const f = fixture("no-progress558");
  try {
    git(f.worktree, "push", "-u", "origin", f.branch);
    update(f, { conclusion: "cancelled", log: "Approval required by environment owner" });
    const waiting: RunDetails = {
      name: "feature", dagRunId: f.env.RUN!, statusLabel: "waiting", params: "ISSUE=226 OMP_SESSION_ID=owner",
      nodes: ["await_ci", "await_merge"].map(name => ({ step: { name, humanTask: {} }, statusLabel: "waiting", approvalIteration: 0 })),
    };
    const transitions = new Transitions("owner");
    const first = observe(f, reconcile);
    assert.equal(first.class, "BLOCKED");
    assert.equal(first.decisionRequest, undefined);
    transitions.observe(waiting, { ciDiagnostic: first });
    const repeatedTick = execute(f, reconcile, "observe");
    assert.equal(repeatedTick.status, 0, repeatedTick.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.state, "ci-no-progress.json"), "utf8")).observations, 1);
    const second = observe(f, reconcile);
    assert.equal(second.decisionRequest.observations, 2);
    const signal = new AbortController().signal;
    const diagnostic = await readCiDiagnostic(f.primary, f.env.RUN!, false, signal);
    assert.deepEqual(diagnostic?.decisionRequest, second.decisionRequest);
    const request = transitions.observe(waiting, { ciDiagnostic: diagnostic! });
    assert.match(request.wakeMessage!, /\[DAGU DECISION\].*ci=BLOCKED.*check=validate.*Approval required/);
    assert.match(request.wakeMessage!, /continue with a renewed budget; change scope or delivery route; stop/);
    assert.equal(request.wakeMessages, undefined);
    for (let tick = 0; tick < 2; tick++) {
      const repeated = observe(f, reconcile);
      assert.deepEqual(repeated.decisionRequest, second.decisionRequest);
      assert.deepEqual(transitions.observe(waiting, { ciDiagnostic: repeated }), {});
    }
    assert.deepEqual(new Transitions("another-owner").observe(waiting, { ciDiagnostic: second }), {});
    update(f, { conclusion: "failure", log: "Approval required by another environment owner" });
    assert.equal(observe(f, reconcile).decisionRequest, undefined);
    const changedCause = observe(f, reconcile);
    assert.notEqual(changedCause.decisionRequest.id, second.decisionRequest.id);
    assert.match(JSON.stringify(transitions.observe(waiting, { ciDiagnostic: changedCause })), /DAGU DECISION/);
    writeFileSync(join(f.worktree, "candidate"), "new head\n");
    git(f.worktree, "add", "candidate");
    git(f.worktree, "commit", "-m", "new head");
    git(f.worktree, "push", "origin", f.branch);
    writeFileSync(join(f.state, "codeql-policy.json"), JSON.stringify({ sha: git(f.worktree, "rev-parse", "HEAD"), security: "high_or_higher", alerts: "errors" }));
    assert.equal(observe(f, reconcile).decisionRequest, undefined);
    const changedSha = observe(f, reconcile);
    assert.notEqual(changedSha.decisionRequest.id, changedCause.decisionRequest.id);
    assert.match(JSON.stringify(transitions.observe(waiting, { ciDiagnostic: changedSha })), /DAGU DECISION/);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(f.state, "ci-no-progress.json"), "utf8")).requests).length, 3);
    update(f, { auto: true, conclusion: "success", log: "" });
    assert.equal(observe(f, reconcile).class, "PASS");
    update(f, { conclusion: "cancelled" });
    assert.equal(observe(f, reconcile).decisionRequest, undefined);
    transition(f, reconcile);
    assert.equal(JSON.parse(readFileSync(f.control, "utf8")).iteration, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("template: no-progress threshold is repository policy and non-BLOCKED ticks reset the streak", () => {
  const reconcile = readFileSync(new URL("../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8");
  const f = fixture("policy558");
  try {
    git(f.worktree, "push", "-u", "origin", f.branch);
    f.env.ESCALATION_CI_BLOCKED = "3";
    update(f, { conclusion: "cancelled", log: "Approval required" });
    assert.equal(observe(f, reconcile).decisionRequest, undefined);
    update(f, { pending: true });
    assert.equal(observe(f, reconcile).class, "PENDING");
    update(f, { pending: false });
    assert.equal(observe(f, reconcile).decisionRequest, undefined);
    assert.equal(observe(f, reconcile).decisionRequest, undefined);
    assert.equal(observe(f, reconcile).decisionRequest.observations, 3);
    update(f, { conclusion: "timed_out", log: "Runner lost communication with the server" });
    observe(f, reconcile);
    const retryPath = join(f.state, `ci-retry-${git(f.worktree, "rev-parse", "HEAD")}.json`);
    writeFileSync(retryPath, JSON.stringify({ attempts: 2, next_at: 0 }));
    assert.equal(observe(f, reconcile).class, "BLOCKED");
    assert.equal(observe(f, reconcile).decisionRequest, undefined);
    assert.equal(observe(f, reconcile).decisionRequest.observations, 3);
    update(f, { auto: false, conclusion: "failure", log: "Approval required" });
    f.env.ESCALATION_CI_BLOCKED = "1";
    assert.equal(observe(f, reconcile).decisionRequest.observations, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("escalation diagnostics target the owner with budget evidence and decision options", async () => {
  const f = fixture("escalation558");
  try {
    writeFileSync(join(f.state, "escalation.json"), JSON.stringify({
      schemaVersion: 1, run: f.env.RUN, findings: [], trigger: {
        id: "budget558", reasons: ["repeated finding"], iteration: 3, sha: f.base,
        latestFindings: [{ text: "Repeated documentation finding", fingerprint: "finding558", iteration: 3 }], elapsedSeconds: 7200,
        spend: { state: "unknown", cause: "session attribution unavailable" },
      },
    }));
    const diagnostic = await readEscalationDiagnostic(f.worktree, f.env.RUN!, new AbortController().signal);
    assert.match(diagnostic!, /findings=Repeated documentation finding elapsedSeconds=7200 spend=unknown \(session attribution unavailable\)/);
    for (const step of ["escalation", "rebase_escalation"]) {
      const run: RunDetails = { name: "feature", dagRunId: f.env.RUN!, statusLabel: "waiting",
        params: "OMP_SESSION_ID=owner", nodes: [{ step: { name: step, humanTask: {} }, statusLabel: "waiting", approvalIteration: 3 }] };
      const transitions = new Transitions("owner");
      const notice = transitions.observe(run, { escalationDiagnostic: diagnostic! }).wakeMessage!;
      assert.match(notice, /escalation=budget558.*iteration=3.*repeated finding.*continue with a renewed budget/);
      assert.deepEqual(transitions.observe(run, { escalationDiagnostic: diagnostic! }), {});
      assert.deepEqual(new Transitions("other").observe(run, { escalationDiagnostic: diagnostic! }), {});
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test(`Dagu ${REQUIRED_DAGU_VERSION}: paired root waits return to implement/rebase and release the queue`, {
  ...liveDagu,
  timeout: 120_000,
}, async t => {
  const id = testRunId("ci226");
  const probeId = testRunId("queue-released");
  const f = fixture(id);
  const home = join(f.root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  rmSync(join(f.bin, "dagu"));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  f.env.DAGU_HOME = home;
  writeFileSync(join(home, "config.yaml"), `auth:\n  mode: none\ncoordinator:\n  enabled: false\nqueues:\n  enabled: true\n  config:\n    - name: ci226\n      max_active_runs: 1\n`);
  const fixtureEnv = ["PATH", "CI_REMOTE", "CI_CONTROL", "CI_CALLS"].map(key => `  - ${key}: ${JSON.stringify(f.env[key])}\n`).join("");
  const definition = `type: graph\nshell: bash\nmax_active_steps: 1\nqueue: ci226\nparams:\n  - ISSUE: "226"\n  - PRIMARY: ${f.primary}\n  - BRANCH: ${f.branch}\n  - PR_NUMBER: "77"\nenv:\n${fixtureEnv}  - WORKTREE: ${f.worktree}\n  - RUN: ${id}\nsteps:\n  - id: implement\n    action: human.task\n    with:\n      prompt: Correct candidate\n  - id: rebase\n    depends: implement\n    run: echo rebased\n  - id: auto_merge\n    depends: rebase\n    run: echo observed-publication\n${["await_ci", "await_ci_cancellation", "await_merge", "await_merge_cancellation", "authorize_ci"].map(id => step(feature, id).replace("rewind_to: implement_budget", "rewind_to: implement").replace("rewind_to: rebase_budget", "rewind_to: rebase")).join("")}`;
  const path = join(home, "dags/feature.yaml");
  writeFileSync(path, definition);
  writeFileSync(join(home, "dags/queue-probe.yaml"), "queue: ci226\nsteps:\n  - id: observed\n    run: echo queue-slot-released\n");
  let logs = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", data => { logs += data; });
  service.stderr.on("data", data => { logs += data; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(100);
    }
    throw new Error(`Timeout ${description}\n${logs}`);
  }
  async function waiting(stepId: string, iteration: number): Promise<RunDetails> {
    return until(`${stepId}/${iteration}`, async () => {
      const response = await fetch(`${api}/dag-runs/feature/${id}`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: RunDetails }).dagRunDetails;
      assert.ok(!["failed", "aborted"].includes(run.statusLabel), JSON.stringify(run));
      return run.statusLabel === "waiting" && run.nodes?.some(node => (node.step.id ?? node.step.name) === stepId && node.statusLabel === "waiting" && (node.approvalIteration ?? 0) === iteration) ? run : undefined;
    });
  }
  try {
    await until("service ready", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    dagu("validate", path);
    const a = publish(f, feature, "candidate A");
    dagu("enqueue", "--run-id", id, path);
    await waiting("implement", 0);
    dagu("human-task", "complete", "feature", "--run-id", id, "--step", "implement");
    await waiting("await_ci", 0);
    update(f, { alerts: [{ number: 43, state: "open", tool: { name: "CodeQL" }, html_url: "https://github.com/example/repo/security/code-scanning/43",
      rule: { id: "js/redos", security_severity_level: "high", severity: "warning" },
      most_recent_instance: { state: "open", ref: "refs/pull/77/head", commit_sha: a, location: { path: "src/server.ts", start_line: 4 },
        message: { text: "Polynomial backtracking on user input" } } }] });
    assert.equal(observe(f, reconcile).class, "CODE_FAIL");
    transition(f, reconcile);
    const returned = await waiting("implement", 1);
    const ciDiagnostic = await readCiDiagnostic(f.primary, id, true, new AbortController().signal);
    const wake = new Transitions("owner").observe({ ...returned, params: `${returned.params} OMP_SESSION_ID=owner` }, { ciDiagnostic: ciDiagnostic! }).wakeMessage!;
    assert.ok(wake.includes("step=implement") && wake.includes(a) && wake.includes("js/redos"), wake);
    t.diagnostic(wake);
    const b = publish(f, feature, "candidate B");
    update(f, { alerts: [], checksSha: a });
    dagu("human-task", "complete", "feature", "--run-id", id, "--step", "implement");
    await waiting("await_ci", 1);
    assert.equal(observe(f, reconcile).class, "STALE_SHA");
    update(f, { checksSha: b, mergeState: "BEHIND" });
    assert.equal(observe(f, reconcile).action, "REBASE");
    transition(f, reconcile);
    await waiting("await_merge", 2);
    const stale = spawnSync("dagu", ["human-task", "push-back", "feature", "--run-id", id, "--step", "await_merge", "--expected-iteration", "1"], { env: f.env, encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /iteration 2, not 1/);
    await waiting("await_merge", 2);
    dagu("enqueue", "--run-id", probeId, "queue-probe");
    await until("same queue progresses while paired tasks wait", async () => {
      const response = await fetch(`${api}/dag-runs/queue-probe/${probeId}`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: RunDetails }).dagRunDetails;
      return run.statusLabel === "succeeded" ? true : undefined;
    });
    update(f, { mergeState: "CLEAN", prState: "MERGED" });
    assert.equal(observe(f, reconcile).class, "PASS");
    transition(f, reconcile);
    await waiting("await_merge", 2);
    observe(f, reconcile);
    transition(f, reconcile);
    await until("same feature succeeds", async () => {
      const response = await fetch(`${api}/dag-runs/feature/${id}`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: RunDetails }).dagRunDetails;
      assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
      return run.statusLabel === "succeeded" ? true : undefined;
    });
    const history = JSON.parse(dagu("history", "feature", "--format", "json"));
    assert.equal(history.length, 1);
    assert.equal(history[0].dagRunId, id);
    assert.equal(git(f.primary, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], f.base);
    t.diagnostic(JSON.stringify({ version: liveDaguVersion, home, port, run: id, worktree: f.worktree, pr: 77, a, b, iterations: [0, 1, 2], result: "succeeded", queue: "released" }));
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => service.exitCode !== null ? resolve() : service.once("exit", () => resolve()));
    rmSync(f.root, { recursive: true, force: true });
  }
});

function ghCalls(f: Fixture) {
  return readFileSync(f.calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: string[] });
}
function scanningCalls(f: Fixture) {
  return ghCalls(f).filter(call => call.args.some(arg => arg.includes("/code-scanning/alerts")));
}

test("required code scanning stays blocked when the code-scanning API returns 403", () => {
  const f = fixture("code-scanning-required-403");
  try {
    f.env.CODE_SCANNING = "required";
    update(f, { auto: false, codeScanningStatus: 403 });
    const sha = publish(f, feature, "required candidate");
    const observation = JSON.parse(readFileSync(join(f.state, "codeql-observation.json"), "utf8"));
    assert.equal(observation.class, "BLOCKED");
    assert.match(observation.cause, /403/);
    assert.equal(execute(f, feature, "auto_merge").status, 0);
    assert.equal(JSON.parse(readFileSync(f.control, "utf8")).auto, false);
    const blocked = observe(f, reconcile);
    assert.equal(blocked.class, "BLOCKED");
    assert.equal(blocked.action, "WAIT");
    assert.match(blocked.cause, /403/);
    const rejected = execute(f, feature, "authorize_ci");
    assert.notEqual(rejected.status, 0);
    assert.ok(scanningCalls(f).length > 0);
    assert.equal(JSON.parse(readFileSync(join(f.state, "codeql-policy.json"), "utf8")).sha, sha);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("off code scanning admits and reaches the close success contract when the API returns 403", () => {
  const admitted = admissionFixture();
  const f = fixture("code-scanning-off-403");
  try {
    admitted.writeAnswers({ codeScanning: "off" });
    const bin = join(admitted.root, "dagu-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), `#!/bin/sh\nif [ "$1" = version ]; then printf '%s\\n' ${JSON.stringify(REQUIRED_DAGU_VERSION)}; exit 0; fi\nprintf 'unexpected dagu %s\\n' "$*" >&2\nexit 1\n`);
    chmodSync(join(bin, "dagu"), 0o755);
    const result = admitted.command("admit", "code-scanning-off", { PATH: `${bin}:${process.env.PATH ?? ""}` });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(readFileSync(admitted.receipt("code-scanning-off"), "utf8")).initial.execution.dagSnapshot as string;
    assert.match(snapshot, /CODE_SCANNING: "off"/);
    assert.match(snapshot, /id: code_scanning/);
    mkdirSync(join(admitted.dag, ".."), { recursive: true });
    writeFileSync(admitted.dag, snapshot.replace(/  - id: code_scanning[\s\S]*?\n  - id: auto_merge/, "  - id: auto_merge"));
    const tampered = admitted.command("admit", "code-scanning-removed", { PATH: `${bin}:${process.env.PATH ?? ""}` });
    assert.equal(tampered.status, 0, tampered.stderr);
    const kept = JSON.parse(readFileSync(admitted.receipt("code-scanning-removed"), "utf8")).initial.execution.dagSnapshot as string;
    assert.match(kept, /id: code_scanning/);
    const overridden = admitted.command("admit", "code-scanning-override", { PATH: `${bin}:${process.env.PATH ?? ""}` }, ["CODE_SCANNING=required"]);
    assert.notEqual(overridden.status, 0);
    assert.match(overridden.stderr, /admission rejected run parameter: CODE_SCANNING/);

    f.env.CODE_SCANNING = "off";
    f.env.REQUIRED_CHECK = "validate";
    update(f, { auto: false, codeScanningStatus: 403, mergeState: "BLOCKED" });
    const sha = publish(f, feature, "off candidate");
    assert.deepEqual(scanningCalls(f), []);
    const policy = JSON.parse(readFileSync(join(f.state, "codeql-policy.json"), "utf8"));
    assert.equal(policy.mode, "off");
    assert.equal(policy.sha, sha);
    assert.equal(existsSync(join(f.state, "codeql-observation.json")), false);
    const merged = execute(f, feature, "auto_merge");
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    const merge = ghCalls(f).find(call => call.tool === "gh" && call.args[0] === "pr" && call.args[1] === "merge");
    assert.ok(merge);
    assert.ok(merge.args.includes("--match-head-commit") && merge.args.includes(sha));
    assert.equal(observe(f, reconcile).class, "PASS");
    assert.deepEqual(scanningCalls(f), []);
    const squashBody = readFileSync(join(f.worktree, "candidate"), "utf8");
    writeFileSync(join(f.primary, "candidate"), squashBody);
    git(f.primary, "add", "candidate");
    git(f.primary, "commit", "-m", "squash off candidate");
    git(f.primary, "push", "origin", "main");
    const squash = git(f.primary, "rev-parse", "HEAD");
    update(f, { prState: "MERGED", mergeOid: squash });
    assert.equal(observe(f, reconcile).action, "COMPLETE");
    transition(f, reconcile);
    const authorized = execute(f, feature, "authorize_ci");
    assert.equal(authorized.status, 0, authorized.stdout + authorized.stderr);
    assert.match(authorized.stdout, new RegExp(`authorized_sha=${sha}`));
    assert.deepEqual(scanningCalls(f), []);
    const primary = realpathSync(f.primary);
    const worktree = realpathSync(f.worktree);
    const resource = JSON.stringify({ run: f.env.RUN, primary, branch: f.branch, worktree });
    writeFileSync(join(f.state, "resource.json"), resource);
    const hash = execFileSync("git", ["hash-object", "--stdin"], { input: f.branch, encoding: "utf8" }).trim();
    const owner = git(f.primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/resources/${hash}.json`);
    mkdirSync(join(owner, ".."), { recursive: true });
    writeFileSync(owner, resource);
    writeFileSync(join(f.state, "tested-sha"), `${sha}\n`);
    writeFileSync(join(f.state, "bootstrap-enqueued"), "not-a-lifecycle-package\n");
    const lines = feature.split("\n");
    const anchor = lines.indexOf("    run: &feature_cleanup |");
    let end = anchor + 1;
    while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
    const closeGate = withResourceGuard(`CLEANUP_CLOSE=true\n${lines.slice(anchor + 1, end).map(line => line.slice(6)).join("\n")}`, fileURLToPath(new URL("../skills/issue-execution/feature.yaml", import.meta.url)));
    const closed = spawnSync("bash", ["-c", closeGate], { env: f.env, cwd: f.root, encoding: "utf8" });
    assert.equal(closed.status, 0, closed.stdout + closed.stderr);
    assert.match(closed.stdout, new RegExp(`tested_sha=${sha}`));
    assert.match(closed.stdout, /proof=squash/);
    assert.equal(readFileSync(join(f.state, "cleanup-phase"), "utf8"), "complete\n");
    assert.equal(existsSync(f.worktree), false);
    assert.deepEqual(scanningCalls(f), []);
  } finally {
    admitted.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});
