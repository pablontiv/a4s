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
