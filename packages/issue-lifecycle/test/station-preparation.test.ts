import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { initializeStation, promote, rollback, gc } from "@a4s/launcher/station";
import { selectPayload } from "@a4s/launcher/select";
import { createLeaseLocked, prepareLease, selectStationBuild } from "@a4s/launcher/lease";
import type { ArtifactTuple } from "@a4s/launcher/release";
import { stationRoot, stationTransaction } from "@a4s/launcher/station-state";
import { leaseSelection, stationSelection } from "../../loader/src/station.ts";
import { stationFixture } from "./fixtures/station.ts";
import { deferred, inProcessLock } from "./fixtures/state-lock.ts";

test("listing, acquisition and verification stay outside the station lock for every activation path", async t => {
  const f = stationFixture(t), old = await f.release("r1"), next = await f.release("r2");
  // Force the cold path: ensure must checksum, download and extract, not inspect a hit.
  rmSync(join(stationRoot(f.home), next.version), { recursive: true });
  let locked = false, inspections = 0, downloads = 0, listings = 0;
  const dependencies = { ...f.dependencies,
    async withFileLock<T>(path: string, body: () => Promise<T>): Promise<T> {
      assert.equal(locked, false);
      return f.dependencies.withFileLock!(path, async () => {
        locked = true;
        try { return await body(); } finally { locked = false; }
      });
    },
    async inspect(home: string, tuple: ArtifactTuple) {
      assert.equal(locked, false, "archive verification cannot hold .state.lock");
      inspections++;
      return f.dependencies.inspect!(home, tuple);
    },
    async ensure(home: string, release: typeof next) {
      assert.equal(locked, false, "download/extraction cannot hold .state.lock");
      downloads++;
      return f.dependencies.ensure!(home, release);
    },
    async releases() { assert.equal(locked, false); listings++; return [next]; },
    async inventory(home: string) { assert.equal(locked, false, "per-run inventory cannot hold .state.lock"); return f.dependencies.inventory!(home); },
    probe(pid: number, startedAt: string) {
      assert.equal(locked, false, "lease process probes cannot hold .state.lock");
      return f.dependencies.probe!(pid, startedAt);
    },
  };
  await initializeStation(f.home, old, dependencies);
  assert.equal((await promote(f.home, dependencies)).current.version, "r2");
  assert.equal((await rollback(f.home, dependencies)).current.version, "r1");
  await selectPayload(f.home, ["status"], { ...dependencies, restore: dependencies.inspect });
  await selectStationBuild(f.home, "engine", "test", dependencies);
  const selection = await stationSelection(f.home);
  const lease = await leaseSelection(f.home, selection, dependencies);
  t.after(() => lease.release());
  assert.equal(inspections, 5);
  assert.equal(downloads, 1);
  assert.equal(listings, 1);
});

test("an intervening state commit cannot be overwritten by prepared promotion or rollback", async t => {
  for (const operation of ["promotion", "rollback"] as const) {
    const f = stationFixture(t), old = await f.release("r1"), next = await f.release("r2");
    await initializeStation(f.home, old, f.dependencies);
    const changed = { ...f.state(), generation: 7 };
    if (operation === "promotion") {
      await assert.rejects(promote(f.home, { ...f.dependencies, releases: async () => [next], ensure: async (home, release) => {
        const cached = await f.dependencies.ensure!(home, release);
        f.setState(changed); return cached;
      } }), /Station changed during promotion preparation/);
    } else {
      await assert.rejects(rollback(f.home, { ...f.dependencies, inspect: async (home, tuple) => {
        const cached = await f.dependencies.inspect!(home, tuple);
        f.setState(changed); return cached;
      } }), /Station changed during rollback preparation/);
    }
    assert.deepEqual(f.state(), changed);
  }
});

test("a verified candidate removed by GC before commit is never selected", async t => {
  const f = stationFixture(t), old = await f.release("r1"), next = await f.release("r2");
  await initializeStation(f.home, old, f.dependencies);
  const before = f.stateBytes();
  const report = await promote(f.home, { ...f.dependencies, releases: async () => [next], ensure: async (home, release) => {
    const cached = await f.dependencies.ensure!(home, release);
    rmSync(join(stationRoot(home), release.version), { recursive: true });
    return cached;
  } });
  assert.equal(report.promoted, false);
  assert.match(report.skipped[0]!.reason, /ENOENT/);
  assert.equal(f.stateBytes(), before);
});

for (const operation of ["promotion", "rollback", "GC"] as const) {
  test(`a feature-step transaction meets its deadline during repeated ${operation} per-run inventory`, async t => {
    const f = stationFixture(t), old = await f.release("r1"), next = await f.release("r2");
    await initializeStation(f.home, old, f.dependencies);
    if (operation === "rollback") await promote(f.home, { ...f.dependencies, releases: async () => [next] });
    const entered = Array.from({ length: 4 }, deferred), release = Array.from({ length: 4 }, deferred);
    const dependencies = { ...f.dependencies, withFileLock: inProcessLock(100), releases: async () => [next],
      async inventory() {
        for (let run = 0; run < entered.length; run++) {
          entered[run]!.resolve();
          await release[run]!.promise;
        }
        return { formats: {}, references: [], expiredBindings: [] };
      },
    };
    const reconciliation = operation === "promotion" ? promote(f.home, dependencies) : operation === "rollback" ? rollback(f.home, dependencies) : gc(f.home, dependencies);
    try {
      for (let run = 0; run < entered.length; run++) {
        await entered[run]!.promise;
        assert.equal(await stationTransaction(f.home, async () => "feature-step committed", dependencies), "feature-step committed");
        release[run]!.resolve();
      }
      await reconciliation;
    } finally {
      for (const gate of release) gate.resolve();
      await reconciliation.catch(() => {});
    }
  });
}

test("a reader published and released during inventory invalidates promotion before commit", async t => {
  const f = stationFixture(t), old = await f.release("r1"), next = await f.release("r2");
  await initializeStation(f.home, old, f.dependencies);
  mkdirSync(join(stationRoot(f.home), "leases"));
  const before = f.stateBytes(), prepared = prepareLease(old, 0, "plugin", "concurrent observer");
  await assert.rejects(promote(f.home, { ...f.dependencies, releases: async () => [next], async inventory() {
    await stationTransaction(f.home, async () => createLeaseLocked(f.home, prepared), f.dependencies);
    rmSync(join(stationRoot(f.home), "leases", `${prepared.id}.json`));
    return { formats: {}, references: [], expiredBindings: [] };
  } }), /Station references changed during promotion preparation/);
  assert.equal(f.stateBytes(), before);
});
