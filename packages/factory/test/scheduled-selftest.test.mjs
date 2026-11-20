import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, changedVersions, failingChecks, run, readHistory, historyFile, appendHistory, formatNotice } from "../src/scheduled-selftest.mjs";
import { evaluate } from "../src/breaker.mjs";

const P = { result: "pass" }, F = { result: "fail" }, S = { result: "skipped" };
const D = (runs, current, busy = false) => decide({ runs, current, busy });

test("decide: red notifies; first red does not open the breaker", () => {
  assert.deepEqual(D([], F), { action: "notify", openBreaker: false });
  assert.deepEqual(D([P], F), { action: "notify", openBreaker: false });
});
test("decide: two consecutive reds open the breaker; skipped runs in between do not break the streak", () => {
  assert.deepEqual(D([P, F], F), { action: "notify", openBreaker: true });
  assert.deepEqual(D([F, S, S], F), { action: "notify", openBreaker: true });
});
test("decide: green after red recovers once; consecutive greens send nothing", () => {
  assert.deepEqual(D([F], P), { action: "recover", openBreaker: false });
  assert.deepEqual(D([P, F, S], P), { action: "recover", openBreaker: false });
  assert.deepEqual(D([F, P], P), { action: "none", openBreaker: false });
  assert.deepEqual(D([], P), { action: "none", openBreaker: false });
});
test("decide: busy skips whatever the result", () => {
  assert.deepEqual(D([F], P, true), { action: "skip", openBreaker: false });
  assert.deepEqual(D([P, F], F, true), { action: "skip", openBreaker: false });
});
test("decide: unknown result throws", () => assert.throws(() => D([], { result: "x" })));

test("changedVersions: compares with the last pass", () => {
  const runs = [{ result: "pass", versions: { t3: "1", pi: "2", dagu: "3" } }, { result: "fail", versions: { t3: "9", pi: "2", dagu: "3" } }];
  assert.deepEqual(changedVersions(runs, { t3: "9", pi: "2", dagu: "4" }), [{ name: "t3", from: "1", to: "9" }, { name: "dagu", from: "3", to: "4" }]);
  assert.deepEqual(changedVersions([], { t3: "1" }), []);
});
test("failingChecks: FAIL lines, else the tail", () => {
  assert.deepEqual(failingChecks("ok a\nFAIL st3: boom\nok b"), ["FAIL st3: boom"]);
  assert.deepEqual(failingChecks("a\nb"), ["a", "b"]);
});

test("breaker: selftest-red opens on two consecutive failed runs, ignores skipped and runs before a reset", () => {
  const runs = (...r) => ({ selftest: { runs: r.map((result, i) => ({ date: `2026-01-0${i + 1}T04:00:00Z`, result })) } });
  const now = Date.parse("2026-02-01T00:00:00Z");
  assert.equal(evaluate(runs("fail"), null, now).open, false);
  assert.equal(evaluate(runs("fail", "pass", "fail"), null, now).open, false);
  const e = evaluate(runs("pass", "fail", "skipped", "fail"), null, now);
  assert.equal(e.open, true); assert.equal(e.reasons[0].kind, "selftest-red");
  assert.equal(evaluate(runs("fail", "fail"), { resetAt: "2026-01-02T12:00:00Z" }, now).open, false);
});

// ---- I/O: real git fixture, injected command and notifier ----
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sched-st-"));
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  g(root, "clone", "-q", join(root, "origin.git"), "primary");
  const primary = join(root, "primary");
  g(primary, "config", "user.email", "t@t"); g(primary, "config", "user.name", "t");
  writeFileSync(join(primary, "marker.txt"), "x\n");
  g(primary, "add", "-A"); g(primary, "commit", "-qm", "i"); g(primary, "push", "-q", "origin", "HEAD:main");
  const state = join(root, "state"); mkdirSync(state);
  const stub = join(root, "t3.mjs");
  writeFileSync(stub, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(root, "t3.log"))}, JSON.stringify(readFileSync(0, "utf8")) + "\\n");\n`);
  const env = { ...process.env, NOTIFY_T3CLI: stub };
  const sent = () => (existsSync(join(root, "t3.log")) ? readFileSync(join(root, "t3.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const go = (cmd, extra = {}) => run({ state, primary, t3Home: join(root, "t3"), inbox: "inbox-1", factory: new URL("../src", import.meta.url).pathname, cmd, install: false, busy: false,
    versions: { t3: "1", pi: "2", dagu: "3" }, now: new Date(), ...extra }, env);
  return { root, primary, state, sent, go, g };
}

test("run: pass records history (version 1) on a fresh worktree of origin/main, removes it, sends nothing", async () => {
  const f = fixture();
  const e = await f.go("test -f marker.txt && pwd > ../pwd.txt");
  assert.equal(e.result, "pass");
  const h = JSON.parse(readFileSync(historyFile(f.state), "utf8"));
  assert.equal(h.version, 1);
  assert.deepEqual(Object.keys(h.runs[0]).sort(), ["date", "durationMs", "result", "sha", "versions"]);
  assert.equal(h.runs[0].sha, f.g(f.primary, "rev-parse", "origin/main").trim());
  assert.equal(f.sent().length, 0);
  assert.equal(f.g(f.primary, "worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
});

test("run: red notifies once with failing checks and changed versions; second red opens the breaker; recovery notifies once", async () => {
  const f = fixture();
  await f.go("true");
  const e1 = await f.go('echo "FAIL st9: boom" >&2; exit 1', { versions: { t3: "2", pi: "2", dagu: "3" } });
  assert.equal(e1.result, "fail");
  assert.equal(f.sent().length, 1);
  assert.match(f.sent()[0], /FAIL st9: boom/);
  assert.match(f.sent()[0], /t3 1 -> 2/);
  assert.equal(existsSync(join(f.state, "breaker.json")), false);
  await f.go("exit 1");
  const b = JSON.parse(readFileSync(join(f.state, "breaker.json"), "utf8"));
  assert.equal(b.open, true);
  assert.ok(b.reasons.some((r) => r.kind === "selftest-red"));
  const before = f.sent().length;
  await f.go("true");
  assert.equal(f.sent().length, before + 1);
  assert.match(f.sent().at(-1), /vuelve a pasar/);
  await f.go("true");
  assert.equal(f.sent().length, before + 1); // consecutive passes send nothing
});

test("run: busy cycle skips, records skipped, runs nothing", async () => {
  const f = fixture();
  const e = await f.go("touch ran", { busy: true });
  assert.equal(e.result, "skipped");
  assert.equal(readHistory(f.state).runs.at(-1).result, "skipped");
  assert.equal(f.sent().length, 0);
});

test("history: unreadable file starts over; capped", () => {
  const d = mkdtempSync(join(tmpdir(), "sched-h-"));
  mkdirSync(join(d, "selftest")); writeFileSync(historyFile(d), "garbage");
  assert.deepEqual(readHistory(d), { version: 1, runs: [] });
  for (let i = 0; i < 5; i++) appendHistory(d, { n: i }, 3);
  assert.deepEqual(readHistory(d).runs.map((r) => r.n), [2, 3, 4]);
  assert.match(formatNotice({ event: "notify", entry: { sha: "a".repeat(40), date: "d", versions: { t3: "1" } }, changed: [], checks: [] }), /FALLA/);
});

test("run: when Dagu occupancy cannot be read it fails closed: records skipped with the error, no fetch, no worktree, no selftest", async () => {
  const f = fixture();
  // origin is gone: any git fetch would throw and record a fail instead of skipped
  const marker = join(f.root, "ran");
  const e = await f.go(`touch ${marker}`, { busy: undefined, inFlight: async () => { throw new Error("fetch failed"); } });
  assert.equal(e.result, "skipped");
  assert.match(e.error, /cannot read Dagu runs: fetch failed/);
  assert.equal(e.sha, null);
  assert.equal(existsSync(marker), false);
  assert.equal(readHistory(f.state).runs.at(-1).result, "skipped");
  assert.equal(f.g(f.primary, "worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  assert.equal(f.sent().length, 0);
  // also real path: unreachable Dagu URL
  const e2 = await run({ state: f.state, primary: f.primary, t3Home: "x", cmd: `touch ${marker}`, install: false, versions: {} }, { ...process.env, A4S_DAGU_URL: "http://127.0.0.1:1" });
  assert.equal(e2.result, "skipped"); assert.equal(existsSync(marker), false);
});

// Regression (factory-issue-1075-1, rebase conflict on package.json): the typecheck script must keep both the
// scheduled-selftest module and the stub selftest files that main added concurrently.
test("package.json typecheck covers scheduled-selftest and the stub selftest files", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const f of ["src/scheduled-selftest.mjs", "src/breaker.mjs", "selftest/selftest.mjs", "selftest/selftest-stub.mjs", "selftest/stub/t3.mjs", "selftest/stub/gh.mjs"]) {
    assert.ok(pkg.scripts.typecheck.includes(`node --check ${f}`), `typecheck misses ${f}`);
  }
  assert.equal(pkg.scripts["selftest:stub"], "node selftest/selftest-stub.mjs");
});
