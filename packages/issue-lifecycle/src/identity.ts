import { readPackageManifest } from "./executable.ts";

declare const A4S_BUILD_VERSION: string;
declare const A4S_BUILD_COMMIT: string;

export const ARTIFACT_SUPPORT = {
  dispatch: "a4s-run/1",
  configSchemas: [1],
  receiptSchemas: { read: [1, 2], write: 2 },
  roleJobStores: [1],
  protocols: { triage: "role-job/1", implement: "role-job/1", publication: "pr-checkpoint/1" },
} as const;

export const identity = {
  version: typeof A4S_BUILD_VERSION === "undefined" ? readPackageManifest().version : A4S_BUILD_VERSION,
  commit: typeof A4S_BUILD_COMMIT === "undefined" ? "unbuilt" : A4S_BUILD_COMMIT,
  support: ARTIFACT_SUPPORT,
} as const;
export type ArtifactIdentity = typeof identity;
