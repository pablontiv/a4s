#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { handoff, restoreArtifact } from "./select.ts";
import { initializeStation, rollback } from "./station.ts";
import { parseArtifact } from "./release.ts";
import { readStationState } from "./station-state.ts";
import { LAUNCHER_PROTOCOL, STATE_SCHEMAS } from "./contracts.ts";

declare const A4S_COMPILED: boolean;
/** Operator-installed program, compiled independently of payload identity. */
export async function main(args: string[]): Promise<void> {
  const home = process.env.DAGU_HOME || join(homedir(), ".dagu");
  if (args[0] === "launcher-version" && args.length === 1) {
    console.log(JSON.stringify({ launcherProtocol: LAUNCHER_PROTOCOL, stateSchemas: STATE_SCHEMAS }));
    return;
  }
  if (args[0] === "state" || args[0] === "rollback") {
    if (args.length !== 1) throw new Error(`Usage: a4s ${args[0]}`);
    console.log(JSON.stringify(await (args[0] === "state" ? readStationState(home) : rollback(home))));
    return;
  }
  if (args[0] === "station" && args[1] === "init") {
    if (args.length !== 4 || args[2] !== "--artifact") throw new Error("Usage: a4s station init --artifact <tuple>");
    const tuple = parseArtifact(args[3]);
    await restoreArtifact(home, tuple);
    console.log(JSON.stringify(await initializeStation(home, tuple)));
    return;
  }
  await handoff(home, args);
}
if ((typeof A4S_COMPILED !== "undefined" && A4S_COMPILED) || process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
