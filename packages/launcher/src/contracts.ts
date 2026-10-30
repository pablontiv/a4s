import { createHash } from "node:crypto";

/** Launcher-owned wire formats, not the running payload's identity. */
export const RELEASE_REPOSITORY = "pablontiv/a4s";
export const LAUNCHER_PROTOCOL = 1;
export const STATE_SCHEMAS: readonly number[] = [1];
export const SHARED_FORMATS = ["receipt", "roleJobStore", "roleJobPayload", "config", "runState", "prCheckpoint"] as const;
export type SharedFormat = typeof SHARED_FORMATS[number];
export interface FormatSupport { readonly read: readonly number[]; readonly write: number }
export type ArtifactSupport = Record<SharedFormat, FormatSupport>;
export const ARTIFACT_PROTOCOLS = { triage: "role-job/1", implement: "role-job/1", publication: "pr-checkpoint/1" } as const;
export const DISPATCH_PROTOCOL = "a4s-run/1";
export interface ArtifactIdentity {
  version: string; commit: string; support: ArtifactSupport; requiredLauncherProtocol: number;
  dispatch: string; protocols: Record<string, string>;
  registrationManifest: { schema: number; loaderHelperApi: number; extensions: readonly string[]; commands: readonly unknown[]; tools: readonly unknown[] };
  registrationManifestHash: string;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function registrationHash(manifest: unknown): string { return createHash("sha256").update(canonicalJson(manifest)).digest("hex"); }
