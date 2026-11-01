import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { withFileLockAsync } from "../src/file-lock.ts";
import { selectStationBuild } from "../src/lease.ts";
import { selectPayload } from "../src/select.ts";
import { readStationState, stationRoot, stationTransaction } from "../src/station-state.ts";
import { useStation } from "../../issue-lifecycle/test/fixtures/service-environment.ts";
import { fixture } from "./fixture.ts";
import { deferred, inProcessLock } from "../../issue-lifecycle/test/fixtures/state-lock.ts";

test("a step lease meets its deadline while tick history confirmation waits outside the lock", async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const dependencies = { ...f.dependencies, withFileLock: inProcessLock(100), async confirm() {
    entered.resolve(); await release.promise; return "first" as const;
  } };
  const tick = selectPayload(f.home, ["tick"], dependencies);
  try {
    await entered.promise;
    assert.ok(f.dependencies.restore);
    const step = await selectStationBuild(f.home, "engine", "feature-step", { ...dependencies, inspect: f.dependencies.restore });
    assert.deepEqual(step.artifact, f.a);
  } finally { release.resolve(); await tick; }
});

test("repeated read-only observer polls read complete envelopes while a writer owns the station lock", async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const dependencies = { ...f.dependencies, withFileLock: inProcessLock(100) };
  const writer = stationTransaction(f.home, async () => { entered.resolve(); await release.promise; }, dependencies);
  try {
    await entered.promise;
    for (let poll = 0; poll < 20; poll++) {
      assert.deepEqual(await readStationState(f.home), f.state);
    }
  } finally { release.resolve(); await writer; }
});

test("lock deadlines report elapsed wait and every distinct acquisition record observed while polling", async t => {
  const f = fixture(t), path = join(stationRoot(f.home), ".state.lock");
  const restore = useStation(f.home);
  t.after(restore);
  const records = [101, 202].map(pid => JSON.stringify({ pid, host: "fixture", command: ["omp", "--resume", String(pid)], acquiredAt: `2026-10-29T00:00:0${pid === 101 ? 1 : 2}Z` }));
  let clock = 0, attempts = 0, ran = false;
  const now = t.mock.method(performance, "now", () => clock);
  const flock = t.mock.method(childProcess, "spawnSync", (command: string, args: string[]) => {
    assert.equal(command, "python3");
    assert.equal(args[2], "6", "deadline polling must use nonblocking exclusive acquisition");
    writeFileSync(path, records[attempts++ % records.length]!);
    clock += 25;
    return { pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 73, signal: null };
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withFileLockAsync(path, async () => { ran = true; }, { timeoutMs: 100 }), error => {
      const deadline = error as Error & { code: string; waitedMs: number; holders: string[] };
      assert.equal(deadline.code, "ETIMEDOUT");
      assert.equal(deadline.waitedMs, 100);
      assert.deepEqual(deadline.holders, records);
      assert.match(deadline.message, /after 100ms \(waited 100ms\)/);
      for (const record of records) assert.ok(deadline.message.includes(record));
      assert.match(deadline.message, /not proof of current ownership/);
      return true;
    });
    assert.equal(attempts, 4);
    assert.equal(ran, false);
  } finally { now.mock.restore(); flock.mock.restore(); syncBuiltinESMExports(); }
});
