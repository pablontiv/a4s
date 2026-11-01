import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { initializeStation, promote, rollback } from "@a4s/launcher/station";
import { selectPayload } from "@a4s/launcher/select";
import { selectStationBuild } from "@a4s/launcher/lease";
import type { ArtifactTuple } from "@a4s/launcher/release";
import { stationRoot } from "@a4s/launcher/station-state";
import { leaseSelection, stationSelection } from "../../loader/src/station.ts";
import { stationFixture } from "./fixtures/station.ts";

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
