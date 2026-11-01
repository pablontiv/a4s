import { rmSync } from "node:fs";
import { join } from "node:path";
import { cachePath, inspectArtifact, assertCachedArtifactPresent } from "../../launcher/src/artifact-cache.ts";
import { createLeaseLocked, prepareLease } from "../../launcher/src/lease.ts";
import { readJsonFile, readStateLocked, readStationState, stationRoot, stationTransaction } from "../../launcher/src/station-state.ts";
import { assertIdentityContracts } from "../../launcher/src/artifact-support.ts";
import { sameArtifact } from "../../launcher/src/release.ts";
import type { ArtifactIdentity } from "../../launcher/src/contracts.ts";
import type { StateDependencies, StationState } from "../../launcher/src/station-state.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";

export interface Selection { generation: number; directory: string; identity: ArtifactIdentity; state: StationState }
export interface Lease { release(): void }
export async function stationSelection(home: string): Promise<Selection> {
  // Every idle poll reads an atomic state envelope, never an exclusive lock.
  // Activation below rechecks generation and cache presence before publishing a lease.
  const state = await readStationState(home);
  const directory = cachePath(home, state.current);
  const identity = readJsonFile(join(directory, "identity.json"));
  if (!isRecord(identity) || identity.version !== state.current.version || identity.commit !== state.current.commit) throw new Error("Invalid candidate identity");
  assertIdentityContracts(identity, !state.current.version.startsWith("r"));
  return { generation: state.generation, directory, identity: identity as unknown as ArtifactIdentity, state };
}
export async function leaseSelection(home: string, selection: Selection, dependencies: StateDependencies & { inspect?: typeof inspectArtifact } = {}): Promise<Lease> {
  let acquired: Lease | undefined;
  const checkGeneration = () => {
    const state = readStateLocked(home, dependencies);
    if (state.generation !== selection.generation || !sameArtifact(state.current, selection.state.current)) throw new Error("Station generation changed before lease; retry at idle");
    return state;
  };
  const state = await readStationState(home);
  if (state.generation !== selection.generation || !sameArtifact(state.current, selection.state.current)) throw new Error("Station generation changed before lease; retry at idle");
  const cached = await (dependencies.inspect ?? inspectArtifact)(home, selection.state.current);
  if (!sameArtifact(cached.record, selection.state.current)) throw new Error("Loader verification returned a different tuple");
  const prepared = prepareLease(selection.state.current, selection.generation, "plugin", "@a4s/loader");
  return stationTransaction(home, async () => {
    checkGeneration();
    assertCachedArtifactPresent(home, cached);
    const lease = createLeaseLocked(home, prepared);
    let released = false;
    const release = () => {
      if (released) return;
      rmSync(join(stationRoot(home), "leases", `${lease.id}.json`), { force: true });
      released = true;
      process.off("exit", release);
    };
    process.once("exit", release);
    acquired = { release };
    return acquired;
  }, dependencies).catch(error => {
    // The station transaction may fail while restoring its lock after leasing.
    // No import has started yet, so this lease must not survive that failure.
    acquired?.release();
    throw error;
  });
}
