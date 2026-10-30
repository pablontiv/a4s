import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { leaseProcessStart, probeProcess, type ProcessProbe } from "./process-identity.ts";
import { readJsonFile, readStateLocked, realDirectory, stationRoot, stationTransaction, tupleFromJson, writeJsonDurable, assertLauncher, type StateDependencies } from "./station-state.ts";
import type { ArtifactTuple } from "./release.ts";
import { isRecord } from "./type-guard.ts";
import { inspectArtifact, type CachedArtifact } from "./artifact-cache.ts";

export interface BuildLease {
  schema: 1; id: string; artifact: ArtifactTuple; host: string; pid: number; processStartedAt: string;
  generation: number; kind: "launcher" | "plugin" | "engine"; holder: string;
}
export interface LeaseDependencies extends StateDependencies { probe?: typeof probeProcess }
export interface SelectionDependencies extends StateDependencies { inspect?: (home: string, tuple: ArtifactTuple) => Promise<CachedArtifact> }
export function readLeasesLocked(home: string, dependencies: LeaseDependencies = {}): { live: BuildLease[]; dead: string[] } {
  const directory = join(stationRoot(home), "leases"); realDirectory(directory);
  const live: BuildLease[] = [], dead: string[] = [];
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) throw new Error(`Unrecognized lease file ${name}`);
    const lease = readJsonFile(join(directory, name));
    if (!isRecord(lease) || lease.schema !== 1 || `${lease.id}.json` !== name || typeof lease.host !== "string" ||
        !Number.isSafeInteger(lease.pid) || Number(lease.pid) < 1 || typeof lease.processStartedAt !== "string" || !lease.processStartedAt ||
        !Number.isSafeInteger(lease.generation) || Number(lease.generation) < 0 || !["launcher", "plugin", "engine"].includes(String(lease.kind)) || typeof lease.holder !== "string") throw new Error(`Invalid lease ${name}`);
    tupleFromJson(lease.artifact);
    const result: ProcessProbe = lease.host === hostname() ? (dependencies.probe ?? probeProcess)(Number(lease.pid), lease.processStartedAt) : "unknown";
    if (result === "unknown") throw new Error(`Lease identity unknown: pid=${lease.pid} generation=${lease.generation}; no collection or promotion`);
    if (result === "dead-or-reused") dead.push(join(directory, name));
    else live.push(lease as unknown as BuildLease);
  }
  return { live, dead };
}
export function createLeaseLocked(home: string, artifact: ArtifactTuple, generation: number, kind: BuildLease["kind"], holder: string): BuildLease {
  const processStartedAt = leaseProcessStart(process.pid);
  if (!processStartedAt) throw new Error("Cannot lease build: process identity unknown");
  const lease: BuildLease = { schema: 1, id: randomUUID(), artifact, host: hostname(), pid: process.pid, processStartedAt, generation, kind, holder };
  const directory = join(stationRoot(home), "leases"); realDirectory(directory);
  writeJsonDurable(join(directory, `${lease.id}.json`), lease);
  return lease;
}
/** Selection and lease publication are indivisible relative to promotion and GC.
 * A retiring plugin MUST keep this lease until its OMP process exits. */
export async function selectStationBuild(home: string, kind: BuildLease["kind"], holder: string, dependencies: SelectionDependencies = {}): Promise<BuildLease> {
  return stationTransaction(home, async () => {
    const state = readStateLocked(home);
    const cached = await (dependencies.inspect ?? inspectArtifact)(home, state.current);
    assertLauncher(cached.identity);
    return createLeaseLocked(home, state.current, state.generation, kind, holder);
  }, dependencies);
}
export async function collectDeadLeases(home: string, dependencies: LeaseDependencies = {}): Promise<number> {
  return stationTransaction(home, async () => {
    readStateLocked(home);
    const { dead } = readLeasesLocked(home, dependencies);
    for (const path of dead) rmSync(path);
    return dead.length;
  }, dependencies);
}
