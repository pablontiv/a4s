import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeStation, promote, rollback, gc } from "@a4s/launcher/station";
import { selectPayload } from "@a4s/launcher/select";
import { createLeaseLocked, prepareLease, selectStationBuild } from "@a4s/launcher/lease";
import type { ArtifactTuple } from "@a4s/launcher/release";
import { stationRoot, stationTransaction, writeJsonDurable } from "@a4s/launcher/station-state";
import { leaseSelection, stationSelection } from "../../loader/src/station.ts";
import { configSupport, stationFixture } from "./fixtures/station.ts";
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

for (const operation of ["initialization", "promotion", "rollback"] as const) {
  test(`config formats changed after inventory cannot be committed by ${operation}`, async t => {
    const f = stationFixture(t), old = await f.release("r1", configSupport([1], 1)), next = await f.release("r2", configSupport([1], 1));
    if (operation !== "initialization") await initializeStation(f.home, old, f.dependencies);
    if (operation === "rollback") f.setState({ ...f.state(), current: next, previous: old });
    const before = operation === "initialization" ? undefined : f.stateBytes();
    const { inventory: _, ...base } = f.dependencies;
    let schemaVersion = 1, acquisitions = 0;
    const dependencies = { ...base, primaries: () => [f.root], gitPath: () => join(f.root, "inventory"),
      configVersion: () => schemaVersion, listRuns: async () => [], releases: async () => [next],
      async withFileLock<T>(path: string, body: () => Promise<T>) {
        // On the old path this is after the inventory and before its commit.
        // The authoritative final input proof must instead see schema 2.
        if (path.endsWith("/.state.lock") && ++acquisitions === 2) schemaVersion = 2;
        return base.withFileLock!(path, body);
      },
    };
    await assert.rejects(operation === "initialization" ? initializeStation(f.home, old, dependencies)
      : operation === "promotion" ? promote(f.home, dependencies) : rollback(f.home, dependencies),
    { code: "ESTALE", message: /inventory inputs changed.*retry/ });
    assert.equal(schemaVersion, 2, "the config changed at the final state-lock acquisition");
    if (before === undefined) assert.equal(existsSync(join(stationRoot(f.home), "state.json")), false);
    else assert.equal(f.stateBytes(), before);
  });
}

for (const source of ["receipt", "SQLite", "SQLite WAL"] as const) {
  test(`a ${source} stat change after inventory aborts promotion before commit`, async t => {
    const f = stationFixture(t), old = await f.release("r1"), next = await f.release("r2");
    await initializeStation(f.home, old, f.dependencies);
    const before = f.stateBytes(), directory = join(f.root, "repo", ".git", "dagu-feature"), run = join(directory, "runs", "old");
    mkdirSync(run, { recursive: true });
    const receipt = { schemaVersion: 2, artifact: old, initial: { admittedAt: "2026-10-01T00:00:00Z" }, runReceipt: { dag: "feature", run: "old" } };
    writeJsonDurable(join(run, "receipt.json"), receipt);
    const database = join(f.home, "role-jobs.sqlite");
    let writer: DatabaseSync | undefined;
    if (source !== "receipt") {
      writer = new DatabaseSync(database);
      if (source === "SQLite WAL") writer.exec("PRAGMA journal_mode=WAL");
      writer.exec("CREATE TABLE jobs(document TEXT, result TEXT)");
      if (source === "SQLite") { writer.close(); writer = undefined; }
    }
    const { inventory: _, ...base } = f.dependencies;
    let acquisitions = 0;
    try {
      await assert.rejects(promote(f.home, { ...base, primaries: () => [f.root], gitPath: () => directory, configVersion: () => 2,
        releases: async () => [next], listRuns: async () => [{ name: "feature", dagRunId: "old", statusLabel: "succeeded" }],
        async withFileLock<T>(path: string, body: () => Promise<T>) {
          if (path.endsWith("/.state.lock") && ++acquisitions === 2) {
            if (source === "receipt") writeFileSync(join(run, "receipt.json"), `${JSON.stringify(receipt)}\n\n`);
            else if (writer) writer.exec("PRAGMA user_version=2");
            else {
              const db = new DatabaseSync(database);
              try { db.exec("PRAGMA user_version=2"); } finally { db.close(); }
            }
          }
          return base.withFileLock!(path, body);
        },
      }), { code: "ESTALE", message: /inventory inputs changed.*retry/ });
      assert.equal(acquisitions, 2);
      assert.equal(f.stateBytes(), before);
    } finally { writer?.close(); }
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
