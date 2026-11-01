import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { leaseProcessStart, probeProcess, type ProcessProbe } from "./process-identity.ts";
import { readJsonFile, readStateLocked, readStationState, realDirectory, stationRoot, stationTransaction, tupleFromJson, writeJsonDurable, assertLauncher, referenceStamp, type StateDependencies } from "./station-state.ts";
import { sameArtifact, type ArtifactTuple } from "./release.ts";
import { isRecord } from "./type-guard.ts";
import { inspectArtifact, assertCachedArtifactPresent, type CachedArtifact } from "./artifact-cache.ts";

export interface BuildLease {
  schema: 1; id: string; artifact: ArtifactTuple; host: string; pid: number; processStartedAt: string;
  generation: number; kind: "launcher" | "plugin" | "engine"; holder: string;
}
export interface LeaseDependencies extends StateDependencies { probe?: typeof probeProcess }
export interface SelectionDependencies extends StateDependencies { inspect?: (home: string, tuple: ArtifactTuple) => Promise<CachedArtifact> }
/** Lease records are immutable. Probe outside .state.lock, then recheck the directory stamp. */
export function readLeases(home: string, dependencies: LeaseDependencies = {}): { live: BuildLease[]; dead: string[] } {
  const directory = join(stationRoot(home), "leases");
  const live: BuildLease[] = [], dead: string[] = [];
  let names: string[];
  try {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error(`Station runtime directory must not contain symlinks: ${directory}`);
    names = readdirSync(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { live, dead }; throw error; }
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
    // The station lease store is local. Hostnames are diagnostic labels, not
    // stable identities: a rename must not override the PID/start (and boot) probe.
    const result: ProcessProbe = (dependencies.probe ?? probeProcess)(Number(lease.pid), lease.processStartedAt);
    if (result === "unknown") throw new Error(`Lease identity unknown: pid=${lease.pid} generation=${lease.generation}; no collection or promotion`);
    if (result === "dead-or-reused") dead.push(join(directory, name));
    else live.push(lease as unknown as BuildLease);
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
  const snapshot = await stationTransaction(home, async () => ({ state: readStateLocked(home, dependencies), stamp: referenceStamp(home) }), dependencies);
  const { dead } = readLeases(home, dependencies);
  return stationTransaction(home, async () => {
    if (!isDeepStrictEqual(readStateLocked(home, dependencies), snapshot.state) || referenceStamp(home) !== snapshot.stamp) throw new Error("Station references changed during lease collection; retry");
    for (const path of dead) rmSync(path, { force: true });
    return dead.length;
  }, dependencies);
}
