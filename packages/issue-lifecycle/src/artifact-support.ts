import { isDeepStrictEqual } from "node:util";
import { ARTIFACT_SUPPORT, ARTIFACT_PROTOCOLS, DISPATCH_PROTOCOL, type ArtifactSupport, type SharedFormat } from "./identity.ts";
import { isRecord } from "./type-guard.ts";
import { registrationHash } from "./registration.ts";

export const SHARED_FORMATS = Object.keys(ARTIFACT_SUPPORT) as SharedFormat[];
/** Historical semver declarations are decoded, never rewritten in archives or receipts. */
export function formatSupport(value: unknown): ArtifactSupport {
  if (!isRecord(value)) throw new Error("Missing artifact format support");
  const legacy = "receiptSchemas" in value;
  if (!legacy && !isDeepStrictEqual(Object.keys(value).sort(), [...SHARED_FORMATS].sort())) throw new Error("Invalid artifact format support keys");
  const formats = legacy ? {
    receipt: value.receiptSchemas,
    config: { read: value.configSchemas, write: 1 },
    roleJobStore: { read: value.roleJobStores, write: 1 },
    roleJobPayload: { read: [1], write: 1 },
    runState: { read: [1], write: 1 },
    prCheckpoint: { read: [1], write: 1 },
  } : value;
  for (const name of SHARED_FORMATS) {
    const format = formats[name];
    if (!isRecord(format) || !Array.isArray(format.read) || !format.read.length ||
        format.read.some(version => !Number.isSafeInteger(version) || version < 1) ||
        new Set(format.read).size !== format.read.length || !Number.isSafeInteger(format.write) ||
        !format.read.includes(format.write)) throw new Error(`Invalid artifact format support: ${name}`);
  }
  return formats as unknown as ArtifactSupport;
}
export function assertProtocols(value: unknown): void {
  if (!isRecord(value) || value.dispatch !== DISPATCH_PROTOCOL) {
    const observed = isRecord(value) ? value.dispatch : undefined;
    throw new Error(`Unsupported artifact dispatch boundary: required ${DISPATCH_PROTOCOL}, received ${observed ?? "missing"}`);
  }
  if (!isDeepStrictEqual(value.protocols, ARTIFACT_PROTOCOLS)) throw new Error("Unsupported artifact protocols: required exact declared contracts");
}
/** Read coverage includes every persisted writer and the candidate's own writer. */
export function assertReadCoverage(reader: ArtifactSupport, formats: Partial<Record<SharedFormat, readonly number[]>>, candidate = reader): void {
  for (const name of SHARED_FORMATS) for (const version of [...(formats[name] ?? []), candidate[name].write]) {
    if (!reader[name].read.includes(version)) throw new Error(`Unsupported artifact format ${name}/${version}`);
  }
}
export function assertIdentityContracts(value: Record<string, unknown>, historical: boolean): void {
  formatSupport(value.support);
  const legacy = isRecord(value.support) && "receiptSchemas" in value.support;
  if (legacy && !historical) throw new Error("Build identities require uniform format support");
  assertProtocols(legacy ? value.support : value);
  if (!legacy) {
    if (!Number.isSafeInteger(value.requiredLauncherProtocol) || (value.requiredLauncherProtocol as number) < 1) throw new Error("Invalid required launcher protocol");
    const manifest = value.registrationManifest;
    if (!isRecord(manifest) || manifest.schema !== 1 || !Number.isSafeInteger(manifest.loaderHelperApi) || (manifest.loaderHelperApi as number) < 1 ||
        !Array.isArray(manifest.commands) || !Array.isArray(manifest.tools) || !Array.isArray(manifest.extensions) ||
        value.registrationManifestHash !== registrationHash(manifest)) throw new Error("Invalid artifact registration manifest");
  }
}
