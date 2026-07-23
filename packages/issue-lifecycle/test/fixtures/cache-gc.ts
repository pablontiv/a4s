import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { initializeStation, type StationDependencies } from "../../../launcher/src/station.ts";
import { stationRoot, writeJsonDurable } from "../../../launcher/src/station-state.ts";
import type { ArtifactTuple } from "../../../launcher/src/release.ts";
import { stationFixture } from "./station.ts";

export const GC_NOW = Date.parse("2026-10-30T12:00:00Z");
export const DAY = 86400000;
export async function gcFixture(t: TestContext) {
  const f = stationFixture(t), builds = [];
  for (let id = 1; id <= 14; id++) builds.push(await f.release(`r${id}`));
  await initializeStation(f.home, builds[13]!, f.dependencies);
  f.setState({ ...f.state(), previous: builds[12]! });
  const primary = join(f.root, "repo"), directory = join(primary, ".git", "dagu-feature");
  mkdirSync(directory, { recursive: true });
  const { inventory: _, ...base } = f.dependencies;
  const dependencies: StationDependencies = { ...base, primaries: () => [primary], gitPath: () => directory,
    configVersion: () => 2, listRuns: async () => [], now: () => GC_NOW };
  function receipt(run: string, artifact: ArtifactTuple, age = 30, dag = "feature", incident = false): string {
    const path = join(directory, "runs", run, "receipt.json");
    mkdirSync(dirname(path), { recursive: true });
    writeJsonDurable(path, { schemaVersion: 2, artifact, receiptCreatedAt: new Date(GC_NOW - age * DAY).toISOString(),
      initial: { admittedAt: new Date(GC_NOW - age * DAY).toISOString() },
      runReceipt: { dag, run, observations: incident ? [{ kind: "incident" }] : [] } });
    return path;
  }
  function binding(run: string, artifact: ArtifactTuple): string {
    const path = join(stationRoot(f.home), "ticks", `${run}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ dagRunId: run, tuple: artifact, createdAt: new Date(GC_NOW - 30 * DAY).toISOString() }));
    return path;
  }
  return { ...f, builds, primary, directory, dependencies, receipt, binding };
}
