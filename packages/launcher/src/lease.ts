import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { leaseProcessStart, probeProcess, type ProcessProbe } from "./process-identity.ts";
import { readJsonFile, readStateLocked, readStationState, realDirectory, stationRoot, stationTransaction, tupleFromJson, writeJsonDurable, assertLauncher, type StateDependencies } from "./station-state.ts";
import { sameArtifact, type ArtifactTuple } from "./release.ts";
import { isRecord } from "./type-guard.ts";
import { inspectArtifact, assertCachedArtifactPresent, type CachedArtifact } from "./artifact-cache.ts";

export interface BuildLease {
  schema: 1; id: string; artifact: ArtifactTuple; host: string; pid: number; processStartedAt: string;
  generation: number; kind: "launcher" | "plugin" | "engine"; holder: string;
}
export interface LeaseDependencies extends StateDependencies { probe?: typeof probeProcess }
export interface SelectionDependencies extends StateDependencies { inspect?: (home: string, tuple: ArtifactTuple) => Promise<CachedArtifact> }
export interface LeaseInventory { live: BuildLease[]; dead: BuildLease[] }
/** Small immutable records can be re-read under .state.lock without process probes. */
function readLeaseRecords(home: string): BuildLease[] {
  const directory = join(stationRoot(home), "leases"), records: BuildLease[] = [];
  let names: string[];
  try {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error(`Station runtime directory must not contain symlinks: ${directory}`);
    names = readdirSync(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return records; throw error; }
  for (const name of names) {
    // A concurrent lease publication fsyncs its temporary file before rename.
    if (/^[a-f0-9-]+\.json\.[a-f0-9-]+\.tmp$/.test(name)) continue;
    if (!/^[a-f0-9-]+\.json$/.test(name)) throw new Error(`Unrecognized lease file ${name}`);
    let lease: unknown;
    try { lease = readJsonFile(join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!isRecord(lease) || lease.schema !== 1 || `${lease.id}.json` !== name || typeof lease.host !== "string" ||
        !Number.isSafeInteger(lease.pid) || Number(lease.pid) < 1 || typeof lease.processStartedAt !== "string" || !lease.processStartedAt ||
        !Number.isSafeInteger(lease.generation) || Number(lease.generation) < 0 || !["launcher", "plugin", "engine"].includes(String(lease.kind)) || typeof lease.holder !== "string") throw new Error(`Invalid lease ${name}`);
    tupleFromJson(lease.artifact);
    records.push(lease as unknown as BuildLease);
  }
  return records;
}
/** Process probes may spawn on non-Linux hosts; call only outside .state.lock. */
export function readLeases(home: string, dependencies: LeaseDependencies = {}): LeaseInventory {
  const live: BuildLease[] = [], dead: BuildLease[] = [];
  for (const lease of readLeaseRecords(home)) {
    const result: ProcessProbe = (dependencies.probe ?? probeProcess)(lease.pid, lease.processStartedAt);
    if (result === "unknown") throw new Error(`Lease identity unknown: pid=${lease.pid} generation=${lease.generation}; no collection or promotion`);
    (result === "dead-or-reused" ? dead : live).push(lease);
  }
  return { live, dead };
}
/** New or changed records are possible readers. Only an unchanged, already
 * verified dead record may be excluded or removed; unrelated churn is harmless. */
export function recheckLeases(home: string, prepared: LeaseInventory): LeaseInventory {
  const knownDead = new Map(prepared.dead.map(lease => [lease.id, lease]));
  const live: BuildLease[] = [], dead: BuildLease[] = [];
  for (const lease of readLeaseRecords(home)) {
    (isDeepStrictEqual(lease, knownDead.get(lease.id)) ? dead : live).push(lease);
  }
  return { live, dead };
}
/** Process identity may execute ps on non-Linux hosts; prepare before taking .state.lock. */
export function prepareLease(artifact: ArtifactTuple, generation: number, kind: BuildLease["kind"], holder: string): BuildLease {
  const processStartedAt = leaseProcessStart(process.pid);
  if (!processStartedAt) throw new Error("Cannot lease build: process identity unknown");
  return { schema: 1, id: randomUUID(), artifact, host: hostname(), pid: process.pid, processStartedAt, generation, kind, holder };
}
export function createLeaseLocked(home: string, lease: BuildLease): BuildLease {
  const directory = join(stationRoot(home), "leases"); realDirectory(directory);
  writeJsonDurable(join(directory, `${lease.id}.json`), lease);
  return lease;
}
/** Verification is optimistic; generation/cache checks and lease publication are
 * indivisible relative to promotion and GC. Retired plugin leases survive. */
export async function selectStationBuild(home: string, kind: BuildLease["kind"], holder: string, dependencies: SelectionDependencies = {}): Promise<BuildLease> {
  const snapshot = await readStationState(home);
  const cached = await (dependencies.inspect ?? inspectArtifact)(home, snapshot.current);
  assertLauncher(cached.identity);
  if (!sameArtifact(cached.record, snapshot.current)) throw new Error("Lease verification returned a different tuple");
  const lease = prepareLease(snapshot.current, snapshot.generation, kind, holder);
  return stationTransaction(home, async () => {
    const state = readStateLocked(home, dependencies);
    if (!isDeepStrictEqual(state, snapshot)) throw new Error("Station changed during lease preparation; retry");
    assertCachedArtifactPresent(home, cached);
    return createLeaseLocked(home, lease);
  }, dependencies);
}
export async function collectDeadLeases(home: string, dependencies: LeaseDependencies = {}): Promise<number> {
  const prepared = readLeases(home, dependencies);
  return stationTransaction(home, async () => {
    readStateLocked(home, dependencies);
    const { dead } = recheckLeases(home, prepared);
    for (const lease of dead) rmSync(join(stationRoot(home), "leases", `${lease.id}.json`), { force: true });
    return dead.length;
  }, dependencies);
}
