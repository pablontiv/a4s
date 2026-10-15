import { readFileSync } from "node:fs";

export type Compatibility = "ok" | "incompatible" | "unstamped";

export interface BundleStamp {
  version: string;
  source: string;
  bootstrap: string;
  dagu: string;
}

interface PackageManifest {
  name: string;
  version: string;
  daguFeature: { dagu: string };
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

export const BUNDLE_NAME = manifest.name;
export const BUNDLE_VERSION = manifest.version;
export const REQUIRED_DAGU_VERSION = manifest.daguFeature.dagu;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function classifyCompatibility(
  bundleVersion: string | undefined,
  extensionVersion = BUNDLE_VERSION,
): Compatibility {
  if (bundleVersion === undefined || bundleVersion === "") return "unstamped";
  const bundle = parseVersion(bundleVersion);
  const extension = parseVersion(extensionVersion);
  if (!bundle || !extension || bundle[0] !== extension[0]) return "incompatible";
  if (bundle[0] === 0 && bundle[1] !== extension[1]) return "incompatible";
  return "ok";
}

export function bundleVersionFromLabels(labels: readonly string[] | undefined): string | undefined {
  const prefix = "dagu-feature-bundle=";
  const label = labels?.find(candidate => candidate.startsWith(prefix));
  return label?.slice(prefix.length) || undefined;
}

export function parseBundleStamp(contents: string): BundleStamp | undefined {
  const line = contents.split(/\r?\n/, 1)[0];
  if (!line) return undefined;
  const escapedName = BUNDLE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^# dagu-feature-bundle: ${escapedName}@([^\\s]+) source=([^\\s]+) bootstrap=([^\\s]+) dagu=([^\\s]+)$`,
  ).exec(line);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  return { version: match[1], source: match[2], bootstrap: match[3], dagu: match[4] };
}
