import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gc } from "../../src/station.ts";
import { bindingRun, listStationRuns, registeredPrimaries } from "../../src/station-inventory.ts";
import { readServiceEnvironment } from "../../src/service-environment.ts";
import { stationRoot } from "../../src/station-state.ts";
import { stateLock } from "./state-lock.ts";

// Opt-in, read-only toward the declared station. Only metadata is copied; all
// locks, resource repair, cache detaches and deletion operate in a fresh temp home.
// Native observations and primary receipt/config reads still use the real station.
const live = readServiceEnvironment(), source = stationRoot(live.DAGU_HOME);
const temporary = mkdtempSync(join(tmpdir(), "a4s-station-hold-"));
const previousCache = process.env.A4S_CACHE_HOME, previousOptionalLocks = process.env.GIT_OPTIONAL_LOCKS;
delete process.env.A4S_CACHE_HOME;
process.env.GIT_OPTIONAL_LOCKS = "0"; // Prevent Git's optional index refresh writes.
try {
  const home = join(temporary, "station"), user = join(temporary, "user"), cache = stationRoot(home);
  assert.ok(cache.startsWith(`${temporary}/`));
  mkdirSync(cache, { recursive: true }); mkdirSync(user);
  const copy = (from: string, to: string) => {
    if (!existsSync(from)) return;
    assert.ok(lstatSync(from).isFile(), "only regular station metadata can be copied");
    copyFileSync(from, to);
  };
  copy(join(source, "state.json"), join(cache, "state.json"));
  let builds = 0, leases = 0, ticks = 0;
  for (const version of readdirSync(source).filter(name => /^(?:r(?:0|[1-9]\d*)|\d+\.\d+\.\d+)$/.test(name))) {
    const destination = join(cache, version); mkdirSync(destination);
    copy(join(source, version, "artifact.json"), join(destination, "artifact.json"));
    copy(join(source, version, "identity.json"), join(destination, "identity.json"));
    builds++;
  }
  for (const name of ["leases", "ticks"] as const) {
    const from = join(source, name), to = join(cache, name); mkdirSync(to);
    for (const file of readdirSync(from)) {
      if (!file.endsWith(".json")) continue;
      try { copy(join(from, file), join(to, file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (name === "leases") leases = readdirSync(to).length; else ticks = readdirSync(to).length;
  }
  // Copy database + journal/WAL, never open the live database (even read-only
  // SQLite may create/update shared-memory bookkeeping). Snapshot races fail shut.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) copy(join(live.DAGU_HOME, `role-jobs.sqlite${suffix}`), join(home, `role-jobs.sqlite${suffix}`));
  const primaries = registeredPrimaries(live.DAGU_HOME), runs = await listStationRuns(live.DAGU_HOME, 100, true);
  const lock = stateLock(), statePath = join(cache, ".state.lock");
  const started = performance.now();
  const report = await gc(home, { withFileLock: lock.withFileLock, env: { ...process.env, HOME: user, DAGU_HOME: home },
    primaries: () => primaries, listRuns: async () => runs,
    bindingRun: async binding => { assert.equal(lock.held(statePath), false); return bindingRun(binding, true); },
  });
  const holds = lock.holds.filter(hold => hold.path === statePath).map(hold => Number(hold.milliseconds.toFixed(3)));
  console.log(JSON.stringify({ kind: "read-only-live-inputs-shadow-GC", primaries: primaries.length, runs: runs.length,
    builds, leases, ticks, stateHoldsMs: holds, maximumStateHoldMs: Math.max(...holds),
    elapsedMs: Number((performance.now() - started).toFixed(3)), shadowRemoved: report.removed.length,
    liveLocksAcquired: 0, liveWrites: 0 }, null, 2));
} finally {
  if (previousCache === undefined) delete process.env.A4S_CACHE_HOME; else process.env.A4S_CACHE_HOME = previousCache;
  if (previousOptionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = previousOptionalLocks;
  rmSync(temporary, { recursive: true, force: true });
}
