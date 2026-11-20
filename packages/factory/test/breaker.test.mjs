import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, readState, reset, check } from "../src/breaker.mjs";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const up = { reachable: true };
const closed = { version: 1, open: false, reasons: [] };

test("one service down 31 min opens", () => {
  const r = evaluate({ services: { dagu: up, t3: { reachable: false, lastReachableAt: ago(31) } } }, closed, NOW);
  assert.equal(r.open, true);
  assert.equal(r.reasons[0].kind, "unreachable");
  assert.match(r.reasons[0].detail, /t3/);
  assert.equal(r.reasons[0].since, ago(31));
});
test("down 29 min stays closed", () => {
  assert.equal(evaluate({ services: { dagu: up, t3: { reachable: false, lastReachableAt: ago(29) } } }, closed, NOW).open, false);
});
test("missing service counts as unreachable; only dagu present and reachable stays open", () => {
  const open = evaluate({ services: { dagu: up, t3: { reachable: false, lastReachableAt: ago(40) } } }, closed, NOW);
  const state = { ...closed, open: true, reasons: open.reasons };
  const r = evaluate({ services: { dagu: up } }, state, NOW);
  assert.equal(r.open, true);
  assert.equal(r.reasons[0].kind, "unreachable");
});
test("both reachable clears", () => {
  const state = { ...closed, open: true, reasons: [{ kind: "unreachable", detail: "t3", since: ago(40) }] };
  assert.deepEqual(evaluate({ services: { dagu: up, t3: up } }, state, NOW), { open: false, reasons: [] });
});
test("down briefly while open keeps it open (latch)", () => {
  const state = { ...closed, open: true, reasons: [{ kind: "unreachable", detail: "t3", since: ago(40) }] };
  assert.equal(evaluate({ services: { dagu: up, t3: { reachable: false, lastReachableAt: ago(1) } } }, state, NOW).open, true);
});
test("other kinds never clear by themselves", () => {
  const state = { ...closed, open: true, reasons: [{ kind: "future", detail: "x", since: ago(5) }] };
  assert.equal(evaluate({ services: { dagu: up, t3: up } }, state, NOW).open, true);
});
test("invalid state fails closed with state-invalid", () => {
  const r = evaluate({ services: { dagu: up, t3: up } }, { invalid: true }, NOW);
  assert.equal(r.open, true);
  assert.equal(r.reasons[0].kind, "state-invalid");
});

const tmp = () => mkdtempSync(join(tmpdir(), "breaker-"));
test("readState: missing closed; corrupt and unknown version invalid", () => {
  const d = tmp();
  assert.equal(readState(d).open, false);
  writeFileSync(join(d, "breaker.json"), "{nope");
  assert.equal(readState(d).invalid, true);
  writeFileSync(join(d, "breaker.json"), JSON.stringify({ version: 2, open: false, reasons: [] }));
  assert.equal(readState(d).invalid, true);
});
test("check on a corrupt file opens (state-invalid) and reset closes with who/when", async () => {
  const d = tmp();
  writeFileSync(join(d, "breaker.json"), "garbage");
  const snap = join(d, "snap.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: up, t3: up } }));
  const env = { ...process.env, A4S_STATE: d };
  const b = await check({ state: d, snapshot: snap, factory: d }, env); // notify fails harmlessly
  assert.equal(b.open, true);
  assert.equal(b.reasons[0].kind, "state-invalid");
  assert.equal((await check({ state: d, snapshot: snap, factory: d }, env)).open, true);
  reset(d, "ana", "2026-01-01T00:00:00.000Z");
  const s = JSON.parse(readFileSync(join(d, "breaker.json"), "utf8"));
  assert.deepEqual([s.version, s.open, s.resetBy, s.resetAt], [1, false, "ana", "2026-01-01T00:00:00.000Z"]);
  assert.equal((await check({ state: d, snapshot: snap, factory: d }, env)).open, false);
});
test("CLI check exits 40 when open, reset exits 0", () => {
  const d = tmp();
  writeFileSync(join(d, "breaker.json"), "x");
  const snap = join(d, "snap.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: up, t3: up } }));
  const cli = (...a) => spawnSync("node", [new URL("../src/breaker.mjs", import.meta.url).pathname, ...a, "--state", d], { encoding: "utf8" });
  assert.equal(cli("check", "--snapshot", snap, "--factory", d).status, 40);
  assert.equal(cli("reset", "--by", "t").status, 0);
  assert.equal(cli("check", "--snapshot", snap).status, 0);
});

test("malformed states are invalid (open without reasons, bad reasons, inconsistent closed)", () => {
  const d = tmp();
  const bad = [
    { version: 1, open: true, reasons: [], since: "bad" },
    { version: 1, open: true, reasons: [], since: "2026-01-01T00:00:00Z" },
    { version: 1, open: true, reasons: [{ kind: "x" }], since: "2026-01-01T00:00:00Z" },
    { version: 1, open: true, reasons: [{ kind: "x", detail: "d", since: "nope" }], since: "2026-01-01T00:00:00Z" },
    { version: 1, open: false, reasons: [{ kind: "x", detail: "d", since: "2026-01-01T00:00:00Z" }], since: null },
    { version: 1, open: "yes", reasons: [] },
  ];
  for (const b of bad) {
    writeFileSync(join(d, "breaker.json"), JSON.stringify(b));
    assert.equal(readState(d).invalid, true, JSON.stringify(b));
  }
  writeFileSync(join(d, "breaker.json"), JSON.stringify({ version: 1, open: true, reasons: [{ kind: "x", detail: "d", since: "2026-01-01T00:00:00Z" }], since: "2026-01-01T00:00:00Z", resetBy: null, resetAt: null }));
  assert.equal(readState(d).invalid, undefined);
});
test("check on {open:true,reasons:[]} persists open state-invalid", async () => {
  const d = tmp();
  writeFileSync(join(d, "breaker.json"), JSON.stringify({ version: 1, open: true, reasons: [], since: "bad" }));
  const snap = join(d, "snap.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: up, t3: up } }));
  const b = await check({ state: d, snapshot: snap, factory: d }, { ...process.env });
  assert.equal(b.open, true);
  const stored = JSON.parse(readFileSync(join(d, "breaker.json"), "utf8"));
  assert.equal(stored.open, true);
  assert.equal(stored.reasons[0].kind, "state-invalid");
  assert.equal(readState(d).invalid, undefined);
});
test("a continuously missing service opens after 30 min across checks", async () => {
  const d = tmp();
  const snap = join(d, "snap.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: up } }));
  const env = { ...process.env };
  assert.equal((await check({ state: d, snapshot: snap, factory: d, now: NOW }, env)).open, false);
  assert.equal((await check({ state: d, snapshot: snap, factory: d, now: NOW + 29 * 60_000 }, env)).open, false);
  const b = await check({ state: d, snapshot: snap, factory: d, now: NOW + 31 * 60_000 }, env);
  assert.equal(b.open, true);
  assert.match(b.reasons[0].detail, /t3/);
  // both reachable again clears
  writeFileSync(snap, JSON.stringify({ services: { dagu: up, t3: up } }));
  assert.equal((await check({ state: d, snapshot: snap, factory: d, now: NOW + 32 * 60_000 }, env)).open, false);
});

test("default live probe targets the default Dagu endpoint and fails closed", async () => {
  const { probeServices, daguUrl } = await import("../src/breaker.mjs");
  assert.equal(daguUrl({}), "http://127.0.0.1:8080");
  assert.equal(daguUrl({ DAGU_PORT: "9999" }), "http://127.0.0.1:9999");
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); throw new Error("down"); };
  try {
    const s = await probeServices({ t3Home: "", env: {} });
    assert.equal(s.dagu.reachable, false);
    assert.ok(seen[0].startsWith("http://127.0.0.1:8080"));
  } finally { globalThis.fetch = orig; }
});

test("corrupt state is rebuilt with every persisted field", async () => {
  const d = mkdtempSync(join(tmpdir(), "brk-"));
  writeFileSync(join(d, "breaker.json"), "{nope");
  const snap = join(d, "s.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: { reachable: true }, t3: { reachable: true } } }));
  const b = await check({ state: d, snapshot: snap, inbox: "", primary: "" }, { ...process.env });
  const f = JSON.parse(readFileSync(join(d, "breaker.json"), "utf8"));
  for (const k of ["version", "open", "reasons", "since", "resetBy", "resetAt"]) assert.ok(k in f, k);
  assert.equal(f.resetBy, null); assert.equal(f.resetAt, null);
  assert.equal(f.open, true);
  assert.equal(f.reasons[0].kind, "state-invalid");
});

test("live probe uses the Dagu endpoint of a nondefault config", async () => {
  const { probeServices } = await import("../src/breaker.mjs");
  const d = mkdtempSync(join(tmpdir(), "brkc-"));
  const cfg = join(d, "cfg.yaml");
  writeFileSync(cfg, "host: 127.0.0.1\nport: 19876\n");
  const home = mkdtempSync(join(tmpdir(), "brkh-"));
  writeFileSync(join(home, "config.yaml"), "port: 19877\n");
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); throw new Error("down"); };
  try {
    const a = await probeServices({ t3Home: "", env: {}, daguConfig: cfg });
    const b = await probeServices({ t3Home: "", env: {}, daguHome: home });
    assert.ok(seen[0].startsWith("http://127.0.0.1:19876/"), seen[0]);
    assert.ok(seen[1].startsWith("http://127.0.0.1:19877/"), seen[1]);
    assert.equal(a.dagu.reachable, false);
    assert.equal(b.dagu.reachable, false);
  } finally { globalThis.fetch = orig; }
});

test("state missing resetBy/resetAt is invalid and rebuilt complete", async () => {
  const { stateError } = await import("../src/breaker.mjs");
  assert.ok(stateError({ version: 1, open: false, reasons: [], since: null }));
  const d = mkdtempSync(join(tmpdir(), "brk-"));
  writeFileSync(join(d, "breaker.json"), JSON.stringify({ version: 1, open: false, reasons: [], since: null }));
  assert.equal(readState(d).invalid, true);
  const snap = join(d, "s.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: { reachable: true }, t3: { reachable: true } } }));
  await check({ state: d, snapshot: snap, inbox: "", primary: "" }, { ...process.env });
  const f = JSON.parse(readFileSync(join(d, "breaker.json"), "utf8"));
  assert.equal(f.open, true);
  assert.equal(f.reasons[0].kind, "state-invalid");
  assert.ok("resetBy" in f && "resetAt" in f);
});

// ---- ci condition ----
import { collectCi, trackCi, CI_TIMEOUT_MIN } from "../src/breaker.mjs";
const SHA = "a".repeat(40), OLD = "b".repeat(40);
const src = ({ fetchFails, ghFails, runs = [], commitTime = ago(5) } = {}) => ({
  git: (a) => {
    if (a[0] === "fetch") { if (fetchFails) throw new Error("network"); return ""; }
    if (a[0] === "rev-parse") { assert.ok(a.includes("FETCH_HEAD^{commit}")); return SHA + "\n"; }
    return commitTime + "\n";
  },
  gh: (a) => { if (ghFails) throw new Error("gh down"); assert.ok(a.includes(SHA)); return JSON.stringify(runs); },
});
const run = (headSha, status, conclusion) => ({ headSha, status, conclusion });
const ciEval = (ci, state = closed) => evaluate({ services: { dagu: up, t3: up }, ci }, state, NOW);

test("ci: failing CI on current SHA opens", () => {
  const ci = collectCi({ ...src({ runs: [run(SHA, "completed", "failure")] }) });
  assert.equal(ci.status, "failure");
  const r = ciEval(ci);
  assert.equal(r.open, true);
  assert.equal(r.reasons[0].kind, "ci");
});
test("ci: failing commit reverted by a later green commit closes", () => {
  const ci = collectCi({ ...src({ runs: [run(SHA, "completed", "success"), run(OLD, "completed", "failure")] }) });
  assert.equal(ci.status, "success");
  assert.equal(ciEval(ci).open, false);
});
test("ci: none for current SHA past the timeout opens; older green does not mask it", () => {
  const ci = collectCi({ ...src({ commitTime: ago(31), runs: [run(OLD, "completed", "success")] }) });
  assert.equal(ci.status, "none");
  assert.equal(ciEval(ci).open, true);
  assert.equal(ciEval(collectCi({ ...src({ commitTime: ago(29), runs: [run(OLD, "completed", "success")] }) })).open, false);
});
test("ci: CI_TIMEOUT_MIN is configurable, default 30", () => {
  assert.equal(CI_TIMEOUT_MIN, 30);
  const ci = collectCi({ ...src({ commitTime: ago(11) }), env: { CI_TIMEOUT_MIN: "10" } });
  assert.equal(ci.timeoutMin, 10);
  assert.equal(ciEval(ci).open, true);
});
test("ci: failed fetch / gh lookup is a lookup failure, never a pass; counts toward the timeout", () => {
  for (const o of [{ fetchFails: true }, { ghFails: true }]) {
    const ci = collectCi({ ...src(o) });
    assert.equal(ci.lookupFailed, true);
    assert.equal(ciEval({ ...ci, failingSince: ago(29) }).open, false);
    const r = ciEval({ ...ci, failingSince: ago(31) });
    assert.equal(r.open, true);
    assert.equal(r.reasons[0].since, ago(31));
  }
});
test("ci: stale origin/main after failed fetch is not proof of health (green stale data is not returned)", () => {
  const ci = collectCi({ git: src({ fetchFails: true }).git, gh: () => JSON.stringify([run(SHA, "completed", "success")]) });
  assert.equal(ci.lookupFailed, true);
  assert.equal(ci.status, undefined);
});
test("ci: malformed gh output is a lookup failure", () => {
  assert.equal(collectCi({ git: src().git, gh: () => "not json" }).lookupFailed, true);
});
test("ci: in progress under the timeout closes", () => {
  const ci = collectCi({ ...src({ runs: [run(SHA, "in_progress", null)] }) });
  assert.equal(ci.status, "pending");
  assert.equal(ciEval(ci).open, false);
});
test("ci: pending past the timeout opens", () => {
  assert.equal(ciEval(collectCi({ ...src({ commitTime: ago(40), runs: [run(SHA, "queued", null)] }) })).open, true);
});
test("ci: trackCi keeps failingSince across failures and clears on success", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-"));
  const a = trackCi(dir, { lookupFailed: true }, NOW - 40 * 60_000);
  const b = trackCi(dir, { lookupFailed: true }, NOW);
  assert.equal(b.failingSince, a.failingSince);
  assert.equal(ciEval(b).open, true);
  trackCi(dir, { sha: SHA, status: "success" }, NOW);
  assert.equal(trackCi(dir, { lookupFailed: true }, NOW).failingSince, new Date(NOW).toISOString());
});
test("ci: open reason never clears by itself, only reset", () => {
  const open = ciEval({ sha: SHA, commitTime: ago(5), status: "failure", timeoutMin: 30 });
  const state = { ...closed, open: true, reasons: open.reasons };
  assert.equal(ciEval({ sha: SHA, commitTime: ago(5), status: "success", timeoutMin: 30 }, state).open, true);
});
test("ci: check with a snapshot whose current main has failing CI opens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cib-"));
  const snap = join(dir, "s.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: up, t3: up }, ci: { sha: SHA, commitTime: ago(5), status: "failure", timeoutMin: 30 } }));
  const b = await check({ state: dir, snapshot: snap, factory: dir });
  assert.equal(b.open, true);
  assert.equal(b.reasons[0].kind, "ci");
});

test("ci: real git with a narrow remote.origin.fetch mapping still resolves the fetched main", () => {
  const dir = mkdtempSync(join(tmpdir(), "cig-"));
  const g = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const origin = join(dir, "origin"), clone = join(dir, "clone");
  g(dir, "init", "-q", "-b", "main", origin);
  for (const c of ["user.email=a@b", "user.name=t"]) g(origin, "config", ...c.split("="));
  g(origin, "commit", "-q", "--allow-empty", "-m", "one");
  g(dir, "clone", "-q", origin, clone);
  g(clone, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
  const stale = g(clone, "rev-parse", "origin/main");
  g(origin, "commit", "-q", "--allow-empty", "-m", "two");
  const fresh = g(origin, "rev-parse", "HEAD");
  const seen = [];
  const ci = collectCi({ git: (a) => g(clone, ...a), gh: (a) => { seen.push(a); return JSON.stringify([run(stale, "completed", "success")]); } });
  assert.ok(seen[0].includes(fresh));
  assert.equal(ci.sha, fresh);
  assert.equal(ci.status, "none");
});

// ---- limits: run limits (attempts, step timeouts) ----
import { collectLimits, cycleTimeouts, toTime } from "../src/breaker.mjs";
import { mkdirSync } from "node:fs";

const LIM_NOW = Date.parse("2026-01-01T12:00:00Z");
const limFixture = ({ cycle = "steps:\n  - id: implement\n    run: |\n      exec node \"$F/src/station.mjs\" --line impl --timeout-sec 600\n  - id: qa\n    run: |\n      node \"$F/src/station.mjs\" --line qa --timeout-sec 300\n", files = {} } = {}) => {
  const state = mkdtempSync(join(tmpdir(), "lim-"));
  const cycleFile = join(state, "cycle.yaml");
  writeFileSync(cycleFile, cycle);
  for (const [rel, v] of Object.entries(files)) {
    mkdirSync(join(state, rel, ".."), { recursive: true });
    writeFileSync(join(state, rel), typeof v === "string" ? v : JSON.stringify(v));
  }
  return { state, cycleFile };
};
const limEval = (fx, st = closed) => evaluate({ limits: collectLimits({ state: fx.state, cycleFile: fx.cycleFile, now: LIM_NOW }) }, st, LIM_NOW);
const at = (sec) => LIM_NOW - sec * 1000;
const okAttempts = { last: 1, streak: 1, parked: false, lastAt: ago(5) };

test("cycleTimeouts reads the configured per-step timeouts", () => {
  assert.deepEqual(cycleTimeouts("steps:\n  - id: a\n    run: node station.mjs --line impl --timeout-sec 600\n  - id: b\n    timeoutSec: 90\n    run: node station.mjs --line qa\n  - id: c\n    run: echo\n"), { impl: [600], qa: [90] });
});
test("limits 1: attempt still running past its configured timeout opens", () => {
  const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: at(601) }] } } });
  const r = limEval(fx);
  assert.equal(r.open, true);
  assert.equal(r.reasons[0].kind, "limits");
  assert.match(r.reasons[0].detail, /#5 step impl.*running past its safety cap of 600s/);
});
test("limits 1b: the timeout comes from the cycle, not a fixed value", () => {
  const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/qa.json": { attempts: [{ startedAt: at(301) }] } } });
  assert.equal(limEval(fx).open, true); // qa limit is 300 in this cycle
  const fx2 = limFixture({ cycle: "steps:\n  - id: qa\n    run: node station.mjs --line qa --timeout-sec 4000\n", files: { "5/attempts.json": okAttempts, "5/qa.json": { attempts: [{ startedAt: at(2000) }] } } });
  assert.equal(limEval(fx2).open, false);
});
test("limits 1c: the attempt's own recorded timeoutSec wins", () => {
  const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: at(100), timeoutSec: 60 }] } } });
  assert.equal(limEval(fx).open, true);
});
test("limits 2: a persisted timeout outcome opens until reset", () => {
  const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: at(3000), outcome: "timeout" }] } } });
  const r = limEval(fx);
  assert.equal(r.open, true);
  assert.match(r.reasons[0].detail, /#5 step impl.*outcome timeout/);
  const afterReset = { ...closed, resetAt: new Date(LIM_NOW - 60_000).toISOString() };
  assert.equal(limEval(fx, afterReset).open, false);
  assert.equal(limEval(fx, { ...closed, resetAt: new Date(LIM_NOW - 4000_000).toISOString() }).open, true);
});
const stepFx = (attempts) => limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts } } });
test("limits: stuck then pass in the same step stays closed", () => {
  assert.equal(limEval(stepFx([{ startedAt: at(3000), timeoutSec: 14400, outcome: "stuck" }, { startedAt: at(2000), timeoutSec: 14400, outcome: "pass" }])).open, false);
  assert.equal(limEval(stepFx([{ startedAt: at(3000), timeoutSec: 14400, outcome: "timeout" }, { startedAt: at(2000), timeoutSec: 14400, outcome: "pass" }])).open, false);
});
test("limits: stuck then fail opens", () => {
  const r = limEval(stepFx([{ startedAt: at(3000), timeoutSec: 14400, outcome: "stuck" }, { startedAt: at(2000), timeoutSec: 14400, outcome: "fail" }]));
  assert.equal(r.open, true);
  assert.match(r.reasons[0].detail, /#5 step impl.*outcome stuck/);
});
test("limits: in-flight past-cap reason clears after timeout then pass", () => {
  const running = limEval(stepFx([{ startedAt: at(5000), timeoutSec: 600 }]));
  assert.equal(running.open, true);
  assert.equal(running.reasons[0].step, "impl");
  const persisted = { open: true, since: new Date(LIM_NOW).toISOString(), reasons: running.reasons };
  const still = limEval(stepFx([{ startedAt: at(5000), timeoutSec: 600, outcome: "timeout" }]), persisted);
  assert.equal(still.open, true);
  const after = limEval(stepFx([{ startedAt: at(5000), timeoutSec: 600, outcome: "timeout" }, { startedAt: at(2000), timeoutSec: 600, outcome: "pass" }]), { open: true, since: persisted.since, reasons: running.reasons });
  assert.equal(after.open, false);
});

test("limits: a persisted stuck reason clears when a later attempt passes; unrelated reasons stay", () => {
  const first = limEval(stepFx([{ startedAt: at(3000), timeoutSec: 14400, outcome: "stuck" }]));
  assert.equal(first.open, true);
  const persisted = { open: true, since: first.reasons[0].since, reasons: [...first.reasons, { kind: "fixture", detail: "unrelated", since: first.reasons[0].since }] };
  const after = limEval(stepFx([{ startedAt: at(3000), timeoutSec: 14400, outcome: "stuck" }, { startedAt: at(2000), timeoutSec: 14400, outcome: "pass" }]), persisted);
  assert.deepEqual(after.reasons.map((r) => r.kind), ["fixture"]);
  assert.equal(limEval(stepFx([{ startedAt: at(3000), timeoutSec: 14400, outcome: "stuck" }, { startedAt: at(2000), timeoutSec: 14400, outcome: "pass" }]), { open: true, since: persisted.since, reasons: first.reasons }).open, false);
});
test("limits: a long active attempt (no outcome, under the safety cap) stays closed", () => {
  assert.equal(limEval(stepFx([{ startedAt: at(7200), timeoutSec: 14400 }])).open, false);
});
test("limits: an attempt past the safety cap still running opens", () => {
  assert.equal(limEval(stepFx([{ startedAt: at(15000), timeoutSec: 14400 }])).open, true);
});

test("limits 3: running under its timeout stays closed", () => {
  const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: at(599) }] } } });
  assert.equal(limEval(fx).open, false);
});
test("limits 4: more than 3 runs of one issue opens; 3 does not", () => {
  const fx = limFixture({ files: { "5/attempts.json": { ...okAttempts, last: 4, streak: 4 } } });
  const r = limEval(fx);
  assert.equal(r.open, true);
  assert.match(r.reasons[0].detail, /#5: 4 runs/);
  assert.equal(limEval(limFixture({ files: { "5/attempts.json": { ...okAttempts, streak: 3 } } })).open, false);
});
test("limits 5: attempts archived by admission are not double-counted", () => {
  const fx = limFixture({ files: {
    "5/attempts.json": okAttempts,
    "5/impl.json.1767268800000": { attempts: [{ startedAt: at(9000), outcome: "timeout" }, { startedAt: at(8000) }] },
    "5/impl.json": { attempts: [{ startedAt: at(100), outcome: "pass" }] },
  } });
  const l = collectLimits({ state: fx.state, cycleFile: fx.cycleFile, now: LIM_NOW });
  assert.equal(l.steps.length, 1);
  assert.equal(limEval(fx).open, false);
});
test("limits 6: a corrupt or missing attempt file is a reason", () => {
  const corrupt = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": "{not json" } });
  const r = limEval(corrupt);
  assert.equal(r.open, true);
  assert.match(r.reasons[0].detail, /#5 step impl.*corrupt/);
  const invalid = limFixture({ files: { "5/attempts.json": okAttempts, "5/qa.json": { attempts: [{ startedAt: at(1), outcome: "bogus" }] } } });
  assert.match(limEval(invalid).reasons[0].detail, /step qa.*corrupt/);
  const missing = limFixture({ files: { "5/impl.json": { attempts: [{ startedAt: at(10), outcome: "pass" }] } } });
  assert.match(limEval(missing).reasons[0].detail, /#5 step attempts.*missing/);
  const badAttempts = limFixture({ files: { "5/attempts.json": "nope" } });
  assert.match(limEval(badAttempts).reasons[0].detail, /step attempts.*corrupt/);
});
test("limits: an invalid lastAt/resetAt in attempts.json is a corruption reason, not a throw", () => {
  for (const bad of [{ streak: 4, lastAt: "corrupt-date" }, { streak: 1, resetAt: "nope" }, { streak: 4, lastAt: true }, { streak: 4, resetAt: false }, { streak: 4, lastAt: null }, { streak: 4, lastAt: {} }]) {
    const fx = limFixture({ files: { "5/attempts.json": bad } });
    const r = limEval(fx);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0].detail, /step attempts.*corrupt.*not a valid timestamp/);
  }
});
test("limits: no state yet is closed; an unreadable cycle file is a reason", () => {
  const fx = limFixture();
  assert.equal(limEval(fx).open, false);
  const l = collectLimits({ state: fx.state, cycleFile: join(fx.state, "nope.yaml"), now: LIM_NOW });
  assert.equal(evaluate({ limits: l }, closed, LIM_NOW).open, true);
});
test("limits reasons are stable across checks (no duplicates) and only reset closes them", () => {
  const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: at(700) }] } } });
  const first = limEval(fx);
  const state = { ...closed, open: true, reasons: first.reasons };
  const second = evaluate({ limits: collectLimits({ state: fx.state, cycleFile: fx.cycleFile, now: LIM_NOW + 60_000 }) }, state, LIM_NOW + 60_000);
  assert.equal(second.reasons.length, 1);
  assert.equal(evaluate({ limits: { steps: [], runs: [], problems: [] } }, state, LIM_NOW).open, true);
});
test("check wires limits: live state with a timeout attempt opens, reset closes", async () => {
  const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: at(3000), outcome: "timeout" }] } } });
  const snap = join(fx.state, "snap.json");
  writeFileSync(snap, JSON.stringify({ services: { dagu: up, t3: up } }));
  const cli = (...a) => spawnSync("node", [join(import.meta.dirname, "..", "src", "breaker.mjs"), ...a, "--state", fx.state], { encoding: "utf8" });
  const r = cli("check", "--snapshot", snap, "--cycle", fx.cycleFile, "--factory", join(import.meta.dirname, "..", "src"));
  assert.equal(r.status, 40);
  assert.match(r.stdout, /limits: issue #5 step impl/);
  cli("reset", "--by", "t");
  assert.equal(readState(fx.state).open, false);
});
test("limits: missing startedAt is a corruption reason for every outcome", () => {
  for (const outcome of ["pass", "fail", "blocked", "timeout", undefined]) {
    const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [outcome ? { outcome } : {}] } } });
    const r = limEval(fx);
    assert.equal(r.open, true, String(outcome));
    assert.match(r.reasons[0].detail, /impl\.json.*invalid field startedAt/, String(outcome));
  }
});
test("limits: steps of one line with different timeouts are not collapsed to the largest", () => {
  const cycle = "steps:\n  - id: implement\n    run: node station.mjs --line impl --timeout-sec 60\n  - id: repair\n    run: node station.mjs --line impl --timeout-sec 1800\n";
  assert.deepEqual(cycleTimeouts(cycle), { impl: [60, 1800] });
  const mk = (age, extra = {}) => limFixture({ cycle, files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: at(age), ...extra }] } } });
  const r = limEval(mk(120));
  assert.equal(r.open, true); // 120s is past 60s, and which step it is cannot be told
  assert.match(r.reasons[0].detail, /several timeouts.*60\/1800s/);
  assert.equal(limEval(mk(30)).open, false);
  assert.equal(limEval(mk(1900)).open, true);
  assert.equal(limEval(mk(120, { timeoutSec: 1800 })).open, false); // recorded timeout is applicable
  assert.equal(limEval(mk(120, { timeoutSec: 60 })).open, true);
});

// ---- toTime: one total helper for every timestamp read from state ----
const TIME_TABLE = [
  ["valid ISO", "2026-01-01T12:00:00Z", Date.parse("2026-01-01T12:00:00Z")],
  ["valid number", 1767268800000, 1767268800000],
  ["true", true, null], ["false", false, null], ["corrupt-date", "corrupt-date", null],
  ["1e20", 1e20, null], ["-1e20", -1e20, null], ["NaN", NaN, null], ["null", null, null], ["{}", {}, null],
  ["undefined", undefined, null], ["Infinity", Infinity, null], ["empty string", "", null], ["array", [1], null],
  ["bare numeric string", "1e20", null],
];
test("toTime: table-driven, total", () => {
  for (const [name, v, want] of TIME_TABLE) assert.equal(toTime(v), want, name);
  assert.equal(toTime(8.64e15), 8.64e15);
  assert.equal(toTime(8.64e15 + 1), null);
});
test("toTime fields in files: each invalid shape is a limits reason naming file and field, never a throw", () => {
  for (const [name, v, want] of TIME_TABLE) {
    const bad = want === null;
    for (const field of ["lastAt", "resetAt"]) {
      if (v === undefined) continue;
      const fx = limFixture({ files: { "5/attempts.json": { streak: 4, [field]: v } } });
      const r = limEval(fx);
      if (bad) { assert.equal(r.reasons.some((x) => x.kind === "limits" && x.detail.includes("attempts.json") && x.detail.includes(field)), true, `${field} ${name}`); }
      else assert.equal(r.reasons.some((x) => /corrupt/.test(x.detail)), false, `${field} ${name}`);
    }
    const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/impl.json": { attempts: [{ startedAt: v }] } } });
    const r = limEval(fx);
    if (bad) assert.equal(r.reasons.some((x) => x.kind === "limits" && x.detail.includes("impl.json") && x.detail.includes("startedAt")), true, `startedAt ${name}`);
  }
});
test("toTime fields in a snapshot: evaluate never throws on any shape", () => {
  for (const [name, v] of TIME_TABLE) {
    const snap = {
      services: { dagu: { reachable: false, lastReachableAt: v }, t3: { reachable: true } },
      ci: { sha: "abc", commitTime: v, status: "pending", failingSince: v },
      limits: { runs: [{ issue: 1, runs: 9, at: v }], steps: [{ issue: 1, step: "impl", startedAt: v, timeoutSec: 5 }, { issue: 1, step: "qa", startedAt: v, timeoutSec: 5, outcome: "timeout" }], problems: [{ issue: 1, step: "x", error: "e", at: v }] },
    };
    for (const st of [closed, { ...closed, resetAt: v }, { open: true, reasons: [], resetAt: v }]) assert.doesNotThrow(() => evaluate(snap, st, LIM_NOW), name);
    assert.doesNotThrow(() => evaluate(snap, closed, v), `now ${name}`);
  }
});

test("completed attempts: every invalid startedAt shape is a reason naming file and field, whatever the outcome", () => {
  for (const [name, v, want] of TIME_TABLE) {
    if (want !== null || v === undefined) continue;
    for (const outcome of ["pass", "fail", "timeout"]) {
      const fx = limFixture({ files: { "5/attempts.json": okAttempts, "5/qa.json": { attempts: [{ startedAt: v, outcome }] } } });
      const r = limEval(fx);
      assert.equal(r.reasons.some((x) => x.kind === "limits" && x.detail.includes("qa.json") && x.detail.includes("startedAt")), true, `${outcome} ${name}`);
    }
  }
});
test("tracking files: invalid lastReachableAt / failingSince are limits reasons naming file and field (via check)", async () => {
  for (const [name, v, want] of TIME_TABLE) {
    if (want !== null || v === undefined) continue;
    for (const [file, content, field] of [
      ["reachability.json", { dagu: { lastReachableAt: v }, t3: { lastReachableAt: v } }, "dagu.lastReachableAt"],
      ["ci-tracking.json", { failingSince: v }, "failingSince"],
    ]) {
      const fx = limFixture({ files: { "5/attempts.json": okAttempts, [file]: content } });
      const snap = join(fx.state, "snap.json");
      writeFileSync(snap, JSON.stringify({ services: { dagu: up, t3: up } }));
      const b = await check({ state: fx.state, snapshot: snap, cycle: fx.cycleFile, factory: join(import.meta.dirname, "..", "src"), now: LIM_NOW });
      assert.equal(b.open, true, `${file} ${name}`);
      assert.equal(b.reasons.some((x) => x.kind === "limits" && x.detail.includes(file) && x.detail.includes(field)), true, `${file} ${name}`);
    }
  }
});
