import { isRecord } from "./type-guard.ts";

export function assertReceiptVersion(value: unknown, path: string): asserts value is Record<string, unknown> & { schemaVersion: 1 | 2 } {
  // Legacy receipts remain readable for observation; state-changing paths require an artifact-bound version 2 receipt.
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error(`Unsupported admission receipt schemaVersion=${JSON.stringify(isRecord(value) ? value.schemaVersion : undefined)}: ${path}; supported versions: 1, 2`);
  }
}
