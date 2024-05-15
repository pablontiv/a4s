import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./type-guard.ts";
import type { StationBinding } from "./station-binding.ts";

import { canonicalJson } from "./runtime.cjs";
/** Observations may be appended; all original admission fields remain bound. */
export function receiptBindingDigest(receipt: unknown): string {
  if (!isRecord(receipt)) throw new Error("Recovery requires an admitted run receipt");
  const { runReceipt, ...original } = receipt;
  if (!isRecord(runReceipt)) throw new Error("Recovery requires an admitted run receipt");
  return createHash("sha256").update(canonicalJson({ ...original, runReceipt: { dag: runReceipt.dag, run: runReceipt.run } })).digest("hex");
}
export interface RecoveryEvidence { schemaVersion: 1; receiptDigest: string; verifiedAt: string; station: StationBinding }
export function recoveryEvidencePath(receiptPath: string): string { return join(dirname(receiptPath), "station-recovery.json"); }
export function readRecoveryEvidence(path: string, receipt: unknown): RecoveryEvidence | undefined {
  const file = recoveryEvidencePath(path);
  if (!existsSync(file)) return undefined;
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(value) || value.schemaVersion !== 1 || value.receiptDigest !== receiptBindingDigest(receipt) || typeof value.verifiedAt !== "string" || !isRecord(value.station)) throw new Error("Station recovery evidence differs from the original receipt/snapshot/artifact; restore its matching retained evidence, never rewrite the receipt");
  return value as unknown as RecoveryEvidence;
}
