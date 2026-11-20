import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishRun, labelNames, readCarry, readHandled, recordHandled, runOutcome, source } from "../src/labels.mjs";
import { latestRuns, listRunningIssues, reconcile } from "../src/reconcile.mjs";

function fx(labels = ["factory:running"]) {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  const file = join(dir, "issues.json");
  writeFileSync(file, JSON.stringify([{ number: 9, labels: labels.map((name) => ({ name })) }]));
  const state = join(dir, "state");
  mkdirSync(join(state, "9"), { recursive: true });
  const seed = (line, attempts) => writeFileSync(join(state, "9", `${line}.json`), JSON.stringify({ attempts }));
  const issues = () => JSON.parse(readFileSync(file, "utf8"));
  return { file, state, seed, issues, labels: () => labelNames(issues()[0]), src: source({ issuesFile: file }) };
}
const quiet = () => {};
const runs = (status, id = "factory-issue-9-1") => latestRuns([{ name: "cycle", dagRunId: id, statusLabel: status }]);

test("reconciles a finished failed run left in factory:running", () => {
  const f = fx();
  f.seed("impl", [{ outcome: "fail", findings: ["F1"] }]);
  const done = reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: runs("failed"), stepsOf: () => "prepare=succeeded,implement=failed", log: quiet });
  assert.deepEqual(done.map((d) => d.runId), ["factory-issue-9-1"]);
  assert.deepEqual(f.labels(), ["factory:ready"]);
  assert.deepEqual(readCarry(f.state, 9).findings, ["F1"]);
  assert.deepEqual({ ...readHandled(f.state, 9), at: 0 }, { run: "factory-issue-9-1", event: "failure", at: 0, ok: true });
});

test("reconciles a finished successful run", () => {
  const f = fx(["factory", "factory:running"]);
  reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: runs("succeeded"), log: quiet });
  assert.deepEqual(f.labels(), ["factory"]);
  assert.equal(readHandled(f.state, 9).event, "success");
});

test("leaves queued and running runs alone, and a run with no Dagu record", () => {
  for (const st of ["queued", "running", "waiting"]) {
    const f = fx();
    assert.equal(reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: runs(st), log: quiet }).length, 0);
    assert.deepEqual(f.labels(), ["factory:running"]);
    assert.equal(readHandled(f.state, 9), null);
  }
  const f = fx();
  assert.equal(reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: new Map(), log: quiet }).length, 0);
});

test("only the latest run counts, and a second pass is a no-op", () => {
  const f = fx();
  f.seed("impl", [{ outcome: "fail", findings: ["F1"] }]);
  const rs = latestRuns([{ name: "cycle", dagRunId: "factory-issue-9-1", statusLabel: "failed" }, { name: "cycle", dagRunId: "factory-issue-9-2", statusLabel: "running" }]);
  assert.equal(reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: rs, log: quiet }).length, 0);
  const fin = runs("failed");
  assert.equal(reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: fin, stepsOf: () => "implement=failed", log: quiet }).length, 1);
  // relabelled running by hand with the same finished run: the successful record skips it
  f.src.set(9, ["factory:running"], ["factory:ready"]);
  assert.equal(reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: fin, stepsOf: () => "implement=failed", log: quiet }).length, 0);
  assert.deepEqual(f.labels(), ["factory:running"]);
});

test("a record with ok:false is retried", () => {
  const f = fx();
  f.seed("impl", [{ outcome: "fail" }]);
  recordHandled(f.state, 9, "factory-issue-9-1", "failure", false);
  assert.equal(reconcile({ src: f.src, issues: f.issues(), state: f.state, runs: runs("failed"), stepsOf: () => "implement=failed", log: quiet }).length, 1);
  assert.equal(readHandled(f.state, 9).ok, true);
});

test("a failing repair with no findings is infra and keeps the QA round's findings", () => {
  for (const outcome of ["infra", "stuck", "fail"]) {
    const f = fx();
    f.seed("qa", [{ startedAt: 100, outcome: "fail", findings: ["lease race", "wait accounting"] }]);
    f.seed("impl", [{ startedAt: 50, outcome: "pass" }, { startedAt: 200, outcome, findings: [] }]);
    assert.equal(runOutcome(f.state, 9, "qa"), "infra", outcome);
    const r = finishRun(f.src, { issue: 9, state: f.state, run: "r", steps: "require_pass=succeeded,qa=failed" });
    assert.equal(r.outcome, "infra");
    assert.equal(r.to, "ready");
    assert.deepEqual(readCarry(f.state, 9).findings, ["lease race", "wait accounting"]);
  }
});

test("a repair that failed with findings, or a failed QA round, keeps its own outcome", () => {
  const f = fx();
  f.seed("qa", [{ startedAt: 100, outcome: "fail", findings: ["q"] }]);
  f.seed("impl", [{ startedAt: 200, outcome: "fail", findings: ["real"] }]);
  assert.equal(runOutcome(f.state, 9, "qa"), "fail");
  const g = fx();
  g.seed("impl", [{ startedAt: 50, outcome: "pass" }]);
  g.seed("qa", [{ startedAt: 100, outcome: "fail", findings: ["q"] }]);
  assert.equal(runOutcome(g.state, 9, "qa"), "fail");
});

test("repair-infra at the run budget limit does not park the issue, refunds the run and keeps the findings", () => {
  const f = fx();
  writeFileSync(join(f.state, "9", "attempts.json"), JSON.stringify({ last: 3, streak: 3, parked: false }));
  f.seed("qa", [{ startedAt: 100, outcome: "fail", findings: ["lease race"] }]);
  f.seed("impl", [{ startedAt: 200, outcome: "infra", findings: [] }]);
  const r = finishRun(f.src, { issue: 9, state: f.state, run: "r", steps: "qa=failed" });
  assert.equal(r.to, "ready");
  assert.equal(r.outcome, "infra");
  assert.deepEqual(f.labels(), ["factory:ready"]);
  assert.deepEqual(readCarry(f.state, 9).findings, ["lease race"]);
  assert.equal(JSON.parse(readFileSync(join(f.state, "9", "attempts.json"), "utf8")).streak, 2);
});

test("a QA-only fail with no findings (no repair ran) is not repair infra", () => {
  const f = fx();
  f.seed("impl", [{ startedAt: 50, outcome: "pass" }]);
  f.seed("qa", [{ startedAt: 100, outcome: "fail", findings: [] }]);
  assert.equal(runOutcome(f.state, 9, "qa"), "fail");
  const g = fx();
  g.seed("qa", [{ startedAt: 100, outcome: "fail", findings: [] }]);
  assert.equal(runOutcome(g.state, 9, "qa"), "fail");
});

test("repair-infra refund is idempotent per run across a GitHub outage and retry", () => {
  const f = fx();
  writeFileSync(join(f.state, "9", "attempts.json"), JSON.stringify({ last: 3, streak: 3, parked: false }));
  f.seed("qa", [{ startedAt: 100, outcome: "fail", findings: ["q"] }]);
  f.seed("impl", [{ startedAt: 200, outcome: "infra", findings: [] }]);
  const real = f.src.set;
  let down = 2;
  f.src.set = (...a) => { if (down-- > 0) throw new Error("network down"); return real(...a); };
  const args = { issue: 9, state: f.state, run: "r", steps: "qa=failed" };
  assert.throws(() => finishRun(f.src, args));
  assert.throws(() => finishRun(f.src, args));
  finishRun(f.src, args);
  assert.equal(JSON.parse(readFileSync(join(f.state, "9", "attempts.json"), "utf8")).streak, 2);
  assert.deepEqual(f.labels(), ["factory:ready"]);
});

test("running-issue discovery pages to exhaustion (issue beyond the first page, PRs excluded)", () => {
  const mk = (n) => ({ number: n, labels: [{ name: "factory:running" }] });
  const pages = [Array.from({ length: 100 }, (_, i) => mk(i + 1)), Array.from({ length: 100 }, (_, i) => mk(i + 101)), [mk(201), { ...mk(202), pull_request: {} }]];
  let args;
  const got = listRunningIssues("o/r", (a) => { args = a; return { status: 0, stdout: JSON.stringify(pages) }; });
  assert.ok(args.includes("--paginate") && args.includes("--slurp"));
  assert.equal(got.length, 201);
  assert.equal(got.at(-1).number, 201);
});

test("listRunningIssues normalises HTTPS and SSH remotes to owner/repo", () => {
  for (const remote of ["https://github.com/pablontiv/a4s.git", "git@github.com:pablontiv/a4s.git", "pablontiv/a4s"]) {
    let args;
    listRunningIssues(remote, (a) => { args = a; return { status: 0, stdout: "[]" }; });
    assert.ok(args.some((x) => x.startsWith("repos/pablontiv/a4s/issues?")), remote);
  }
});
