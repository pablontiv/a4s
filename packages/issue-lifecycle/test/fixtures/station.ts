import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { artifactDependencies, artifactEntries, writeInProcessArchive } from "./compiled-artifact.ts";
import { ensureArtifact, inspectArtifact } from "../../src/artifact-cache.ts";
import { identity, type ArtifactSupport } from "../../src/identity.ts";
import { type ArtifactTuple, type ResolvedRelease } from "../../src/release.ts";
import { type StationDependencies } from "../../src/station.ts";
import { stationRoot, writeJsonDurable, type StationState } from "../../src/station-state.ts";

export function stationFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "a4s-station-")), home = join(root, "dagu"), releases = join(root, "releases");
  const artifacts = artifactDependencies(releases);
  const calls: string[] = [];
  const dependencies: StationDependencies = {
    async withFileLock(path, body) { calls.push(path); return artifacts.withFileLock!(path, body); },
    inspect: (home, tuple) => inspectArtifact(home, tuple, artifacts),
    ensure: (home, tuple) => ensureArtifact(home, tuple, artifacts),
    inventory: async () => ({ formats: {}, references: [], expiredBindings: [] }),
    releases: async () => [],
    probe: () => "alive",
  };
  const probe = t.mock.method(childProcess, "execFileSync", () => "Thu Oct 29 05:49:57 2026\n");
  syncBuiltinESMExports();
  t.after(() => { probe.mock.restore(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });
  async function release(version: string, support: ArtifactSupport = structuredClone(identity.support), launcher = 1): Promise<ResolvedRelease> {
    const commit = Number(version.slice(1)).toString(16).padStart(40, "0");
    const entries = artifactEntries(version, commit);
    const declared = JSON.stringify({ ...identity, version, commit, support, requiredLauncherProtocol: launcher });
    for (const entry of entries) if (entry.name === "a4s" || entry.name === "identity.json") entry.content = declared;
    const tuple = writeInProcessArchive(releases, entries, version, commit);
    await ensureArtifact(home, tuple, artifacts);
    return tuple;
  }
  return { root, home, releases, dependencies, calls, release,
    state(): StationState { return JSON.parse(readFileSync(join(stationRoot(home), "state.json"), "utf8")); },
    stateBytes(): string { return readFileSync(join(stationRoot(home), "state.json"), "utf8"); },
    setState(state: StationState): void { writeJsonDurable(join(stationRoot(home), "state.json"), state); },
    breakPayload(tuple: ArtifactTuple): void { writeFileSync(join(stationRoot(home), tuple.version, "a4s"), "broken"); },
  };
}
export function configSupport(read: number[], write: number): ArtifactSupport {
  return { ...structuredClone(identity.support), config: { read, write } };
}
