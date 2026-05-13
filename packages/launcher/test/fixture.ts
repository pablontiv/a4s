import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { SHARED_FORMATS, ARTIFACT_PROTOCOLS, DISPATCH_PROTOCOL, type ArtifactIdentity, type ArtifactSupport } from "../src/contracts.ts";
import type { CachedArtifact } from "../src/artifact-cache.ts";
import { commitStateLocked, realDirectory, stationRoot, type StationState } from "../src/station-state.ts";
import type { ArtifactTuple } from "../src/release.ts";
import type { SelectionDependencies } from "../src/select.ts";

export function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "a4s-launcher-")), home = join(root, "home"), primary = join(root, "repo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(primary); execFileSync("git", ["-C", primary, "init", "-q"]);
  realDirectory(stationRoot(home));
  const a: ArtifactTuple = { version: "r10", commit: "a".repeat(40), digest: "1".repeat(64) };
  const b: ArtifactTuple = { version: "r11", commit: "b".repeat(40), digest: "2".repeat(64) };
  const format = (write: number) => ({ read: [1, 2], write });
  const support: ArtifactSupport = { receipt: format(2), roleJobStore: format(1), roleJobPayload: format(1), config: format(2), runState: format(1), prCheckpoint: format(1) };
  const identity: ArtifactIdentity = { ...a, support, requiredLauncherProtocol: 1, dispatch: DISPATCH_PROTOCOL, protocols: ARTIFACT_PROTOCOLS,
    registrationManifest: { schema: 1, loaderHelperApi: 1, extensions: [], commands: [], tools: [] }, registrationManifestHash: "0".repeat(64) };
  const restored: string[] = [];
  const dependencies: SelectionDependencies = {
    async withFileLock(_path, body) { return body(); },
    env: { DAG_RUN_ID: "tick-a", DAG_NAME: "reconcile" },
    async confirm() { return "first"; },
    async restore(home, tuple): Promise<CachedArtifact> {
      restored.push(tuple.version);
      return { directory: join(stationRoot(home), tuple.version), executable: join(stationRoot(home), tuple.version, "a4s"), executableDigest: "f".repeat(64), identity: { ...identity, ...tuple }, record: { ...tuple, verifiedAt: new Date().toISOString() } };
    },
  };
  const state: StationState = { schema: 1, current: a, previous: a, generation: 0, rejected: [], formats: Object.fromEntries(SHARED_FORMATS.map(name => [name, [support[name].write]])) as StationState["formats"] };
  function setState(next: StationState) { commitStateLocked(home, next); }
  setState(state);
  function receipt(run: string, tuple = b): string {
    const directory = join(primary, ".git", "dagu-feature", "runs", run); mkdirSync(directory, { recursive: true });
    const path = join(directory, "receipt.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, artifact: tuple, artifactSupport: support, sourceVersion: tuple,
      contracts: { dispatch: DISPATCH_PROTOCOL, protocols: ARTIFACT_PROTOCOLS, ...Object.fromEntries(SHARED_FORMATS.map(name => [name, support[name].write])) } }));
    return path;
  }
  return { root, home, primary, a, b, state, dependencies, restored, setState, receipt };
}
