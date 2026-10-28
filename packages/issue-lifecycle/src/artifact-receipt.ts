import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./type-guard.ts";
import { identity, type ArtifactIdentity } from "./identity.ts";
import { artifactToken, parseArtifact, sameArtifact, type ArtifactTuple } from "./release.ts";
import { assertReceiptVersion } from "./receipt-version.ts";
import { inspectArtifact, type CachedArtifact } from "./artifact-cache.ts";

export interface UsedContracts { config: 1; receipt: 2; roleJobStore: 1; protocols: ArtifactIdentity["support"]["protocols"] }
export const USED_CONTRACTS: UsedContracts = { config: 1, receipt: 2, roleJobStore: 1, protocols: identity.support.protocols };
export interface ArtifactReceiptFields {
  artifact: ArtifactTuple;
  artifactSupport: ArtifactIdentity["support"];
  contracts: UsedContracts;
  parent?: { receipt: string; dag: string; run: string; artifact: ArtifactTuple };
}
/** Numeric receipt compatibility alone never authorizes a cutover-era action. */
export function assertArtifactReceipt(value: unknown, path: string): asserts value is Record<string, unknown> & ArtifactReceiptFields {
  assertReceiptVersion(value, path);
  if (value.schemaVersion !== 2 || !isRecord(value.artifact) || !isRecord(value.artifactSupport) || !isRecord(value.contracts)) throw new Error(`Receipt lacks required artifact tuple/declarations: ${path}; legacy runs cannot cross the hard cutover`);
  const artifact = parseArtifact(`${value.artifact.version}@${value.artifact.commit}#${value.artifact.digest}`);
  const support = value.artifactSupport;
  const used = value.contracts;
  if (used.config !== 1 || used.receipt !== 2 || used.roleJobStore !== 1 || !isDeepStrictEqual(used.protocols, identity.support.protocols) ||
      !Array.isArray(support.configSchemas) || !support.configSchemas.includes(1) || !isRecord(support.receiptSchemas) || !Array.isArray(support.receiptSchemas.read) || !support.receiptSchemas.read.includes(2) || support.receiptSchemas.write !== 2 || !Array.isArray(support.roleJobStores) || !support.roleJobStores.includes(1) || !isDeepStrictEqual(support.protocols, used.protocols)) throw new Error(`Unsupported receipt config/receipt/protocol/job-store contracts: ${path}`);
  if (!isRecord(value.sourceVersion) || value.sourceVersion.version !== artifact.version || value.sourceVersion.commit !== artifact.commit) throw new Error(`Receipt artifact/source identity mismatch: ${path}`);
  const initial = value.initial;
  const config = isRecord(initial) && isRecord(initial.deployment) ? initial.deployment.config : undefined;
  if (!isRecord(config) || config.schemaVersion !== 1 || typeof config.commit !== "string" || !/^[a-f0-9]{40}$/.test(config.commit) || typeof config.digest !== "string" || !/^[a-f0-9]{64}$/.test(config.digest)) throw new Error(`Receipt lacks committed config identity: ${path}`);
}
export function assertExecutingArtifact(tuple: ArtifactTuple): void {
  if (identity.version !== tuple.version || identity.commit !== tuple.commit) throw new Error(`Handoff identity mismatch: requested ${artifactToken(tuple)}, executable ${identity.version}@${identity.commit}`);
}
export async function receiptArtifact(home: string, path: string): Promise<{ receipt: Record<string, unknown> & ArtifactReceiptFields; cached: CachedArtifact }> {
  const receipt: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertArtifactReceipt(receipt, path);
  const cached = await inspectArtifact(home, receipt.artifact);
  if (!sameArtifact(cached.record, receipt.artifact) || !isDeepStrictEqual(cached.identity.support, receipt.artifactSupport)) throw new Error(`Receipt/cache declaration mismatch: ${path}`);
  return { receipt, cached };
}
