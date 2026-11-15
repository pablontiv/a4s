import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export function runBash(script: string, options: SpawnSyncOptionsWithStringEncoding) {
  // NixOS system startup files can replace PATH and bypass fixture executables.
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], options);
}
