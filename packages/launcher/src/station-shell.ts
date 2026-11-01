import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertReceiptStation, executableOnPath } from "./station-binding.ts";
import { readRecoveryEvidence } from "./station-recovery-evidence.ts";
import { readServiceEnvironment } from "./service-environment.ts";
import { receiptTuple, restoreArtifact, runReceiptPath } from "./select.ts";
import { artifactToken, parseArtifact, sameArtifact } from "./release.ts";
import { createLeaseLocked, prepareLease } from "./lease.ts";
import { assertLauncher, stationRoot, stationTransaction } from "./station-state.ts";
import { assertCachedArtifactPresent } from "./artifact-cache.ts";
import { isRecord } from "./type-guard.ts";
import { isDeepStrictEqual } from "node:util";

/** Dagu invokes this shell for new snapshots. Paths are resolved at execution,
 * but the run's artifact and station tool bytes remain pinned. */
export async function stationShell(args: string[]): Promise<void> {
  const service = readServiceEnvironment();
  let tuple = parseArtifact(process.env.A4S_ARTIFACT);
  let receiptSupport: unknown;
  if (process.env.PRIMARY && process.env.RUN) {
    const path = runReceiptPath(process.env.PRIMARY, process.env.RUN);
    const receipt: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(receipt) || !isRecord(receipt.initial) || !isRecord(receipt.initial.runtimeAndModels) || !isRecord(receipt.initial.execution) || receipt.initial.execution.primary !== process.env.PRIMARY || !isRecord(receipt.runReceipt) || receipt.runReceipt.run !== process.env.RUN) throw new Error("Station shell receipt location/owner binding mismatch");
    if (!isRecord(receipt.initial.runtimeAndModels.station) || receipt.initial.runtimeAndModels.station.schemaVersion !== 1) throw new Error("Station shell requires an identity-bound receipt; literal PATH receipts use station-recovery");
    receiptSupport = receipt.artifactSupport;
    const admitted = receiptTuple(path);
    if (!sameArtifact(tuple, admitted)) throw new Error("Station shell artifact differs from admitted run");
    tuple = admitted;
    assertReceiptStation(receipt.initial.runtimeAndModels.station, readRecoveryEvidence(path, receipt)?.station);
  }
  const cached = await restoreArtifact(service.DAGU_HOME, tuple);
  assertLauncher(cached.identity);
  if (receiptSupport !== undefined && !isDeepStrictEqual(receiptSupport, cached.identity.support)) throw new Error("Station shell cached artifact support differs from the admitted receipt");
  const prepared = prepareLease(tuple, 0, "launcher", "station-shell");
  const lease = await stationTransaction(service.DAGU_HOME, async () => {
    assertCachedArtifactPresent(service.DAGU_HOME, cached);
    return createLeaseLocked(service.DAGU_HOME, prepared);
  });
  try {
    const result = spawnSync(executableOnPath("bash", service.PATH), args, { stdio: "inherit", env: { ...process.env, ...service, A4S_BIN: cached.executable, A4S_ARTIFACT: artifactToken(tuple) } });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { rmSync(join(stationRoot(service.DAGU_HOME), "leases", `${lease.id}.json`), { force: true }); }
}
