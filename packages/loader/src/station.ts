import { rmSync } from "node:fs";
import { join } from "node:path";
import { cachePath, inspectArtifact } from "../../launcher/src/artifact-cache.ts";
import { createLeaseLocked } from "../../launcher/src/lease.ts";
import { readJsonFile, readStateLocked, stationRoot, stationTransaction } from "../../launcher/src/station-state.ts";
import { assertIdentityContracts } from "../../launcher/src/artifact-support.ts";
import { sameArtifact } from "../../launcher/src/release.ts";
import type { ArtifactIdentity } from "../../launcher/src/contracts.ts";
import type { StateDependencies, StationState } from "../../launcher/src/station-state.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";

export interface Selection { generation: number; directory: string; identity: ArtifactIdentity; state: StationState }
export interface Lease { release(): void }
export function stationSelection(home: string, dependencies: StateDependencies = {}): Promise<Selection> {
  return stationTransaction(home, async () => {
    const state = readStateLocked(home);
    const directory = cachePath(home, state.current);
    const identity = readJsonFile(join(directory, "identity.json"));
    if (!isRecord(identity) || identity.version !== state.current.version || identity.commit !== state.current.commit) throw new Error("Invalid candidate identity");
    assertIdentityContracts(identity, !state.current.version.startsWith("r"));
    return { generation: state.generation, directory, identity: identity as unknown as ArtifactIdentity, state };
  }, dependencies);
}
export function leaseSelection(home: string, selection: Selection, dependencies: StateDependencies & { inspect?: typeof inspectArtifact } = {}): Promise<Lease> {
  let acquired: Lease | undefined;
  return stationTransaction(home, async () => {
    const state = readStateLocked(home);
    if (state.generation !== selection.generation || !sameArtifact(state.current, selection.state.current)) throw new Error("Station generation changed before lease; retry at idle");
    await (dependencies.inspect ?? inspectArtifact)(home, state.current);
    const lease = createLeaseLocked(home, state.current, state.generation, "plugin", "@a4s/loader");
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
