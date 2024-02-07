import { ARTIFACT_PROTOCOLS, DISPATCH_PROTOCOL, registrationHash } from "../../launcher/src/contracts.ts";
import { readPackageManifest } from "./executable.ts";
import { registrationManifest } from "./registration.ts";

declare const A4S_BUILD_VERSION: string;
declare const A4S_BUILD_COMMIT: string;

export interface FormatSupport { readonly read: readonly number[]; readonly write: number }
export const ARTIFACT_SUPPORT = {
  receipt: { read: [1, 2], write: 2 },
  roleJobStore: { read: [1], write: 1 },
  roleJobPayload: { read: [1], write: 1 },
  config: { read: [1, 2], write: 2 },
  runState: { read: [1], write: 1 },
  prCheckpoint: { read: [1], write: 1 },
} as const satisfies Record<string, FormatSupport>;
export type SharedFormat = keyof typeof ARTIFACT_SUPPORT;
export type ArtifactSupport = Record<SharedFormat, FormatSupport>;
export const identity = {
  version: typeof A4S_BUILD_VERSION === "undefined" ? readPackageManifest().version : A4S_BUILD_VERSION,
  commit: typeof A4S_BUILD_COMMIT === "undefined" ? "unbuilt" : A4S_BUILD_COMMIT,
  layout: "omp-role-runner/1",
  support: ARTIFACT_SUPPORT,
  dispatch: DISPATCH_PROTOCOL,
  protocols: ARTIFACT_PROTOCOLS,
  registrationManifest,
  registrationManifestHash: registrationHash(registrationManifest),
  requiredLauncherProtocol: 1,
} as const;
export type ArtifactIdentity = Omit<typeof identity, "layout" | "support" | "requiredLauncherProtocol"> & {
  layout?: typeof identity.layout;
  support: ArtifactSupport;
  requiredLauncherProtocol: number;
};
