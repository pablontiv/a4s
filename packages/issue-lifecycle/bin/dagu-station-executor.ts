#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveExecutor, runBundle } from "../src/station-executors.ts";

try {
  const home = realpathSync(process.env.DAGU_HOME || "");
  const run = process.env.RUN;
  let identity: { version: string; commit: string };
  if (run) {
    if (!process.env.PRIMARY) throw new Error("RUN requires PRIMARY for receipt-pinned execution");
    identity = runBundle(realpathSync(process.env.PRIMARY), run);
  } else {
    const active: unknown = JSON.parse(readFileSync(join(home, "executors", "active.json"), "utf8"));
    if (!active || typeof active !== "object" || !("version" in active) || !("commit" in active) || typeof active.version !== "string" || typeof active.commit !== "string") throw new Error("Invalid active executor pin");
    identity = { version: active.version, commit: active.commit };
  }
  const pin = resolveExecutor(home, identity);
  if (!pin.entrypointDigest) throw new Error(`Recorded bundle ${pin.version}@${pin.commit} has no role-jobs entrypoint; retained, not substituted with the active bundle`);
  const result = spawnSync("bun", [join(pin.path, "packages", pin.package, "bin", "dagu-role-jobs.ts"), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(`DAGU_EXECUTOR_BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
