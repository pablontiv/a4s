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
