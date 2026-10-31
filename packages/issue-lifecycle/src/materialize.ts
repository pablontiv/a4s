import { readServiceEnvironment, serviceEnvironmentPath, type ServiceEnvironment } from "../../launcher/src/service-environment.ts";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LifecycleConfig } from "../../launcher/src/config.ts";
import type { CoordinatingSession } from "./planning-transcript.ts";

export const LIFECYCLE_DAGS = ["feature.yaml", "poc.yaml", "discovery.yaml", "planning.yaml", "reconcile.yaml"] as const;
export type LifecycleDag = (typeof LIFECYCLE_DAGS)[number];


export function dagName(argument: string): LifecycleDag {
  const base = basename(argument);
  const name = base.endsWith(".yaml") ? base : `${base}.yaml`;
  if (!(LIFECYCLE_DAGS as readonly string[]).includes(name)) {
    throw new Error(`DAG=${base} expected one of ${LIFECYCLE_DAGS.join(", ")}`);
  }
  return name as LifecycleDag;
}


function quoted(value: string | number): string {
  return JSON.stringify(String(value));
}

function replacements(config: LifecycleConfig, identity: { version: string; source: string; coordinator?: CoordinatingSession }, station: ServiceEnvironment): Record<string, string> {
  return {
    __DAGU_URL__: JSON.stringify(station.DAGU_URL),
    __DAGU_HOME__: JSON.stringify(station.DAGU_HOME),
    __SERVICE_PATH__: JSON.stringify(station.PATH),
    __A4S_SERVICE_ENV__: JSON.stringify(serviceEnvironmentPath()),
    __COORDINATING_SESSION__: JSON.stringify(JSON.stringify(identity.coordinator ?? null)),
    "__DAGU_FEATURE_VERSION__": identity.version,
    "__DAGU_FEATURE_IDENTITY__": `dagu-feature-bundle=${identity.version} source=${identity.source}`,
    TEMPLATE_DAGU_FEATURE_VERSION: identity.version,
    TEMPLATE_REPO: config.lane,
    TEMPLATE_BASE_BRANCH: JSON.stringify(config.baseBranch),
    __PRIMARY__: JSON.stringify("${A4S_PRIMARY}"),
    __GATE__: JSON.stringify(config.gate),
    __REBASE_RESOLVER__: JSON.stringify(config.rebaseResolver),
    __REQUIRED_CHECK__: JSON.stringify(config.requiredCheck),
    __CODEQL_SECURITY_THRESHOLD__: JSON.stringify(config.codeqlSecurityThreshold),
    __CODEQL_ALERTS_THRESHOLD__: JSON.stringify(config.codeqlAlertsThreshold),
    __CODE_SCANNING__: JSON.stringify(config.codeScanning),
    __VALIDATION__: JSON.stringify(config.validation),
    __A4S_BLOCKER_REPORTING__: JSON.stringify(config.blockerReporting),
    __TEST_PATHS__: JSON.stringify(config.testPaths),
    __ESCALATION_PUSHBACKS__: quoted(config.escalation.pushbacks),
    __ESCALATION_FINDINGS__: quoted(config.escalation.findings),
    __ESCALATION_SECONDS__: quoted(config.escalation.seconds),
    __ESCALATION_CI_BLOCKED__: quoted(config.escalation.ciBlocked),
    __ESCALATION_POC_INCONCLUSIVE__: quoted(config.escalation.pocInconclusive),
  };
}

/** Fill a verified release template. The result is immutable run state. */
export function materializeDag(root: string, name: LifecycleDag, config: LifecycleConfig, identity: { version: string; source: string; executable?: string; station?: ServiceEnvironment; coordinator?: CoordinatingSession }): string {
  const template = readFileSync(join(root, "skills", "issue-execution", name), "utf8");
  let result = template;
  const tokens = replacements(config, identity, identity.station ?? readServiceEnvironment());
  for (const token of Object.keys(tokens).sort((left, right) => right.length - left.length)) {
    result = result.split(token).join(tokens[token]!);
  }
  if (identity.executable) result = result.replace(/^env:\n/gm, `env:\n  - A4S_BIN: ${JSON.stringify(identity.executable)}\n`);
  const leftover = result.match(/TEMPLATE_[A-Z0-9_]+|__[A-Z0-9_]+__/g);
  if (leftover) throw new Error(`${name} unresolved template placeholder ${[...new Set(leftover)].join(", ")}`);
  return result;
}

