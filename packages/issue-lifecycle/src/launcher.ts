#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { selectStationBuild } from "./lease.ts";
import { rollback } from "./station.ts";
import { artifactToken } from "./release.ts";
import { LAUNCHER_PROTOCOL, STATE_SCHEMAS, stationRoot } from "./station-state.ts";

declare const A4S_COMPILED: boolean;
/** Compiled separately from the payload; rollback never starts current. */
export async function main(args: string[]): Promise<void> {
  const home = process.env.DAGU_HOME || join(homedir(), ".dagu");
  if (args[0] === "version" && args.length === 1) {
    console.log(JSON.stringify({ launcherProtocol: LAUNCHER_PROTOCOL, stateSchemas: STATE_SCHEMAS }));
    return;
  }
  if (args[0] === "rollback") {
    if (args.length !== 1) throw new Error("Usage: a4s-launch rollback");
    console.log(JSON.stringify(await rollback(home)));
    return;
  }
  if (!args.length) throw new Error("Usage: a4s-launch <payload-command> [args...] | rollback | version");
  const lease = await selectStationBuild(home, "launcher", args[0]!);
  const executable = join(stationRoot(home), lease.artifact.version, "a4s");
  if (!process.execve) throw new Error("a4s-launch requires execve support");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  process.execve(executable, [executable, ...args], { ...env, A4S_ARTIFACT: artifactToken(lease.artifact), A4S_BIN: executable });
  throw new Error("a4s-launch did not replace the caller process");
}
if ((typeof A4S_COMPILED !== "undefined" && A4S_COMPILED) || process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
