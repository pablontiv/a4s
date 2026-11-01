import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { artifactLock, type CachedArtifact } from "../src/artifact-cache.ts";
import { registrationHash } from "../src/contracts.ts";
import { CONFIG_PATH, exampleConfig } from "../src/config.ts";
import { createLeaseLocked } from "../src/lease.ts";
import { prepareInventory } from "../src/station-inventory.ts";
import { gc, initializeStation, promote, rollback, type StationDependencies } from "../src/station.ts";
import { stationRoot, stationTransaction } from "../src/station-state.ts";
import type { ArtifactTuple } from "../src/release.ts";
import { fixture } from "./fixture.ts";
import { barrier, stateLock } from "./fixtures/state-lock.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const operations = ["promote", "rollback", "init", "GC"] as const;
type Operation = typeof operations[number];

async function holdFixture(t: TestContext, operation: Operation = "promote") {
  const f = fixture(t), lock = stateLock();
  const builds: CachedArtifact[] = [];
  for (let id = 1; id <= 14; id++) {
    const tuple: ArtifactTuple = { version: `r${id}`, commit: id.toString(16).padStart(40, "0"), digest: id.toString(16).padStart(64, "0") };
    const cached = await f.dependencies.restore!(f.home, tuple);
    cached.identity.registrationManifestHash = registrationHash(cached.identity.registrationManifest);
    cached.identity = structuredClone(cached.identity);
    writeFileSync(join(cached.directory, "identity.json"), JSON.stringify(cached.identity));
    builds.push(cached);
  }
  const current = builds[12]!, candidate = builds[13]!, previous = builds[11]!;
  f.setState({ ...f.state, current: current.record, previous: previous.record });
  if (operation === "init") rmSync(join(stationRoot(f.home), "state.json"));
  const directory = join(f.primary, ".git", "dagu-feature");
  const runs: Array<{ name: string; dagRunId: string; statusLabel: string; primary?: string }> = [];
  let config = 2;
  const dependencies: StationDependencies = { ...f.dependencies, withFileLock: lock.withFileLock,
    primaries: () => [f.primary], gitPath: () => directory, configVersion: () => config,
    listRuns: async () => structuredClone(runs), now: () => NOW, probe: () => "alive",
    releases: async () => [candidate.record], ensure: async () => candidate,
    inspect: async () => operation === "init" ? current : previous,
  };
  function receipt(run: string, artifact = builds[0]!.record, extra: Record<string, unknown> = {}) {
    const path = join(directory, "runs", run, "receipt.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, artifact,
      initial: { admittedAt: new Date(NOW - 86400000).toISOString() },
      runReceipt: { dag: "feature", run }, ...extra }));
    return path;
  }
  function execute(deps = dependencies) {
    if (operation === "GC") return gc(f.home, deps);
    if (operation === "init") return initializeStation(f.home, current.record, deps);
    return operation === "promote" ? promote(f.home, deps) : rollback(f.home, deps);
  }
  return { ...f, lock, builds, current, candidate, previous, directory, runs, dependencies, receipt, execute,
    config(value: number) { config = value; },
    bytes: () => existsSync(join(stationRoot(f.home), "state.json")) ? readFileSync(join(stationRoot(f.home), "state.json"), "utf8") : undefined,
  };
}

for (const operation of operations) {
  test(`${operation}: a feature transaction meets its 10s deadline during slow preparation`, async t => {
    const f = await holdFixture(t, operation), entered = barrier(), resume = barrier();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const running = f.execute({ ...f.dependencies, inventory: async () => {
      entered.open(); await resume.promise;
      return { formats: {}, references: [], expiredBindings: [] };
    } });
    await entered.promise;
    let feature: "pending" | "completed" | "timed out" = "pending";
    const transaction = stationTransaction(f.home, async () => { feature = "completed"; }, f.dependencies)
      .catch(error => { assert.equal(error.code, "ETIMEDOUT"); feature = "timed out"; });
    // Flush the uncontended mutex before advancing the actual 10,000ms deadline.
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(10001);
    await transaction;
    resume.open(); await running;
    assert.equal(feature, "completed");
  });
}

for (const change of ["config", "receipt schema", "receipt contracts", "SQLite schema", "new reader", "open binding"] as const) {
  test(`promotion re-derives ${change} changed during preparation`, async t => {
    const f = await holdFixture(t), path = f.receipt("existing", f.builds[0]!.record);
    f.runs.push({ name: "feature", dagRunId: "existing", statusLabel: "succeeded" });
    const db = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(document TEXT, result TEXT); PRAGMA user_version=1");
    t.after(() => db.close());
    const before = f.bytes();
    const oldReader = f.builds[0]!;
    oldReader.identity.support.config = { read: [1], write: 1 };
    writeFileSync(join(oldReader.directory, "identity.json"), JSON.stringify(oldReader.identity));
    const report = await f.execute({ ...f.dependencies, listRuns: async () => {
      if (change === "config") f.config(3);
      if (change === "receipt schema") f.receipt("existing", oldReader.record, { schemaVersion: 3 });
      if (change === "receipt contracts") f.receipt("existing", oldReader.record, { contracts: { config: 3 } });
      if (change === "SQLite schema") db.exec("PRAGMA user_version=3");
      if (change === "new reader") f.receipt("new", oldReader.record, { receiptCreatedAt: new Date(NOW).toISOString() });
      if (change === "open binding") db.prepare("INSERT INTO jobs VALUES (?,NULL)").run(JSON.stringify({ schemaVersion: 1, binding: { repo: f.primary, run: "existing", dag: "feature" } }));
      return structuredClone(f.runs);
    } }).catch(error => error as Error);
    assert.ok(report instanceof Error || "promoted" in report && !report.promoted, `${change} must prevent a stale promotion`);
    assert.equal(f.bytes(), before);
    assert.ok(existsSync(path));
  });
}

for (const change of ["receipt artifact", "new receipt", "new lease", "new tick", "open binding"] as const) {
  test(`GC retains a ${change} reader appearing during preparation`, async t => {
    const f = await holdFixture(t, "GC"), old = f.builds[0]!.record;
    f.receipt("existing", f.current.record);
    f.runs.push({ name: "feature", dagRunId: "existing", statusLabel: "succeeded" });
    const db = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(document TEXT, result TEXT); PRAGMA user_version=1");
    t.after(() => db.close());
    const report = await gc(f.home, { ...f.dependencies, listRuns: async () => {
      if (change === "receipt artifact") f.receipt("existing", old);
      if (change === "new receipt") f.receipt("new", old);
      if (change === "new lease") {
        const path = join(stationRoot(f.home), "leases", "abc.json"); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ schema: 1, id: "abc", artifact: old, host: "fixture", pid: 123,
          processStartedAt: "fixture", generation: 0, kind: "engine", holder: "new reader" }));
      }
      if (change === "new tick") {
        const path = join(stationRoot(f.home), "ticks", "new.json"); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ dagRunId: "new", tuple: old, createdAt: new Date(NOW).toISOString() }));
      }
      if (change === "open binding") {
        f.receipt("job", old);
        db.prepare("INSERT INTO jobs VALUES (?,NULL)").run(JSON.stringify({ schemaVersion: 1, binding: { repo: f.primary, run: "job", dag: "feature" } }));
      }
      return structuredClone(f.runs);
    }, bindingRun: async () => ({ name: "reconcile", dagRunId: "new", statusLabel: "waiting" }) });
    assert.ok(!report.removed.includes(old.version));
    assert.ok(existsSync(join(stationRoot(f.home), old.version)));
    assert.ok(report.removed.includes("r2"), "an unrelated unreferenced build is still collected");
  });
}

test("GC follows admission's state-then-artifact order without a step-deadline stall", async t => {
  const f = await holdFixture(t, "GC"), firstCollected = f.builds[3]!, tuple = firstCollected.record;
  const statePath = join(stationRoot(f.home), ".state.lock"), artifactPath = artifactLock(f.home, tuple);
  const contended = barrier(), admit = barrier();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stateRequests = 0, admission: Promise<void> | undefined;
  const collecting = gc(f.home, { ...f.dependencies, withFileLock: (path, body, options) => {
    if (path === statePath && ++stateRequests === 2) {
      // Match selectedAdmission: own state before attempting the artifact lock.
      // GC has finished its initial plan, but has not acquired its next state hold.
      admission = stationTransaction(f.home, async () => {
        await admit.promise;
        await f.lock.withFileLock(artifactPath, async () => {
          assert.ok(existsSync(firstCollected.directory));
          createLeaseLocked(f.home, tuple, f.state.generation, "engine", "contending admission");
        });
      }, f.dependencies);
      contended.open();
    }
    return f.lock.withFileLock(path, body, options);
  } });
  await contended.promise;
  const feature = stationTransaction(f.home, async () => {}, f.dependencies);
  let completed = false;
  const contenders = Promise.allSettled([collecting, admission!, feature]).then(results => {
    completed = true; return results;
  });
  admit.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    assert.equal(completed, true, "GC, admission and the queued feature step finish before advancing the 10s deadline");
    assert.ok((await contenders).every(result => result.status === "fulfilled"));
    assert.ok(!(await collecting).removed.includes(tuple.version), "admission's new lease protects the build");
    assert.ok(f.lock.holds.every(hold => hold.milliseconds < 10000));
  } finally {
    // Settle the deliberately inverted implementation too, so a RED run cannot hang.
    t.mock.timers.tick(10001);
    await contenders;
  }
});

test("GC retains a busy artifact publisher without waiting under the state lock", async t => {
  const f = await holdFixture(t, "GC"), tuple = f.builds[0]!.record;
  const statePath = join(stationRoot(f.home), ".state.lock"), artifactPath = artifactLock(f.home, tuple);
  const entered = barrier(), release = barrier();
  const publisher = f.lock.withFileLock(artifactPath, async () => { entered.open(); await release.promise; });
  await entered.promise;
  try {
    const report = await gc(f.home, { ...f.dependencies, withFileLock: (path, body, options) => {
      if (path === artifactPath) {
        assert.equal(f.lock.held(statePath), true, "GC preserves admission's state-then-artifact order");
        assert.equal(options?.timeoutMs, 0, "a busy publisher is never waited on");
      }
      return f.lock.withFileLock(path, body, options);
    } });
    assert.ok(!report.removed.includes(tuple.version));
    assert.match(report.retained.find(entry => entry.version === tuple.version)!.holders.join(), /artifact lock busy/);
    assert.ok(existsSync(f.builds[0]!.directory));
    assert.ok(report.removed.includes("r2"), "unrelated unreferenced builds are still collected");
    assert.ok(f.lock.holds.filter(hold => hold.path === statePath).every(hold => hold.milliseconds < 1000));
  } finally { release.open(); await publisher; }
});

for (const operation of ["promote", "GC"] as const) {
  for (const activity of ["observer leases", "CI observations", "role-job rows", "receipt observations"] as const) {
    test(`${operation} remains live with ${activity} during preparation`, async t => {
      const f = await holdFixture(t, operation), path = f.receipt("terminal", f.current.record);
      f.runs.push({ name: "feature", dagRunId: "terminal", statusLabel: "succeeded" });
      const db = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(document TEXT, result TEXT); PRAGMA user_version=1");
      t.after(() => db.close());
      const result = await f.execute({ ...f.dependencies, listRuns: async () => {
        for (let index = 0; index < 3; index++) {
          if (activity === "observer leases") {
            const directory = join(stationRoot(f.home), "leases"); mkdirSync(directory, { recursive: true });
            const lease = join(directory, "abc.json"); writeFileSync(lease, "{}"); rmSync(lease);
          }
          if (activity === "CI observations") for (const name of ["ci-observation.json", "ci-no-progress.json"]) writeFileSync(join(dirname(path), name), JSON.stringify({ index }));
          if (activity === "role-job rows") db.prepare("INSERT INTO jobs VALUES (?,?)").run(
            JSON.stringify({ schemaVersion: 1, binding: { repo: f.primary, dag: "feature", run: "terminal" }, index }), JSON.stringify({ schemaVersion: 1 }));
          if (activity === "receipt observations") {
            const value = JSON.parse(readFileSync(path, "utf8")); value.runReceipt.observations = [{ index }]; writeFileSync(path, JSON.stringify(value));
          }
        }
        return structuredClone(f.runs);
      } });
      if (operation === "promote") assert.ok("promoted" in result && result.promoted);
      else assert.ok("removed" in result && result.removed.includes("r1"));
    });
  }
}

for (const statusLabel of ["failed", "aborted", "partially_succeeded", "unknown", "unlisted"]) {
  test(`GC alone conservatively retains ${statusLabel} possible readers`, async t => {
    const f = await holdFixture(t, "GC"); f.receipt("possible", f.builds[0]!.record);
    if (statusLabel !== "unlisted") f.runs.push({ name: "feature", dagRunId: "possible", statusLabel });
    const result = await gc(f.home, f.dependencies);
    assert.ok(!result.removed.includes("r1"));
    assert.match(result.retained.find(row => row.version === "r1")!.holders.join(), /possible reader/);
  });
}

for (const statusLabel of ["failed", "aborted", "partially_succeeded", "unknown"]) {
  test(`GC excludes artifact-less legacy ${statusLabel} receipts from possible cache readers`, async t => {
    const f = await holdFixture(t, "GC"); f.receipt("legacy", f.builds[0]!.record, { schemaVersion: 1, artifact: undefined });
    f.runs.push({ name: "feature", dagRunId: "legacy", statusLabel });
    assert.ok((await gc(f.home, f.dependencies)).removed.includes("r1"));
  });
}

for (const operation of ["init", "rollback"] as const) {
  test(`${operation} re-derives persisted formats at the final transaction`, async t => {
    const f = await holdFixture(t, operation), before = f.bytes();
    let stateLocks = 0;
    const commitLock = operation === "init" ? 1 : 2;
    await assert.rejects(f.execute({ ...f.dependencies, withFileLock: async (path, body, options) => {
      if (path.endsWith("/.state.lock") && ++stateLocks === commitLock) {
        // Another publisher completed after preparation but before our lock.
        await f.lock.withFileLock(path, async () => { f.receipt("new", f.current.record, { schemaVersion: 3 }); }, options);
      }
      return f.lock.withFileLock(path, body, options);
    } }), /receipt\/3/);
    assert.equal(f.bytes(), before);
  });
}

function commitConfig(primary: string, value = exampleConfig()): void {
  const path = join(primary, CONFIG_PATH); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  childProcess.execFileSync("git", ["-C", primary, "add", "--", CONFIG_PATH]);
  childProcess.execFileSync("git", ["-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "policy"]);
}

for (const operation of operations) {
  test(`${operation} has no HTTP, Git, hashing, restoration or recursive removal in its state hold`, async t => {
    const f = await holdFixture(t, operation);
    commitConfig(f.primary);
    f.receipt("historical", f.current.record);
    f.runs.push({ name: "feature", dagRunId: "historical", statusLabel: "succeeded" });
    const statePath = join(stationRoot(f.home), ".state.lock");
    const unlocked = () => assert.equal(f.lock.held(statePath), false, "slow work must precede or follow the state hold");
    const exec = childProcess.execFileSync, hash = crypto.createHash, remove = fs.rmSync;
    t.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof exec>) => { unlocked(); return exec(...args); });
    t.mock.method(crypto, "createHash", (...args: Parameters<typeof hash>) => { unlocked(); return hash(...args); });
    t.mock.method(fs, "rmSync", (...args: Parameters<typeof remove>) => {
      if (args[1]?.recursive) {
        unlocked();
        const collected = f.builds.find(build => String(args[0]).startsWith(`${build.directory}.gc-`));
        if (collected) assert.equal(f.lock.held(artifactLock(f.home, collected.record)), false, "recursive removal holds no artifact lock");
      }
      return remove(...args);
    });
    t.mock.method(globalThis, "fetch", async () => { unlocked(); throw new Error("Unexpected HTTP endpoint"); });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const { configVersion: _config, gitPath: _git, ...native } = f.dependencies;
    await f.execute({ ...native,
      listRuns: async () => { unlocked(); return structuredClone(f.runs); },
      inspect: async (home, tuple) => { unlocked(); return f.dependencies.inspect!(home, tuple); },
      ensure: async (home, release) => { unlocked(); return f.dependencies.ensure!(home, release); },
      probe: () => { unlocked(); return "alive"; },
    });
    assert.ok(f.lock.holds.filter(hold => hold.path === statePath).every(hold => hold.milliseconds < 1000));
  });
}

for (const operation of ["promote", "GC"] as const) {
  test(`${operation} rejects a changed committed config binding without a stale mutation`, async t => {
    const f = await holdFixture(t, operation), before = f.bytes();
    commitConfig(f.primary);
    const { configVersion: _config, gitPath: _git, ...native } = f.dependencies;
    await assert.rejects(f.execute({ ...native, listRuns: async () => {
      commitConfig(f.primary, { ...exampleConfig(), lane: "changed-policy" });
      return [];
    } }), /Committed config changed/);
    assert.equal(f.bytes(), before);
    assert.ok(existsSync(f.builds[0]!.directory), "no stale GC deletion");
  });
}

test("receipt stat changes refresh decision fields, not unrelated observation churn", async t => {
  const f = await holdFixture(t, "GC"), path = f.receipt("terminal", f.current.record, { snapshot: "x".repeat(4 * 1024 * 1024) });
  f.runs.push({ name: "feature", dagRunId: "terminal", statusLabel: "succeeded" });
  const original = fs.readFileSync;
  let receiptReads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === path) receiptReads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const prepared = await prepareInventory(f.home, f.dependencies, true, true);
  assert.equal(receiptReads, 1);
  const first = await prepared.readLocked();
  assert.equal(receiptReads, 1, "unchanged multi-megabyte receipt was not reread under the lock");
  assert.ok(!first.references.some(reference => reference.artifact.version === f.current.record.version));
  const value = JSON.parse(original(path, "utf8")); value.runReceipt.observations = ["new status"];
  writeFileSync(path, JSON.stringify(value));
  const refreshed = await prepared.readLocked();
  assert.equal(receiptReads, 2);
  assert.ok(!refreshed.references.some(reference => reference.artifact.version === f.current.record.version));
  value.artifact = f.builds[0]!.record; writeFileSync(path, JSON.stringify(value));
  const changed = await prepared.readLocked();
  assert.equal(receiptReads, 3);
  assert.ok(changed.references.some(reference => reference.artifact.version === "r1" && reference.holder.includes("changed receipt")));
});

test("the local decision deadline fails closed before publication or collection", async t => {
  const f = await holdFixture(t, "GC"), before = f.bytes();
  const prepared = await prepareInventory(f.home, f.dependencies, true, true);
  let now = 0;
  t.mock.method(performance, "now", () => { now += 1001; return now; });
  await assert.rejects(prepared.readLocked(), /exceeded 1000ms/);
  assert.equal(f.bytes(), before);
  assert.ok(existsSync(f.builds[0]!.directory));
});

for (const input of ["config proof", "tick bindings"] as const) {
  test(`${input} checks its deadline before reading another input`, async t => {
    const f = await holdFixture(t, "GC");
    commitConfig(f.primary);
    const ticks = join(stationRoot(f.home), "ticks");
    if (input === "tick bindings") {
      mkdirSync(ticks, { recursive: true });
      for (let id = 0; id < 3; id++) writeFileSync(join(ticks, `tick${id}.json`), JSON.stringify({
        dagRunId: `tick${id}`, tuple: f.current.record, createdAt: new Date(NOW).toISOString(),
      }));
    }
    const { configVersion: _config, gitPath: _git, ...native } = f.dependencies;
    const prepared = await prepareInventory(f.home, { ...(input === "config proof" ? native : f.dependencies),
      bindingRun: async binding => ({ name: "reconcile", dagRunId: binding.dagRunId, statusLabel: "succeeded" }),
    }, true, true);
    const original = fs.readFileSync;
    let now = 0, expiredReads = 0, triggered = false;
    t.mock.method(performance, "now", () => now);
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
      if (now > 1000) expiredReads++;
      const result = original(...args), path = String(args[0]);
      if (!triggered && (input === "config proof" ? path === join(f.primary, CONFIG_PATH) : path.startsWith(`${ticks}/`))) {
        triggered = true; now = 1001;
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(prepared.readLocked(), /exceeded 1000ms/);
    assert.equal(triggered, true);
    assert.equal(expiredReads, 0, "stop inside the reader instead of finishing its remaining files after expiry");
  });
}
