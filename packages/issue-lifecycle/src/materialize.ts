import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LifecycleAnswers } from "./answers.ts";

export const LIFECYCLE_DAGS = ["feature.yaml", "poc.yaml", "discovery.yaml", "planning.yaml", "reconcile.yaml"] as const;
export type LifecycleDag = (typeof LIFECYCLE_DAGS)[number];

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export function dagName(argument: string): LifecycleDag {
  const base = basename(argument);
  const name = base.endsWith(".yaml") ? base : `${base}.yaml`;
  if (!(LIFECYCLE_DAGS as readonly string[]).includes(name)) {
    throw new Error(`DAG=${base} expected one of ${LIFECYCLE_DAGS.join(", ")}`);
  }
  return name as LifecycleDag;
}

export function repositoryNwo(origin: string): string {
  const parts = origin.replace(/\.git\/?$/, "").replace(/\/$/, "").split(/[/:]/).filter(Boolean);
  const repo = parts.at(-1);
  const owner = parts.at(-2);
  if (!repo || !owner) throw new Error(`package origin=${origin} expected owner/repository`);
  return `${owner}/${repo}`;
}

export interface TemplateIdentity {
  version: string;
  commit: string;
  origin: string;
  /** `owner/repository@sha` of the installed package checkout. */
  source: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function packageIdentity(root = packageRoot): TemplateIdentity {
  const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Package identity requires a declared version");
  }
  const commit = git(root, "rev-parse", "HEAD");
  const origin = git(root, "remote", "get-url", "origin");
  return { version: manifest.version, commit, origin, source: `${repositoryNwo(origin)}@${commit}` };
}

function quoted(value: string | number): string {
  return JSON.stringify(String(value));
}

function replacements(answers: LifecycleAnswers, identity: Pick<TemplateIdentity, "version" | "source">): Record<string, string> {
  return {
    "__DAGU_FEATURE_VERSION__": identity.version,
    "__DAGU_FEATURE_IDENTITY__": `dagu-feature-bundle=${identity.version} source=${identity.source}`,
    TEMPLATE_DAGU_FEATURE_VERSION: identity.version,
    TEMPLATE_QUEUE_CONCURRENCY: String(answers.queueConcurrency),
    TEMPLATE_REPO: answers.lane,
    TEMPLATE_BASE_BRANCH: JSON.stringify(answers.baseBranch),
    __PRIMARY__: JSON.stringify("${A4S_PRIMARY}"),
    __GATE__: JSON.stringify(answers.gate),
    __REBASE_RESOLVER__: JSON.stringify(answers.rebaseResolver),
    __REQUIRED_CHECK__: JSON.stringify(answers.requiredCheck),
    __CODEQL_SECURITY_THRESHOLD__: JSON.stringify(answers.codeqlSecurityThreshold),
    __CODEQL_ALERTS_THRESHOLD__: JSON.stringify(answers.codeqlAlertsThreshold),
    __CODE_SCANNING__: JSON.stringify(answers.codeScanning),
    __VALIDATION__: JSON.stringify(answers.validation),
    __A4S_BLOCKER_REPORTING__: JSON.stringify(answers.blockerReporting),
    __TEST_PATHS__: JSON.stringify(answers.testPaths),
    __ESCALATION_PUSHBACKS__: quoted(answers.escalation.pushbacks),
    __ESCALATION_FINDINGS__: quoted(answers.escalation.findings),
    __ESCALATION_SECONDS__: quoted(answers.escalation.seconds),
    __ESCALATION_CI_BLOCKED__: quoted(answers.escalation.ciBlocked),
    __ESCALATION_POC_INCONCLUSIVE__: quoted(answers.escalation.pocInconclusive),
  };
}

/** Fill one installed package template. The result is run state, not a consumer file. */
export function materializeDag(root: string, name: LifecycleDag, answers: LifecycleAnswers, identity: Pick<TemplateIdentity, "version" | "source">): string {
  const template = readFileSync(join(root, "skills", "issue-execution", name), "utf8");
  let result = template;
  for (const token of Object.keys(replacements(answers, identity)).sort((left, right) => right.length - left.length)) {
    result = result.split(token).join(replacements(answers, identity)[token]!);
  }
  const leftover = result.match(/TEMPLATE_[A-Z0-9_]+|__[A-Z0-9_]+__/g);
  if (leftover) throw new Error(`${name} unresolved template placeholder ${[...new Set(leftover)].join(", ")}`);
  return result;
}

export function materializeInstalled(name: LifecycleDag, answers: LifecycleAnswers, root = packageRoot): string {
  const identity = packageIdentity(root);
  return materializeDag(root, name, answers, identity);
}
