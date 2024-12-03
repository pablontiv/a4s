import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { compiledA4sBin, compiledArtifact } from "../fixtures/admission.ts";
import { reconcileEnvironment } from "../role-job-fixtures.ts";
import { artifactToken } from "../../src/release.ts";

const a4sBin = compiledA4sBin();

const reconcile = readFileSync(new URL("../../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8");
const documents = parseAllDocuments(reconcile).map(document => document.toJS() as Record<string, unknown>);
const rootDag = documents[0]!;
const tick = (rootDag.steps as Array<{ id: string; parallel?: { max_concurrent?: number } }>).find(step => step.id === "tick");
const concurrency = tick?.parallel?.max_concurrent ?? 0;

function step(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, id);
  const end = source.indexOf("\n  - id:", start + 1);
  return source.slice(start, end < 0 ? source.length : end) + "\n";
}
function script(id: string): string {
  const block = step(reconcile, id).split("    run: |\n")[1];
  assert.ok(block, id);
  const lines = block.split("\n");
  const end = lines.findIndex(line => line && !line.startsWith("      "));
  return lines.slice(0, end < 0 ? lines.length : end).map(line => line.slice(6)).join("\n");
}
function metrics(stderr: string): Array<Record<string, unknown>> {
  return stderr.split("\n").filter(line => line.startsWith("reconcile-metric ")).map(line => JSON.parse(line.slice("reconcile-metric ".length)) as Record<string, unknown>);
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function initPrimary(root: string, name: string): string {
  const remote = join(root, `${name}.git`);
  const primary = join(root, name);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
  git(primary, "config", "user.name", "Reconcile test");
  git(primary, "config", "user.email", "reconcile@example.test");
  git(primary, "remote", "add", "origin", remote);
  writeFileSync(join(primary, "README"), `${name}\n`);
  git(primary, "add", ".");
  git(primary, "commit", "-m", name);
  return primary;
}
interface RunResult { status: number | null; stdout: string; stderr: string; started: number; ended: number }
function runBash(source: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  env = reconcileEnvironment(env);
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn("bash", ["-c", source], { env: { A4S_BIN: a4sBin, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr, started, ended: performance.now() }));
  });
}
async function mapLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<number> {
  let active = 0;
  let max = 0;
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      active += 1;
      max = Math.max(max, active);
      try { await task(item); }
      finally { active -= 1; }
    }
  }));
  return max;
}
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

test("discover keeps an old Waiting run past the page cap and resolves each repository once", async t => {
  assert.equal(rootDag.schedule, "* * * * *");
  assert.equal(rootDag.overlap_policy, "skip");
  assert.equal(rootDag.catchup_window, "");
  assert.ok(concurrency > 1 && concurrency <= 8, `observation fan-out ${concurrency}`);
  const root = mkdtempSync(join(tmpdir(), "reconcile-discover-"));
  const alpha = initPrimary(root, "alpha");
  const beta = initPrimary(root, "beta");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    requests.push(`${request.method} ${url.pathname}?${url.searchParams.toString()}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/needs-spec/spec")) {
      response.end(JSON.stringify({ spec: `params:\n  - PRIMARY: ${JSON.stringify(alpha)}\n` }));
      return;
    }
    const fromDate = url.searchParams.get("fromDate");
    const status = url.searchParams.get("status");
    const cursor = url.searchParams.get("cursor") ?? "";
    if (fromDate !== "0" || status !== "7") {
      response.end(JSON.stringify({ dagRuns: [] }));
      return;
    }
    const row = (id: string, primary: string, issue: string) => ({
      dagRunId: id, name: "feature", status: 7, statusLabel: "waiting",
      startedAt: id === "old-active" ? "2020-01-01T00:00:00Z" : "2026-10-25T00:00:00Z",
      params: primary ? `ISSUE=${issue} PRIMARY=${primary} BRANCH=dagu/issue-${issue}` : `ISSUE=${issue}`,
    });
    if (!cursor) {
      response.end(JSON.stringify({
        dagRuns: [row("new-a", alpha, "1"), row("new-a", alpha, "1"), row("new-b", beta, "2"), row("needs-spec", "", "9")],
        nextCursor: "older",
      }));
      return;
    }
    if (cursor === "older") {
      response.end(JSON.stringify({ dagRuns: [row("old-active", alpha, "3")] }));
      return;
    }
    response.end(JSON.stringify({ dagRuns: [] }));
  });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "view") {
  console.log(String(args[2]).includes("beta") ? "example/beta" : "example/alpha");
} else process.exit(91);
`);
  chmodSync(join(bin, "gh"), 0o755);
  const port = await listen(server);
  try {
    const result = await runBash(script("discover"), {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, DAGU_PORT: String(port), GH_CALLS: calls,
    });
    assert.equal(result.status, 0, result.stderr);
    const selected = JSON.parse(result.stdout) as Array<{ RUN: string; REPO: string; PRIMARY: string }>;
    const metric = metrics(result.stderr).find(item => item.phase === "discover");
    assert.ok(metric);
    const ids = selected.map(run => run.RUN).sort();
    assert.deepEqual(ids, ["needs-spec", "new-a", "new-b", "old-active"]);
    assert.equal(selected.find(run => run.RUN === "old-active")?.REPO, "example/alpha");
    assert.equal(selected.find(run => run.RUN === "new-b")?.REPO, "example/beta");
    assert.equal(selected.find(run => run.RUN === "needs-spec")?.PRIMARY, alpha);
    const repoViews = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(repoViews.length, 2);
    assert.equal(metric.pages, 2);
    assert.equal(metric.inputRuns, 5);
    assert.equal(metric.selected, 4);
    assert.equal(metric.skipped, 1);
    assert.equal(metric.repoLookups, 2);
    assert.equal(metric.specLookups, 1);
    assert.equal(metric.callTimeoutSeconds, 8);
    assert.equal(metric.discoverTimeoutSeconds, 20);
    assert.ok(Number(metric.latencyMs) >= 0);
    assert.ok(requests.some(path => path.includes("fromDate=0") && path.includes("status=7") && !path.includes("cursor=")));
    assert.ok(requests.some(path => path.includes("cursor=older")));
    t.diagnostic(JSON.stringify({
      concurrency, requests: requests.length, inputRuns: metric.inputRuns, selected: metric.selected,
      skipped: metric.skipped, repoLookups: metric.repoLookups, specLookups: metric.specLookups,
      pages: metric.pages, calls: metric.calls, latencyMs: metric.latencyMs,
    }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slow or repeating GitHub page does not emit a partial list or unbounded requests", async t => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-discover-bound-"));
  let mode: "slow" | "stuck" = "slow";
  let hits = 0;
  const server = createServer(async (request, response) => {
    hits += 1;
    if (mode === "slow") await delay(1500);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      dagRuns: [{ dagRunId: "should-not-select", params: "ISSUE=1 PRIMARY=/none", status: 7, statusLabel: "waiting" }],
      nextCursor: "stuck",
    }));
  });
  const port = await listen(server);
  try {
    const slow = await runBash(script("discover"), {
      ...process.env, DAGU_PORT: String(port), RECONCILE_CALL_TIMEOUT_SECONDS: "0.3", RECONCILE_DISCOVER_TIMEOUT_SECONDS: "0.3",
    });
    assert.notEqual(slow.status, 0);
    assert.equal(slow.stdout.trim(), "");
    assert.equal(hits, 1);
    const slowHits = hits;
    mode = "stuck";
    const stuck = await runBash(script("discover"), { ...process.env, DAGU_PORT: String(port) });
    assert.notEqual(stuck.status, 0);
    assert.match(stuck.stderr, /cursor did not advance/);
    assert.equal(slow.stdout.includes("should-not-select"), false);
    assert.equal(stuck.stdout.includes("should-not-select"), false);
    assert.equal(hits - slowHits, 2);
    t.diagnostic(JSON.stringify({ slowStatus: slow.status, slowRequests: slowHits, stuckRequests: hits - slowHits, stuckLatencyMs: Math.round(stuck.ended - stuck.started) }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

function writeMockBin(bin: string, calls: string, control: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(process.env.CI_CONTROL, "utf8"));
const run = process.env.RUN || "";
const delay = Number((control.delays || {})[run] || 0);
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify({ at: Date.now(), run, args }) + "\\n");
if (delay) spawnSync("sleep", [String(delay / 1000)]);
const head = () => control.head;
if (args[0] === "repo" && args[1] === "view") { console.log("example/repo"); }
else if (args[0] === "issue" && args[1] === "view") {
  if (control.failIssue) process.exit(1);
  if (control.hangIssue) spawnSync("sleep", ["30"]);
  console.log("OPEN closed_at=");
} else if (args[0] === "pr" && args[1] === "view") {
  if (args.includes("--jq")) console.log(args.join(" ").includes("headRefOid") ? head() : args.join(" ").includes("autoMergeRequest") ? false : "77");
  else console.log(JSON.stringify({ number: 77, state: "OPEN", mergeStateStatus: "CLEAN", autoMergeRequest: null, headRefOid: head(), statusCheckRollup: [] }));
} else if (args[0] === "pr" && args[1] === "checks") {
  console.log(JSON.stringify([{ name: "validate", state: "FAILURE", link: "https://github.com/example/repo/actions/runs/123/job/456" }]));
  process.exit(1);
} else if (args[0] === "api") {
  const endpoint = args.at(-1);
  if (String(endpoint).includes("/check-runs")) console.log(JSON.stringify([{ check_runs: [{ id: 456, name: "validate", head_sha: head(), status: "completed", conclusion: "failure", details_url: "https://github.com/example/repo/actions/runs/123/job/456", output: { summary: "Runner lost communication with the server" } }] }]));
  else if (String(endpoint).endsWith("/status?per_page=100")) console.log(JSON.stringify([{ sha: head(), statuses: [] }]));
  else process.exit(91);
} else if (args[0] === "run" && args[1] === "view") console.log("Runner lost communication with the server");
else if (args[0] === "run" && args[1] === "rerun") {
  const started = Date.now();
  spawnSync("sleep", ["0.25"]);
  control.reruns = (control.reruns || 0) + 1;
  fs.writeFileSync(process.env.CI_CONTROL, JSON.stringify(control));
  fs.appendFileSync(process.env.CI_CALLS, JSON.stringify({ at: Date.now(), run, event: "rerun", started, ended: Date.now() }) + "\\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  const started = Date.now();
  spawnSync("sleep", ["0.25"]);
  control.merges = (control.merges || 0) + 1;
  control.head = "f".repeat(40);
  fs.writeFileSync(process.env.CI_CONTROL, JSON.stringify(control));
  fs.appendFileSync(process.env.CI_CALLS, JSON.stringify({ at: Date.now(), run, event: "merge", started, ended: Date.now() }) + "\\n");
} else process.exit(92);
`);
  writeFileSync(join(bin, "dagu"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(process.env.CI_CONTROL, "utf8"));
const run = process.env.RUN || "";
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify({ at: Date.now(), run, tool: "dagu", args }) + "\\n");
const iterationOf = (value, id) => Number((value.iterations || {})[id] ?? 0);
if (args[0] === "status") {
  console.log((control.running ? "Running" : "Waiting") + " - fixture");
  if (!control.running) {
    console.log("├─" + (control.step || "implement") + " [waiting]");
    console.log("│ └─push-back iteration: " + iterationOf(control, run));
  }
} else if (args[0] === "human-task") {
  const started = Date.now();
  spawnSync("sleep", ["0.3"]);
  const fresh = JSON.parse(fs.readFileSync(process.env.CI_CONTROL, "utf8"));
  const expected = Number(args[args.indexOf("--expected-iteration") + 1]);
  const current = iterationOf(fresh, run);
  if (args[1] === "push-back" && expected !== current) { console.error("stale iteration"); process.exit(1); }
  if (args[1] === "push-back") {
    fresh.iterations = { ...(fresh.iterations || {}), [run]: current + 1 };
    fresh.iteration = fresh.iterations[run];
  }
  fs.writeFileSync(process.env.CI_CONTROL, JSON.stringify(fresh));
  fs.appendFileSync(process.env.CI_CALLS, JSON.stringify({ at: Date.now(), run, event: "human-task", started, ended: Date.now() }) + "\\n");
} else process.exit(93);
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "dagu"), 0o755);
  writeFileSync(control, JSON.stringify({ iteration: 0, step: "implement", head: "", delays: {} }));
}

test("one slow observation does not stall independent runs or retry the call", async t => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-fanout-"));
  const primary = initPrimary(root, "primary");
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  const control = join(root, "control.json");
  writeFileSync(calls, "");
  writeMockBin(bin, calls, control);
  const head = git(primary, "rev-parse", "HEAD");
  const runs = ["slow", ...Array.from({ length: 6 }, (_, index) => `fast-${index}`)];
  writeFileSync(control, JSON.stringify({
    iteration: 0, step: "implement", head,
    delays: Object.fromEntries(runs.map(run => [run, run === "slow" ? 800 : 40])),
  }));
  const results = new Map<string, RunResult>();
  const started = performance.now();
  try {
    const inFlight = await mapLimit(runs, concurrency, async run => {
      const env: NodeJS.ProcessEnv = {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary, RUN: run, ISSUE: "250",
        BRANCH: "dagu/issue-250", PR_NUMBER: "", REPO: "example/repo", CI_CONTROL: control, CI_CALLS: calls,
        CI_OBSERVATION_ID: "tick-1", ESCALATION_CI_BLOCKED: "2", DAGU_OUTPUT_FILE: join(root, `${run}.out`),
        RECONCILE_CALL_TIMEOUT_SECONDS: "5", RECONCILE_OBSERVE_TIMEOUT_SECONDS: "5",
      };
      const result = await runBash(script("observe"), env);
      results.set(run, result);
    });
    const wall = performance.now() - started;
    for (const [run, result] of results) assert.equal(result.status, 0, `${run}\n${result.stderr}`);
    const slow = results.get("slow")!;
    const fastEnds = [...results.entries()].filter(([run]) => run !== "slow").map(([, result]) => result.ended);
    assert.ok(fastEnds.filter(ended => ended < slow.ended).length >= 3, JSON.stringify(fastEnds.map(ended => Math.round(ended - slow.started))));
    assert.ok(inFlight > 1 && inFlight <= concurrency, `inFlight=${inFlight} concurrency=${concurrency}`);
    const serial = [...results.values()].reduce((sum, result) => sum + (result.ended - result.started), 0);
    assert.ok(wall < serial * 0.6, `wall ${Math.round(wall)} serial ${Math.round(serial)}`);
    const observations = [...results.values()].map(result => metrics(result.stderr).find(item => item.phase === "observe"));
    assert.ok(observations.every(item => item?.skippedRepoLookup === true && item.calls === 2 && item.deadline === false));
    const issueCalls = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args?: string[]; run: string }).filter(call => call.args?.[0] === "issue");
    assert.equal(issueCalls.length, runs.length);
    assert.equal(issueCalls.filter(call => call.run === "slow").length, 1);
    t.diagnostic(JSON.stringify({
      inputRuns: runs.length, concurrency, inFlight, wallMs: Math.round(wall), serialMs: serial,
      latenciesMs: Object.fromEntries([...results.entries()].map(([run, result]) => [run, Math.round(result.ended - result.started)])),
      skippedRepoLookups: observations.length, calls: issueCalls.length,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable GitHub response is one bounded call and stays BLOCKED", async t => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-unavailable-"));
  const primary = initPrimary(root, "primary");
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  const control = join(root, "control.json");
  writeFileSync(calls, "");
  writeMockBin(bin, calls, control);
  const head = git(primary, "rev-parse", "HEAD");
  const baseEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary, RUN: "unavailable", ISSUE: "250",
    BRANCH: "dagu/issue-250", PR_NUMBER: "", REPO: "example/repo", CI_CONTROL: control, CI_CALLS: calls,
    CI_OBSERVATION_ID: "tick-unavailable", ESCALATION_CI_BLOCKED: "2", DAGU_OUTPUT_FILE: join(root, "out"),
    RECONCILE_CALL_TIMEOUT_SECONDS: "0.4", RECONCILE_OBSERVE_TIMEOUT_SECONDS: "0.4",
  };
  try {
    writeFileSync(control, JSON.stringify({ iteration: 0, step: "implement", head, hangIssue: true }));
    const hung = await runBash(script("observe"), baseEnv);
    assert.equal(hung.status, 0, hung.stderr);
    const hungMetric = metrics(hung.stderr).find(item => item.phase === "observe");
    const hungObservation = JSON.parse(readFileSync(join(primary, ".git/dagu-feature/runs/unavailable/ci-observation.json"), "utf8"));
    assert.equal(hungObservation.class, "BLOCKED");
    assert.equal(hungObservation.action, "WAIT");
    assert.equal(hungMetric?.deadline, true);
    assert.equal(hungMetric?.calls, 2);
    assert.ok(Number(hungMetric?.latencyMs) < 1500, String(hungMetric?.latencyMs));
    const hangCalls = readFileSync(calls, "utf8").trim().split("\n").filter(line => JSON.parse(line).args?.[0] === "issue");
    assert.equal(hangCalls.length, 1);
    writeFileSync(calls, "");
    writeFileSync(control, JSON.stringify({ iteration: 0, step: "implement", head, failIssue: true }));
    const failed = await runBash(script("observe"), { ...baseEnv, CI_OBSERVATION_ID: "tick-fail" });
    assert.equal(failed.status, 0, failed.stderr);
    const failedObservation = JSON.parse(readFileSync(join(primary, ".git/dagu-feature/runs/unavailable/ci-observation.json"), "utf8"));
    const failedMetric = metrics(failed.stderr).find(item => item.phase === "observe");
    assert.equal(failedObservation.class, "BLOCKED");
    assert.equal(failedMetric?.deadline, false);
    assert.equal(failedMetric?.calls, 2);
    t.diagnostic(JSON.stringify({
      hungLatencyMs: hungMetric?.latencyMs, hungCalls: hangCalls.length, failedLatencyMs: failedMetric?.latencyMs,
      failedCalls: failedMetric?.calls, skipped: 0,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function observation(primary: string, run: string, action: string, sha: string, extra: Record<string, unknown> = {}): string {
  const state = join(primary, ".git/dagu-feature/runs", run);
  mkdirSync(state, { recursive: true });
  const file = join(state, "ci-observation.json");
  writeFileSync(file, JSON.stringify({
    repo: "example/repo", run, pr: extra.pr ?? "77", worktree: primary, step: extra.step ?? "await_ci",
    iteration: 0, sha, class: extra.class ?? "CODE_FAIL", action, check: "validate", log: "", cause: "test",
    retry_run: extra.retry_run ?? "", findings: [],
  }));
  return file;
}
function events(calls: string, name: string): Array<{ run: string; started: number; ended: number }> {
  return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { event?: string; run: string; started?: number; ended?: number }).filter(event => event.event === name && event.started && event.ended) as Array<{ run: string; started: number; ended: number }>;
}

test("transient reruns and conflicting transitions apply once while independent runs overlap", async t => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-transition-"));
  const primary = initPrimary(root, "primary");
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  const control = join(root, "control.json");
  writeFileSync(calls, "");
  writeMockBin(bin, calls, control);
  const sha = git(primary, "rev-parse", "HEAD");
  const envFor = (run: string, step = "await_ci"): NodeJS.ProcessEnv => ({
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary, RUN: run, ISSUE: "250",
    BRANCH: "dagu/issue-250", PR_NUMBER: "77", REPO: "example/repo", CI_CONTROL: control, CI_CALLS: calls,
    CI_OBSERVATION_ID: `obs-${run}`, ESCALATION_CI_BLOCKED: "2", DAGU_OUTPUT_FILE: join(root, `${run}.out`),
  });
  try {
    writeFileSync(control, JSON.stringify({ iteration: 0, step: "await_ci", head: sha }));
    const observed = await runBash(script("observe"), envFor("transient"));
    assert.equal(observed.status, 0, observed.stderr);
    const transient = JSON.parse(readFileSync(join(primary, ".git/dagu-feature/runs/transient/ci-observation.json"), "utf8"));
    assert.equal(transient.class, "TRANSIENT");
    assert.equal(transient.action, "RETRY");
    const observeMetric = metrics(observed.stderr).find(item => item.phase === "observe");
    const pair = await Promise.all([runBash(script("transition"), envFor("transient")), runBash(script("transition"), envFor("transient"))]);
    const reruns = events(calls, "rerun");
    assert.equal(reruns.length, 1);
    const transitionMetrics = pair.flatMap(result => metrics(result.stderr).filter(item => item.phase === "transition"));
    assert.equal(transitionMetrics.filter(item => item.applied === true && item.cause === "rerun").length, 1);
    assert.equal(transitionMetrics.filter(item => item.applied === false && item.cause === "backoff").length, 1);
    assert.ok(pair.filter(result => result.status === 0).length === 2);

    writeFileSync(calls, "");
    writeFileSync(control, JSON.stringify({ iteration: 0, step: "await_ci", head: sha }));
    observation(primary, "stale-iteration", "IMPLEMENT", sha, { class: "CODE_FAIL" });
    const stale = await Promise.all([runBash(script("transition"), envFor("stale-iteration")), runBash(script("transition"), envFor("stale-iteration"))]);
    assert.equal(events(calls, "human-task").length, 1);
    assert.equal(stale.filter(result => result.status === 0).length, 1);
    assert.match(stale.find(result => result.status === 1)!.stderr, /Stale iteration/);
    const pushes = events(calls, "human-task");
    const staleMetrics = stale.flatMap(result => metrics(result.stderr));
    assert.equal(staleMetrics.filter(item => item.cause === "stale-iteration").length, 1);

    writeFileSync(calls, "");
    writeFileSync(control, JSON.stringify({ iteration: 0, step: "await_merge", head: sha }));
    observation(primary, "stale-sha", "MERGE", sha, { class: "PASS", step: "await_merge" });
    const merged = await Promise.all([
      runBash(script("transition"), envFor("stale-sha", "await_merge")),
      runBash(script("transition"), envFor("stale-sha", "await_merge")),
    ]);
    assert.equal(events(calls, "merge").length, 1);
    assert.equal(merged.filter(result => result.status === 0).length, 1);
    assert.match(merged.find(result => result.status !== 0)!.stderr, /STALE_SHA/);

    writeFileSync(calls, "");
    const left = "independent-left";
    const right = "independent-right";
    observation(primary, left, "IMPLEMENT", sha, { pr: "101" });
    observation(primary, right, "IMPLEMENT", sha, { pr: "202" });
    writeFileSync(control, JSON.stringify({ iteration: 0, step: "await_ci", head: sha }));
    const independent = await Promise.all([
      runBash(script("transition"), envFor(left)),
      runBash(script("transition"), envFor(right)),
    ]);
    assert.ok(independent.every(result => result.status === 0), independent.map(result => result.stderr).join("\n"));
    const human = events(calls, "human-task");
    assert.equal(human.length, 2);
    const [first, second] = human.sort((a, b) => a.started - b.started);
    assert.ok(first && second && second.started < first.ended, JSON.stringify(human));
    t.diagnostic(JSON.stringify({
      observeLatencyMs: observeMetric?.latencyMs, observeCalls: observeMetric?.calls,
      transientReruns: reruns.length, staleIterationApplies: pushes.length,
      staleShaMerges: 1, independentOverlap: second!.started < first!.ended,
      transitionLatenciesMs: [...transitionMetrics, ...staleMetrics].map(item => ({ cause: item.cause, latencyMs: item.latencyMs, applied: item.applied })),
      concurrency,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Dagu validates the reconciler and isolated ticks stay inside the minute", {
  ...liveDagu,
  timeout: 240_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-live-"));
  const home = join(root, "dagu-home");
  const bin = join(root, "bin");
  mkdirSync(join(home, "dags"), { recursive: true });
  mkdirSync(bin);
  const artifact = compiledArtifact(home);
  const source = execFileSync(a4sBin, ["reconcile", "render", "--artifact", artifactToken(artifact)], {
    env: { ...process.env, DAGU_HOME: home }, encoding: "utf8",
  });
  const materialized = join(home, "dags", "reconcile.yaml");
  writeFileSync(materialized, source);
  writeFileSync(join(home, "config.yaml"), "auth:\n  mode: none\ncoordinator:\n  enabled: false\n");
  const listener = createServer();
  const port = await listen(listener);
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, A4S_BIN: a4sBin, PATH: `${bin}:${process.env.PATH}`, DAGU_HOME: home, DAGU_PORT: String(port) };
  let server: ReturnType<typeof spawn> | undefined;
  let scheduler: ReturnType<typeof spawn> | undefined;
  let logs = "";
  try {
    execFileSync("dagu", ["validate", materialized], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    server = spawn("dagu", ["server", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.on("data", chunk => { logs += chunk; });
    server.stderr?.on("data", chunk => { logs += chunk; });
    const ready = Date.now() + 20_000;
    while (Date.now() < ready) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) break; } catch { /* starting */ }
      await delay(100);
    }
    const durations: number[] = [];
    for (const attempt of [1, 2]) {
      const started = performance.now();
      const run = spawnSync("dagu", ["start", "--run-id", `reconcile-tick-${attempt}`, materialized], { env, encoding: "utf8" });
      const elapsed = performance.now() - started;
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${logs}`);
      assert.ok(elapsed < 60_000, `tick ${attempt} took ${elapsed}ms`);
      durations.push(Math.round(elapsed));
    }
    scheduler = spawn("dagu", ["scheduler"], { env, stdio: ["ignore", "pipe", "pipe"] });
    scheduler.stdout?.on("data", chunk => { logs += chunk; });
    scheduler.stderr?.on("data", chunk => { logs += chunk; });
    const deadline = Date.now() + 150_000;
    let scheduled: Array<{ dagRunId?: string; status?: string; startedAt?: string; finishedAt?: string }> = [];
    while (Date.now() < deadline) {
      const history = spawnSync("dagu", ["history", "reconcile", "--format", "json", "--from", "1970-01-01", "--limit", "20"], { env, encoding: "utf8" });
      if (history.status === 0) {
        const rows = JSON.parse(history.stdout) as typeof scheduled;
        scheduled = rows.filter(row => row.status === "succeeded" && !String(row.dagRunId).startsWith("reconcile-tick-"));
        if (scheduled.length >= 2) break;
      }
      await delay(1000);
    }
    assert.ok(scheduled.length >= 2, `scheduled ticks ${scheduled.length}\n${logs}`);
    const spans = scheduled.slice(0, 2).map(row => Date.parse(row.finishedAt || "") - Date.parse(row.startedAt || ""));
    assert.ok(spans.every(span => Number.isFinite(span) && span >= 0 && span < 60_000), JSON.stringify(scheduled));
    t.diagnostic(JSON.stringify({
      version: liveDaguVersion, validate: "ok", isolatedTickMs: durations, scheduledTicks: scheduled.length,
      scheduledSpanMs: spans, operatorUnderLoadProof: "skipped",
    }));
  } finally {
    scheduler?.kill("SIGTERM");
    server?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
