import { execFileSync } from "node:child_process";
import { inspectArtifact } from "../../src/artifact-cache.ts";
import { receiptArtifact } from "../../src/artifact-receipt.ts";
import { main } from "../../src/commands/role-jobs.ts";
import { dispatchStage } from "../../src/role-dispatch.ts";
import { inProcessIdentity } from "./compiled-artifact.ts";

export const roleReceiptArtifact: typeof receiptArtifact = (home, path) => receiptArtifact(home, path,
  (directory, tuple) => inspectArtifact(directory, tuple, { executableIdentity: inProcessIdentity }));
export async function runRoleCommand(argv: string[], env = process.env, dependencies = { execFileSync, dispatchStage }) {
  const saved = { ...process.env };
  const result = { status: -1, stdout: "", stderr: "" };
  try {
    for (const key of Object.keys(process.env)) if (env[key] === undefined) delete process.env[key];
    for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
    await main(argv, {
      log: (...values) => { result.stdout += `${values.join(" ")}\n`; },
      error: (...values) => { result.stderr += `${values.join(" ")}\n`; },
      exit: code => { result.status = code; },
    }, dependencies);
    return result;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
