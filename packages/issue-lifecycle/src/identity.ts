import { readPackageManifest } from "./executable.ts";
import { registrationManifest, registrationHash } from "./registration.ts";

declare const A4S_BUILD_VERSION: string;
declare const A4S_BUILD_COMMIT: string;

export interface FormatSupport { readonly read: readonly number[]; readonly write: number }
export const ARTIFACT_SUPPORT = {
  receipt: { read: [1, 2], write: 2 },
  roleJobStore: { read: [1], write: 1 },
  roleJobPayload: { read: [1], write: 1 },
  config: { read: [1], write: 1 },
  runState: { read: [1], write: 1 },
  prCheckpoint: { read: [1], write: 1 },
} as const satisfies Record<string, FormatSupport>;
export type SharedFormat = keyof typeof ARTIFACT_SUPPORT;
export type ArtifactSupport = Record<SharedFormat, FormatSupport>;
export const ARTIFACT_PROTOCOLS = {
  triage: "role-job/1", implement: "role-job/1", publication: "pr-checkpoint/1",
} as const;
export const DISPATCH_PROTOCOL = "a4s-run/1";
export const identity = {
  version: typeof A4S_BUILD_VERSION === "undefined" ? readPackageManifest().version : A4S_BUILD_VERSION,
  commit: typeof A4S_BUILD_COMMIT === "undefined" ? "unbuilt" : A4S_BUILD_COMMIT,
  support: ARTIFACT_SUPPORT,
  dispatch: DISPATCH_PROTOCOL,
  protocols: ARTIFACT_PROTOCOLS,
  registrationManifest,
  registrationManifestHash: registrationHash(registrationManifest),
  requiredLauncherProtocol: 1,
} as const;
export type ArtifactIdentity = Omit<typeof identity, "support" | "requiredLauncherProtocol"> & { support: ArtifactSupport; requiredLauncherProtocol: number };
