import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquire, daguIsAlive, leaseDir, noteWait, readLease, reclaimDead, recordWait, releaseLease, takeLease, waitedMs, waitedWithin } from "../src/lease.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "lease-"));

test("take: records the owner run and time; taking again by the owner is idempotent", () => {
  const s = tmp();
  const t = takeLease(s, "r1", { now: Date.parse("2026-01-01T00:00:00Z"), dag: "cycle" });
  assert.equal(t.ok, true);
  assert.deepEqual(readLease(s), { run: "r1", dag: "cycle", takenAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(takeLease(s, "r1").ok, true);
  assert.equal(takeLease(s, "r2").ok, false);
  assert.equal(readLease(s).run, "r1");
  assert.deepEqual(readdirSync(s), ["integrate.lease"]);
  assert.deepEqual(readdirSync(leaseDir(s)), ["g1"]); // no temp files left
});

test("release: by the owner frees it; refused for another run", () => {
  const s = tmp();
  takeLease(s, "r1");
  const refused = releaseLease(s, "r2");
  assert.deepEqual([refused.released, refused.reason], [false, "other-owner"]);
  assert.equal(readLease(s).run, "r1");
  assert.equal(releaseLease(s, "r1").released, true);
  assert.equal(readLease(s), null);
  assert.equal(releaseLease(s, "r1").reason, "not-held");
  assert.deepEqual(readdirSync(leaseDir(s)).sort(), ["g1", "g1.released"]);
  // the next owner gets a new generation; old generations are collected
  for (const r of ["r2", "r3", "r4"]) { assert.equal(takeLease(s, r).ok, true); assert.equal(releaseLease(s, r).released, true); }
  assert.deepEqual(readdirSync(leaseDir(s)).sort(), ["g3", "g3.released", "g4", "g4.released"]);
});

test("reclaim: a dead owner's lease is taken over and logged; a live one is not", () => {
  const s = tmp();
  takeLease(s, "dead");
  const logs = [];
  assert.equal(reclaimDead(s, () => true, (m) => logs.push(m)), null);
  assert.equal(readLease(s).run, "dead");
  assert.equal(reclaimDead(s, (o) => o.run !== "dead", (m) => logs.push(m)).run, "dead");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reclaimed .*dead/);
  assert.equal(takeLease(s, "next").ok, true);
});

test("reclaim: a corrupt lease record is reclaimed", () => {
  const s = tmp();
  mkdirSync(leaseDir(s)); writeFileSync(join(leaseDir(s), "g1"), "{not json");
  assert.deepEqual(readLease(s), { corrupt: true });
  assert.equal(takeLease(s, "r").ok, false);
  assert.ok(reclaimDead(s, () => true));
  assert.equal(takeLease(s, "r").ok, true);
});

test("two contenders: exactly one wins", async () => {
  const s = tmp();
  const code = `import("${new URL("../src/lease.mjs", import.meta.url).href}").then(m=>{process.exit(m.takeLease(process.argv[1],process.argv[2]).ok?0:1)})`;
  const run = (id) => new Promise((res) => { import("node:child_process").then(({ spawn }) => spawn("node", ["-e", code, s, id]).on("exit", res)); });
  const codes = await Promise.all(["a", "b", "c", "d"].map(run));
  assert.equal(codes.filter((c) => c === 0).length, 1);
  assert.equal(takeLease(s, readLease(s).run).ok, true);
});

test("acquire: waits for the holder, records the wait, reclaims a dead holder", async () => {
  const s = tmp(); const is = join(s, "7");
  takeLease(s, "holder");
  let t = 1000, n = 0; const logs = [];
  const r = await acquire({ state: s, run: "me", issueState: is, isAlive: () => true, now: () => t,
    sleep: async (ms) => {
      // while waiting, the wait is already on disk (open) and counts for the breaker up to now
      const w = JSON.parse(readFileSync(join(is, "lease-wait.json"), "utf8"));
      assert.equal(w.waits.length, 1); assert.equal(w.waits[0].open, true); assert.equal(w.waits[0].ms, n * 500);
      assert.equal(waitedWithin(is, 1000, Date.parse(w.waits[0].to) + 30_000), n * 500 + 30_000);
      t += ms; if (++n === 3) releaseLease(s, "holder");
    }, pollMs: 500, log: (m) => logs.push(m) });
  assert.equal(r.waitedMs, 1500);
  assert.equal(waitedMs(is), 1500);
  assert.equal(JSON.parse(readFileSync(join(is, "lease-wait.json"), "utf8")).waits[0].open, undefined);
  assert.equal(readLease(s).run, "me");
  assert.ok(logs.some((m) => /waiting for the integration lease held by holder/.test(m)));
  assert.match(logs.at(-1), /waiting 1500 ms/);
  releaseLease(s, "me");
  takeLease(s, "ghost");
  const r2 = await acquire({ state: s, run: "me2", issueState: is, isAlive: (o) => o.run !== "ghost", log: (m) => logs.push(m) });
  assert.equal(readLease(s).run, "me2");
  assert.ok(logs.some((m) => /reclaimed .*ghost/.test(m)));
  assert.equal(r2.waitedMs >= 0, true);
});

test("acquire: no deadline by default (contention alone never fails); an explicit one still records the wait", async () => {
  const s = tmp(); const is = join(s, "8"); takeLease(s, "holder");
  let t = 0;
  // ten hours of a live holder: still waiting, then taken
  const r = await acquire({ state: s, run: "me", issueState: is, isAlive: () => true, now: () => t, pollMs: 60_000,
    sleep: async (ms) => { t += ms; if (t >= 36_000_000) releaseLease(s, "holder"); } });
  assert.equal(r.waitedMs, 36_000_000);
  releaseLease(s, "me"); takeLease(s, "holder2"); t = 0;
  const is2 = join(s, "9");
  await assert.rejects(acquire({ state: s, run: "me", issueState: is2, isAlive: () => true, now: () => t, sleep: async (ms) => { t += ms; }, pollMs: 1000, timeoutMs: 5000 }), /timed out/);
  const w = JSON.parse(readFileSync(join(is2, "lease-wait.json"), "utf8"));
  assert.equal(w.waitedMs, 6000); assert.equal(w.waits[0].open, undefined);
});

test("reclaim race: a reclaimer that checked a dead owner never frees the live lease that replaced it", () => {
  const s = tmp(); const logs = [];
  takeLease(s, "dead");
  // while reclaimer A is asking Dagu about `dead`, B reclaims it and `live` takes the lease
  const slowIsAlive = (o) => {
    assert.equal(o.run, "dead");
    assert.equal(reclaimDead(s, (x) => x.run !== "dead", (m) => logs.push(m)).run, "dead");
    assert.equal(takeLease(s, "live").ok, true);
    return false;
  };
  assert.equal(reclaimDead(s, slowIsAlive, (m) => logs.push(m)), null);
  assert.equal(readLease(s).run, "live");
  assert.equal(logs.length, 1);
  // nobody else can take it now: not a third contender, not the dead owner's late release
  assert.equal(takeLease(s, "third").ok, false);
  assert.equal(releaseLease(s, "dead").released, false);
  assert.equal(reclaimDead(s, () => true), null);
  assert.equal(readLease(s).run, "live");
});

test("reclaim race under real processes: many reclaimers and takers, at every moment at most one holder", async () => {
  const s = tmp();
  takeLease(s, "dead");
  const code = `import("${new URL("../src/lease.mjs", import.meta.url).href}").then(m=>{const [s,id]=process.argv.slice(1);let got=0;for(let i=0;i<200&&!got;i++){m.reclaimDead(s,(o)=>o.run!=="dead");if(m.takeLease(s,id).ok)got=1;}process.stdout.write(got?id:"");})`;
  const { spawn } = await import("node:child_process");
  const run = (id) => new Promise((res) => { let out = ""; const p = spawn("node", ["-e", code, s, id]); p.stdout.on("data", (d) => { out += d; }); p.on("exit", () => res(out)); });
  const winners = (await Promise.all(["a", "b", "c", "d", "e", "f"].map(run))).filter(Boolean);
  assert.equal(winners.length, 1, winners.join(","));
  assert.equal(readLease(s).run, winners[0]);
});

test("recordWait accumulates", () => {
  const is = tmp();
  recordWait(is, 0, 1000); recordWait(is, 5000, 5500);
  assert.equal(waitedMs(is), 1500);
  assert.equal(JSON.parse(readFileSync(join(is, "lease-wait.json"), "utf8")).waits.length, 2);
});

test("daguIsAlive: queued/running alive; finished or unknown run dead; other errors alive", () => {
  const stub = (status, stdout, stderr = "") => () => ({ status, stdout, stderr });
  const alive = (sp) => daguIsAlive({ run: "r", dag: "cycle" }, { spawn: sp, env: {} });
  assert.equal(alive(stub(0, "Running - 2026-11-19T16:35:45.470-06:00\n\ndag: t\n")), true);
  assert.equal(alive(stub(0, "Queued - 2026-11-19T16:35:45.470-06:00\n")), true);
  for (const w of ["Succeeded", "Failed", "Cancelled", "Aborted"]) assert.equal(alive(stub(0, `${w} - 2026-11-19T16:35:45.470-06:00\n`)), false, w);
  assert.equal(alive(stub(1, "", "Error: dag-run ID not found: r")), false);
  assert.equal(alive(stub(1, "", "connection refused")), true);
});

test("waitedWithin: only the part of each wait inside the window counts", () => {
  const is = tmp();
  recordWait(is, 1000, 3000); recordWait(is, 10_000, 12_000);
  assert.equal(waitedWithin(is, 0, 20_000), 4000);
  assert.equal(waitedWithin(is, 2000, 11_000), 2000);
  assert.equal(waitedWithin(is, 4000, 9000), 0);
  assert.equal(waitedWithin(tmp(), 0, 1e12), 0);
});

test("waitedWithin: a wait in progress counts up to now while it is refreshed, not once it went stale", () => {
  const is = tmp();
  noteWait(is, 1000, 5000, { open: true });
  assert.equal(waitedWithin(is, 0, 30_000), 29_000); // refreshed 25 s ago: still waiting
  assert.equal(waitedWithin(is, 0, 500_000), 4000); // not refreshed for minutes: the waiter is gone
  noteWait(is, 1000, 8000, { open: true });
  assert.equal(JSON.parse(readFileSync(join(is, "lease-wait.json"), "utf8")).waits.length, 1);
  noteWait(is, 1000, 9000);
  assert.equal(waitedWithin(is, 0, 30_000), 8000);
  assert.equal(waitedMs(is), 8000);
});

test("daguIsAlive: asks the run's own Dagu store (DAGU_HOME, DAGU_CONFIG)", () => {
  let args;
  daguIsAlive({ run: "r", dag: "cycle" }, { dagu: "d", env: { DAGU_HOME: "/h", DAGU_CONFIG: "/h/c.yaml" }, spawn: (_, a) => { args = a; return { status: 0, stdout: "Running - 2026-11-19T00:00:00Z\n" }; } });
  assert.deepEqual(args, ["status", "--dagu-home", "/h", "--config", "/h/c.yaml", "--run-id", "r", "cycle"]);
  daguIsAlive({ run: "r", dag: "" }, { dagu: "d", env: { DAG_NAME: "x" }, spawn: (_, a) => { args = a; return { status: 0, stdout: "" }; } });
  assert.deepEqual(args, ["status", "--run-id", "r", "x"]);
});
