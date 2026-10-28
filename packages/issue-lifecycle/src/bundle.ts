import { readPackageManifest } from "./executable.ts";

export type Compatibility = "ok" | "stale" | "incompatible" | "unstamped";

export const LIFECYCLE_PROTOCOLS = {
  triage: "role-job/1",
  implement: "role-job/1",
  publication: "pr-checkpoint/1",
} as const;

export type LifecycleCheckpoint = keyof typeof LIFECYCLE_PROTOCOLS;
export type LifecycleProtocols = Record<LifecycleCheckpoint, string>;

const manifest = readPackageManifest();

export const BUNDLE_NAME = manifest.name;
export const BUNDLE_VERSION = manifest.version;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CHECKPOINTS = Object.keys(LIFECYCLE_PROTOCOLS) as LifecycleCheckpoint[];

export function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Notice-only version distance for observation. Never authorizes execution. */
export function classifyCompatibility(
  bundleVersion: string | undefined,
  extensionVersion = BUNDLE_VERSION,
): Compatibility {
  if (bundleVersion === undefined || bundleVersion === "") return "unstamped";
  const bundle = parseVersion(bundleVersion);
  const extension = parseVersion(extensionVersion);
  if (!bundle || !extension || bundle[0] !== extension[0]) return "incompatible";
  if (bundle[1] !== extension[1]) return "incompatible";
  return "ok";
}

export function bundleVersionFromLabels(labels: readonly string[] | undefined): string | undefined {
  const prefix = "dagu-feature-bundle=";
  const label = labels?.find(candidate => candidate.startsWith(prefix));
  return label?.slice(prefix.length) || undefined;
}

export function lifecycleProtocolToken(protocols: LifecycleProtocols = LIFECYCLE_PROTOCOLS): string {
  return CHECKPOINTS.map(checkpoint => `${checkpoint}=${protocols[checkpoint]}`).join(",");
}

