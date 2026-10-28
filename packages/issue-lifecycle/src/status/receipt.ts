import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadedExtensionDigest, receiptPath } from "../admission.ts";
import { assertArtifactReceipt } from "../artifact-receipt.ts";
import { invokeRun } from "../run-artifact.ts";
import type { RunDetails } from "./progress.ts";

/** Display compatibility is advisory; mutations always reverify the whole cache. */
export function receiptCompatibility(primary: string, run: RunDetails): string | undefined {
  try {
    const path = receiptPath(primary, run.dagRunId);
    const receipt: unknown = JSON.parse(readFileSync(path, "utf8"));
    assertArtifactReceipt(receipt, path);
    if (!existsSync(join(process.env.DAGU_HOME || join(homedir(), ".dagu"), "cache", "a4s", receipt.artifact.version, "artifact.json"))) throw new Error(`Cached artifact ${receipt.artifact.version} unavailable`);
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}
export async function recordRunObservation(run: RunDetails, primary: string, kind = "runtime", error?: string): Promise<void> {
  const result = await invokeRun(primary, run.dagRunId, ["observe", "runtime", JSON.stringify({ run, kind, error,
    observer: { observerPid: process.pid, observerPpid: process.ppid, loadedExtensionDigest } })], { capture: true });
  if (result.status !== 0) throw new Error(`Run receipt observation rejected: run=${run.dagRunId} status=${result.status}: ${result.stderr.trim()}`);
}
