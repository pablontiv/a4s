import { readFileSync } from "node:fs";

export type Compatibility = "ok" | "stale" | "incompatible" | "unstamped";

export const LIFECYCLE_PROTOCOLS = {
  triage: "role-job/1",
  implement: "role-job/1",
  publication: "pr-checkpoint/1",
} as const;

export type LifecycleCheckpoint = keyof typeof LIFECYCLE_PROTOCOLS;
export type LifecycleProtocols = Record<LifecycleCheckpoint, string>;

/**
 * Checkpoint contracts this extension no longer executes, and the bundle that does.
 * `marker-agent/1` is the retired `TRIAGE_REVIEW AGENT=` verifier.
 * `human-task/1` is the retired coordinator human-task triage completion guard.
 */
export const RETIRED_PROTOCOL_BUNDLES: Readonly<Record<string, string>> = {
  "triage=marker-agent/1": "0.3.102",
  "triage=human-task/1": "0.3.108",
};

export interface BundleStamp {
  version: string;
  source: string;
  bootstrap: string;
  dagu: string;
  protocols?: LifecycleProtocols;
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
const PROTOCOL_ID = /[a-z0-9][a-z0-9./-]*/;
const PROTOCOL_TOKEN = new RegExp(
  `^triage=(${PROTOCOL_ID.source}),implement=(${PROTOCOL_ID.source}),publication=(${PROTOCOL_ID.source})$`,
);
const CHECKPOINTS = Object.keys(LIFECYCLE_PROTOCOLS) as LifecycleCheckpoint[];

export function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Notice-only version distance. Admission uses served checkpoint protocols. */
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

export function parseProtocolToken(token: string): LifecycleProtocols | undefined {
  const match = PROTOCOL_TOKEN.exec(token);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { triage: match[1], implement: match[2], publication: match[3] };
}

export function parseBundleStamp(contents: string): BundleStamp | undefined {
  const line = contents.split(/\r?\n/, 1)[0];
  if (!line) return undefined;
  const escapedName = BUNDLE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^# dagu-feature-bundle: ${escapedName}@([^\\s]+) source=([^\\s]+) bootstrap=([^\\s]+) dagu=([^\\s]+)(?: protocols=([^\\s]+))?$`,
  ).exec(line);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  const stamp: BundleStamp = { version: match[1], source: match[2], bootstrap: match[3], dagu: match[4] };
  if (match[5] === undefined) return stamp;
  const protocols = parseProtocolToken(match[5]);
  if (!protocols) return undefined;
  return { ...stamp, protocols };
}

export interface MissingProtocol {
  checkpoint: LifecycleCheckpoint;
  protocol: string;
  servedBy: string;
}

export function missingLifecycleProtocols(declared: Partial<LifecycleProtocols> | undefined): MissingProtocol[] {
  return CHECKPOINTS.flatMap(checkpoint => {
    const protocol = declared?.[checkpoint];
    if (protocol === LIFECYCLE_PROTOCOLS[checkpoint]) return [];
    const declaredKey = protocol ? `${checkpoint}=${protocol}` : "";
    const servedBy = (declaredKey && RETIRED_PROTOCOL_BUNDLES[declaredKey]) || BUNDLE_VERSION;
    return [{ checkpoint, protocol: protocol || LIFECYCLE_PROTOCOLS[checkpoint], servedBy }];
  });
}

export function formatProtocolRejection(dag: string, missing: readonly MissingProtocol[]): string {
  return missing.map(item => {
    const declaredKey = `${item.checkpoint}=${item.protocol}`;
    if (RETIRED_PROTOCOL_BUNDLES[declaredKey]) {
      return `${dag} missing protocol ${declaredKey}; served by bundle ${item.servedBy}`;
    }
    if (item.protocol === LIFECYCLE_PROTOCOLS[item.checkpoint]) {
      return `${dag} missing protocol ${declaredKey}; served by bundle ${item.servedBy}`;
    }
    return `${dag} missing protocol ${declaredKey}; bundle ${item.servedBy} serves ${item.checkpoint}=${LIFECYCLE_PROTOCOLS[item.checkpoint]}`;
  }).join("; ");
}

function triageStep(contents: string): string | undefined {
  return /(?:^|\n)  - id: triage\n([\s\S]*?)(?=\n  - id: |\n*$)/.exec(contents)?.[1];
}

/** Classify a stamp that predates explicit protocol declarations. */
export function inferLifecycleProtocols(dagName: string, contents: string): Partial<LifecycleProtocols> {
  const triageStepBody = triageStep(contents);
  const retiredTriage = contents.includes("TRIAGE_REVIEW AGENT=")
    ? "marker-agent/1"
    : triageStepBody && /^\s+action:\s+human\.task\s*$/m.test(triageStepBody)
      ? "human-task/1"
      : undefined;
  if (dagName !== "feature.yaml") {
    return retiredTriage ? { ...LIFECYCLE_PROTOCOLS, triage: retiredTriage } : { ...LIFECYCLE_PROTOCOLS };
  }
  const triage = retiredTriage ?? (
    contents.includes("dagu-role-jobs stage triage") && contents.includes("dagu-role-jobs verify-triage")
      ? LIFECYCLE_PROTOCOLS.triage
      : undefined
  );
  const implement = contents.includes("dagu-role-jobs stage implement") ? LIFECYCLE_PROTOCOLS.implement : undefined;
  const publication = contents.includes("\n  - id: pr\n")
    && contents.includes("\n  - id: checkpoint_push\n")
    && contents.includes("dagu-pr-body render")
    ? LIFECYCLE_PROTOCOLS.publication
    : undefined;
  return { ...(triage ? { triage } : {}), ...(implement ? { implement } : {}), ...(publication ? { publication } : {}) };
}
