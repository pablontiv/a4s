import { liveDagu, liveDaguVersion } from "./fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";
import { readCiDiagnostic } from "../src/status/repository.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { verifyQuality } from "../src/triage/quality.ts";
import { qualityFixture } from "./quality-fixtures.ts";

const definitions = [
  ["template", "../skills/dagu-feature/"],
  ["render", "../../../.workspace/dagu/dags/"],
] as const;


test("CI scripts preserve template/render parity and Dagu accepts materialized templates and renders", {
  ...liveDagu,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "omp-ci226-validate-"));
  try {
    for (const file of ["feature.yaml", "reconcile.yaml"]) {
      const template = readFileSync(new URL(`../skills/dagu-feature/${file}`, import.meta.url), "utf8");
      const render = readFileSync(new URL(`../../../.workspace/dagu/dags/${file}`, import.meta.url), "utf8");
      for (const id of file === "feature.yaml" ? ["await_ci", "await_merge", "authorize_ci"] : ["observe", "transition"]) {
        assert.equal(step(template, id), step(render, id), `${file}/${id}`);
      }
      const materialized = join(root, file);
      writeFileSync(materialized, template.replaceAll("__DAGU_FEATURE_VERSION__", BUNDLE_VERSION));
      for (const path of [materialized, fileURLToPath(new URL(`../../../.workspace/dagu/dags/${file}`, import.meta.url))]) {
        execFileSync("dagu", ["validate", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("waiting checkpoints parse both tree connectors in the bytewise service locale", () => {
  for (const [, base] of definitions) {
    const source = readFileSync(new URL(`${base}reconcile.yaml`, import.meta.url), "utf8");
    const parser = script(source, "observe").split("\n").find(line => line.startsWith("STEP="));
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
  }
});

function step(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, id);
  const end = source.indexOf("\n  - id:", start + 1);
  return source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
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
function fixture(): Fixture {
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
else if(a[0]==='pr'&&a[1]==='view') {
 const fields=a[a.indexOf('--json')+1];
 if(fields==='number'&&!c.prExists) process.exit(1);
 if(a.includes('--jq')) emit(fields==='headRefOid'?head():fields==='number'?77:fields==='state'?c.prState:process.env.BRANCH);
 else emit({number:77,state:c.prState,mergeStateStatus:c.mergeState,autoMergeRequest:c.auto===false?null:{},headRefOid:head(),headRefName:process.env.BRANCH,statusCheckRollup:[]});
} else if(a[0]==='pr'&&a[1]==='checks') {
 emit(c.required??[{name:'validate',state:c.pending?'IN_PROGRESS':c.conclusion.toUpperCase(),link:'https://github.com/example/repo/actions/runs/123/job/456'}]);
 if(c.pending) process.exit(8);
 if(c.conclusion!=='success') process.exit(1);
} else if(a[0]==='api') {
 if(c.apiError) { console.error(c.apiError); process.exit(4); }
 const endpoint=a.at(-1);
 if(endpoint.endsWith('/check-runs')) emit([{check_runs:c.checks??[{id:456,name:'validate',head_sha:c.checksSha??head(),status:c.pending?'in_progress':'completed',conclusion:c.conclusion,details_url:'https://github.com/example/repo/actions/runs/123/job/456',output:{summary:c.summary??''}}]}]);
 else if(endpoint.endsWith('/status')) emit({sha:head(),statuses:c.statuses??[]});
 else process.exit(91);
} else if(a[0]==='run'&&a[1]==='view') emit(c.log);
else if(a[0]==='run'&&a[1]==='rerun') { c.reruns=(c.reruns??0)+1; save(); }
else if(a[0]==='pr'&&a[1]==='merge') { console.error('merge execution rejected by fixture'); process.exit(90); }
else { console.error('unexpected gh '+a.join(' ')); process.exit(92); }
`);
  writeFileSync(join(bin, "dagu"), `#!/usr/bin/env node\n${common}
if(a[0]==='status') {
 emit((c.running?'Running':'Waiting')+' - fixture');
 if(!c.running) {
  for(const s of c.statusStep==='both'?['await_ci','await_merge']:[c.statusStep]) emit('├─'+s+' [waiting]');
  emit('│ └─push-back iteration: '+c.iteration);
 }
} else if(a[0]==='human-task') {
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
  const state = join(primary, ".git/dagu-feature/runs/ci226");
  mkdirSync(state, { recursive: true });
  const identity = JSON.stringify({ primary, worktree, branch, run: "ci226", session: "ci226-owner" }) + "\n";
  writeFileSync(join(state, "identity"), identity);
  writeFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
  writeFileSync(join(state, "base"), git(primary, "rev-parse", "HEAD") + "\n");
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary, WORKTREE: worktree, BRANCH: branch, ISSUE: "226", RUN: "ci226", PR_NUMBER: "", BASE_BRANCH: "main", GATE: "true", OMP_SESSION_ID: "ci226-owner", CI_REMOTE: remote, CI_CONTROL: control, CI_CALLS: calls, DAGU_OUTPUT_FILE: join(root, "outputs") };
  env.IMPLEMENTER = "ImplementTest";
  env.QA = "QATest";
  env.REVIEW = "ReviewTest";
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
  const candidate = JSON.parse(readFileSync(join(f.state, "candidate.json"), "utf8"));
  const quality = qualityFixture(f, "PASS", {
    repo: f.primary, worktree: f.worktree, run: f.env.RUN!, sha: candidate.sha,
    iteration: candidate.iteration, attempt: "2026-10-16T01:00:00Z",
    implementer: f.env.IMPLEMENTER!, session: f.env.OMP_SESSION_ID!,
    implementStartedAt: "2026-10-16T00:00:00Z",
  });
  const evidence = verifyQuality(quality.parent, quality.request, f.env.QA!, f.env.REVIEW!, quality.models);
  writeFileSync(join(f.state, "quality.json"), JSON.stringify(evidence));
  for (const id of ["quality_admit", "push", "pr"]) {
    const result = execute(f, feature, id);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return git(f.worktree, "rev-parse", "HEAD");
}

for (const [name, base] of definitions) {
  const feature = readFileSync(fileURLToPath(new URL(`${base}feature.yaml`, import.meta.url)), "utf8");
  const reconcile = readFileSync(fileURLToPath(new URL(`${base}reconcile.yaml`, import.meta.url)), "utf8");
  test(`${name}: A CODE_FAIL returns implement, B PASS uses the same PR and rejects late A`, async t => {
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

  test(`${name}: all classes, rebase routes, retry backoff/exhaustion and stale iteration`, () => {
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
}

test("Dagu 2.20.1: paired root waits return to implement/rebase and release the queue", {
  ...liveDagu,
  timeout: 120_000,
}, async t => {
  const f = fixture();
  const feature = readFileSync(fileURLToPath(new URL("../skills/dagu-feature/feature.yaml", import.meta.url)), "utf8");
  const reconcile = readFileSync(fileURLToPath(new URL("../skills/dagu-feature/reconcile.yaml", import.meta.url)), "utf8");
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
  const definition = `type: graph\nshell: bash\nmax_active_steps: 1\nqueue: ci226\nparams:\n  - ISSUE: "226"\n  - PRIMARY: ${f.primary}\n  - BRANCH: ${f.branch}\n  - PR_NUMBER: "77"\nenv:\n${fixtureEnv}  - WORKTREE: ${f.worktree}\n  - RUN: ci226\nsteps:\n  - id: implement\n    action: human.task\n    with:\n      prompt: Correct candidate\n  - id: rebase\n    depends: implement\n    run: echo rebased\n  - id: auto_merge\n    depends: rebase\n    run: echo observed-publication\n${step(feature, "await_ci")}${step(feature, "await_merge")}${step(feature, "authorize_ci")}`;
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
      const response = await fetch(`${api}/dag-runs/feature/ci226`);
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
    dagu("enqueue", "--run-id", "ci226", path);
    await waiting("implement", 0);
    dagu("human-task", "complete", "feature", "--run-id", "ci226", "--step", "implement");
    await waiting("await_ci", 0);
    update(f, { conclusion: "failure", log: "AssertionError: candidate test failed" });
    assert.equal(observe(f, reconcile).class, "CODE_FAIL");
    transition(f, reconcile);
    const returned = await waiting("implement", 1);
    const ciDiagnostic = await readCiDiagnostic(f.primary, "ci226", true, new AbortController().signal);
    const wake = new Transitions("owner").observe({ ...returned, params: `${returned.params} OMP_SESSION_ID=owner` }, { ciDiagnostic: ciDiagnostic! }).wakeMessage!;
    assert.ok(wake.includes("step=implement") && wake.includes(a) && wake.includes("AssertionError"), wake);
    t.diagnostic(wake);
    const b = publish(f, feature, "candidate B");
    update(f, { conclusion: "success", checksSha: a, log: "" });
    dagu("human-task", "complete", "feature", "--run-id", "ci226", "--step", "implement");
    await waiting("await_ci", 1);
    assert.equal(observe(f, reconcile).class, "STALE_SHA");
    update(f, { checksSha: b, mergeState: "BEHIND" });
    assert.equal(observe(f, reconcile).action, "REBASE");
    transition(f, reconcile);
    await waiting("await_merge", 2);
    const stale = spawnSync("dagu", ["human-task", "push-back", "feature", "--run-id", "ci226", "--step", "await_merge", "--expected-iteration", "1"], { env: f.env, encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /iteration 2, not 1/);
    await waiting("await_merge", 2);
    dagu("enqueue", "--run-id", "queue-released", "queue-probe");
    await until("same queue progresses while paired tasks wait", async () => {
      const response = await fetch(`${api}/dag-runs/queue-probe/queue-released`);
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
      const response = await fetch(`${api}/dag-runs/feature/ci226`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: RunDetails }).dagRunDetails;
      assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
      return run.statusLabel === "succeeded" ? true : undefined;
    });
    const history = JSON.parse(dagu("history", "feature", "--format", "json"));
    assert.equal(history.length, 1);
    assert.equal(history[0].dagRunId, "ci226");
    assert.equal(git(f.primary, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], f.base);
    t.diagnostic(JSON.stringify({ version: liveDaguVersion, home, port, run: "ci226", worktree: f.worktree, pr: 77, a, b, iterations: [0, 1, 2], result: "succeeded", queue: "released" }));
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => service.exitCode !== null ? resolve() : service.once("exit", () => resolve()));
    rmSync(f.root, { recursive: true, force: true });
  }
});
