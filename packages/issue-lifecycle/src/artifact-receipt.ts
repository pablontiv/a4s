import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../launcher/src/type-guard.ts";
import { identity, type ArtifactIdentity } from "./identity.ts";
import { artifactToken, parseArtifact, sameArtifact, type ArtifactTuple } from "../../launcher/src/release.ts";
import { assertReceiptVersion } from "./receipt-version.ts";
import { type CachedArtifact } from "../../launcher/src/artifact-cache.ts";
import { restoreArtifact } from "../../launcher/src/select.ts";
import { formatSupport, assertProtocols } from "../../launcher/src/artifact-support.ts";
import { SHARED_FORMATS } from "../../launcher/src/contracts.ts";

export interface UsedContracts { dispatch: string; config: number; receipt: number; roleJobStore: number; roleJobPayload?: number; runState?: number; prCheckpoint?: number; protocols: typeof identity.protocols }
export const USED_CONTRACTS: UsedContracts = { dispatch: identity.dispatch, config: identity.support.config.write, receipt: identity.support.receipt.write, roleJobStore: identity.support.roleJobStore.write, roleJobPayload: identity.support.roleJobPayload.write, runState: identity.support.runState.write, prCheckpoint: identity.support.prCheckpoint.write, protocols: identity.protocols };
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
  assertProtocols(used);
  const legacy = "receiptSchemas" in support;
  if (legacy) assertProtocols(support);
  const declared = formatSupport(support);
  for (const name of SHARED_FORMATS) {
    const version = used[name] ?? (legacy && ["roleJobPayload", "runState", "prCheckpoint"].includes(name) ? 1 : undefined);
    if (typeof version !== "number" || !identity.support[name].read.some(supported => supported === version) || !declared[name].read.includes(version) || declared[name].write !== version) throw new Error(`Unsupported receipt ${name} contract: ${path}`);
  }
  if (!isRecord(value.sourceVersion) || value.sourceVersion.version !== artifact.version || value.sourceVersion.commit !== artifact.commit) throw new Error(`Receipt artifact/source identity mismatch: ${path}`);
  const initial = value.initial;
  const config = isRecord(initial) && isRecord(initial.deployment) ? initial.deployment.config : undefined;
  if (!isRecord(config) || !identity.support.config.read.some(version => version === config.schemaVersion) || typeof config.commit !== "string" || !/^[a-f0-9]{40}$/.test(config.commit) || typeof config.digest !== "string" || !/^[a-f0-9]{64}$/.test(config.digest)) throw new Error(`Receipt lacks committed config identity: ${path}`);
}
export function assertExecutingArtifact(tuple: ArtifactTuple): void {
  if (identity.version !== tuple.version || identity.commit !== tuple.commit) throw new Error(`Handoff identity mismatch: requested ${artifactToken(tuple)}, executable ${identity.version}@${identity.commit}`);
}
export async function receiptArtifact(home: string, path: string, inspect = restoreArtifact): Promise<{ receipt: Record<string, unknown> & ArtifactReceiptFields; cached: CachedArtifact }> {
  const receipt: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertArtifactReceipt(receipt, path);
  const cached = await inspect(home, receipt.artifact);
  if (!sameArtifact(cached.record, receipt.artifact) || !isDeepStrictEqual(cached.identity.support, receipt.artifactSupport)) throw new Error(`Receipt/cache declaration mismatch: ${path}`);
  return { receipt, cached };
}
