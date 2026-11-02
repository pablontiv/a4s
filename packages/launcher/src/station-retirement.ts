import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { receiptTuple, runReceiptPath } from "./select.ts";
import { isRecord } from "./type-guard.ts";

export const retirementStatuses = ["failed", "succeeded", "aborted"] as const;
export interface RetirementEvidence {
  schemaVersion: 1;
  outcome: "retired";
  primary: string;
  dag: string;
  run: string;
  receiptDigest: string;
  reason: string;
  nativeStatus: typeof retirementStatuses[number];
  observedAt: string;
  retiredAt: string;
}
export function retirementEvidencePath(receiptPath: string): string { return join(dirname(receiptPath), "station-retirement.json"); }

/** Retirement verifies the admitted identity, not today's executable/toolchain. */
export interface RetirementReceipt {
  primary: string;
  run: string;
  dag: string;
  path: string;
  receiptDigest: string;
  snapshot: string;
  station: unknown;
}
export function retirementReceipt(primary: string, run: string): RetirementReceipt {
  primary = realpathSync(primary);
  return receiptAt(primary, run, runReceiptPath(primary, run));
}
function receiptAt(primary: string, run: string, path: string): RetirementReceipt {
  if (!lstatSync(path).isFile()) throw new Error("Station retirement receipt must be a regular file");
  const bytes = readFileSync(path);
  const receipt: unknown = JSON.parse(bytes.toString("utf8"));
  receiptTuple(path, receipt);
  if (!isRecord(receipt) || !isRecord(receipt.initial) || !isRecord(receipt.initial.execution) ||
      !isRecord(receipt.initial.runtimeAndModels) || !isRecord(receipt.runReceipt) ||
      receipt.initial.execution.primary !== primary || receipt.runReceipt.run !== run ||
      typeof receipt.runReceipt.dag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(receipt.runReceipt.dag) ||
      typeof receipt.initial.execution.dagSnapshot !== "string" || !receipt.initial.execution.dagSnapshot.trim()) {
    throw new Error("Station retirement receipt/primary/DAG/run binding is invalid; restore the matching original receipt, never rewrite it");
  }
  return { primary, run, dag: receipt.runReceipt.dag, path,
    receiptDigest: createHash("sha256").update(bytes).digest("hex"),
    snapshot: receipt.initial.execution.dagSnapshot, station: receipt.initial.runtimeAndModels.station };
}

function evidenceExists(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Station retirement evidence must be a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function readRetirementEvidence(context: RetirementReceipt): RetirementEvidence | undefined {
  const path = retirementEvidencePath(context.path);
  if (!evidenceExists(path)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Station retirement evidence is unreadable or malformed; preserve it and restore matching audited evidence"); }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.outcome !== "retired" ||
      value.primary !== context.primary || value.dag !== context.dag || value.run !== context.run ||
      value.receiptDigest !== context.receiptDigest || typeof value.reason !== "string" || !value.reason.trim() ||
      !retirementStatuses.some(status => status === value.nativeStatus) || !timestamp(value.observedAt) || !timestamp(value.retiredAt)) {
    throw new Error("Station retirement evidence binding is invalid or differs from the receipt bytes/primary/DAG/run; preserve it and restore matching audited evidence");
  }
  return value as unknown as RetirementEvidence;
}

/** Absence reads no receipt, cache or station tools. Present evidence fails closed. */
export function readRunRetirement(primary: string, run: string, dag?: string): RetirementEvidence | undefined {
  primary = realpathSync(primary);
  const path = runReceiptPath(primary, run);
  if (!evidenceExists(retirementEvidencePath(path))) return undefined;
  const context = receiptAt(primary, run, path);
  if (dag !== undefined && context.dag !== dag) throw new Error("Station retirement evidence DAG differs from the selected native run");
  return readRetirementEvidence(context);
}
