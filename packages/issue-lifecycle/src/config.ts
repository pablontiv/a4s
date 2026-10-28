import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRecord } from "./type-guard.ts";

/** Independent of the package version. Unknown fields are rejected. */
export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_PATH = ".workspace/dagu/config.json";

const LANE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BLOCKER = ["ask", "auto"] as const;
const SCANNING = ["required", "off"] as const;
const SECURITY = ["none", "critical", "high_or_higher", "medium_or_higher", "all"] as const;
const ALERTS = ["none", "errors", "errors_and_warnings", "all"] as const;

export type BlockerReporting = (typeof BLOCKER)[number];
export type CodeScanning = (typeof SCANNING)[number];
export type CodeqlSecurityThreshold = (typeof SECURITY)[number];
export type CodeqlAlertsThreshold = (typeof ALERTS)[number];

export interface EscalationBudgets {
  pushbacks: number;
  findings: number;
  seconds: number;
  ciBlocked: number;
  pocInconclusive: number;
}

export interface LifecycleConfig {
  schemaVersion: 1;
  lane: string;
  baseBranch: string;
  gate: string;
  requiredCheck: string;
  testPaths: string;
  rebaseResolver: string;
  validation: string;
  blockerReporting: BlockerReporting;
  codeScanning: CodeScanning;
  codeqlSecurityThreshold: CodeqlSecurityThreshold;
  codeqlAlertsThreshold: CodeqlAlertsThreshold;
  escalation: EscalationBudgets;
}

/** Enqueue names that would override committed policy. */
export const POLICY_PARAMETERS = [
  "PRIMARY", "A4S_PRIMARY", "BRANCH", "BASE_BRANCH", "GATE", "REBASE_RESOLVER", "REQUIRED_CHECK",
  "A4S_BLOCKER_REPORTING", "CODEQL_SECURITY_THRESHOLD", "CODEQL_ALERTS_THRESHOLD",
  "CODE_SCANNING", "TEST_PATHS", "VALIDATION", "QUEUE_CONCURRENCY", "LANE", "REPO",
] as const;

export interface CommittedConfig {
  config: LifecycleConfig;
  text: string;
  commit: string;
  digest: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be a JSON object`);
  return { ...value };
}

function take(source: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.hasOwn(source, key)) fail(`${label} is missing ${key}`);
  const value = source[key];
  delete source[key];
  return value;
}

function rejectUnknown(source: Record<string, unknown>, label: string): void {
  const keys = Object.keys(source);
  if (keys.length) {
    fail(`${label} rejected unknown field ${keys.join(", ")}; config schema ${CONFIG_SCHEMA_VERSION} rejects unknown fields and run-time overrides`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function text(value: unknown, label: string, pattern?: RegExp, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
  return value;
}

function choice<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${label}=${JSON.stringify(value)} expected ${allowed.join(" or ")}`);
  }
  return value as T;
}

export function parseConfig(value: unknown): LifecycleConfig {
  const source = record(value, "config file");
  const schemaVersion = take(source, "schemaVersion", "config file");
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    fail(`config schemaVersion=${JSON.stringify(schemaVersion)} expected ${CONFIG_SCHEMA_VERSION}; the config schema is independent of the package version`);
  }
  const escalationSource = record(take(source, "escalation", "config file"), "config escalation");
  const config: LifecycleConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    lane: text(take(source, "lane", "config file"), "config lane", LANE),
    baseBranch: text(take(source, "baseBranch", "config file"), "config baseBranch", BRANCH),
    gate: text(take(source, "gate", "config file"), "config gate"),
    requiredCheck: text(take(source, "requiredCheck", "config file"), "config requiredCheck"),
    testPaths: text(take(source, "testPaths", "config file"), "config testPaths"),
    rebaseResolver: text(take(source, "rebaseResolver", "config file"), "config rebaseResolver", undefined, true),
    validation: text(take(source, "validation", "config file"), "config validation", undefined, true),
    blockerReporting: choice(take(source, "blockerReporting", "config file"), "config blockerReporting", BLOCKER),
    codeScanning: choice(take(source, "codeScanning", "config file"), "config codeScanning", SCANNING),
    codeqlSecurityThreshold: choice(take(source, "codeqlSecurityThreshold", "config file"), "config codeqlSecurityThreshold", SECURITY),
    codeqlAlertsThreshold: choice(take(source, "codeqlAlertsThreshold", "config file"), "config codeqlAlertsThreshold", ALERTS),
    escalation: {
      pushbacks: positiveInteger(take(escalationSource, "pushbacks", "config escalation"), "config escalation.pushbacks"),
      findings: positiveInteger(take(escalationSource, "findings", "config escalation"), "config escalation.findings"),
      seconds: positiveInteger(take(escalationSource, "seconds", "config escalation"), "config escalation.seconds"),
      ciBlocked: positiveInteger(take(escalationSource, "ciBlocked", "config escalation"), "config escalation.ciBlocked"),
      pocInconclusive: positiveInteger(take(escalationSource, "pocInconclusive", "config escalation"), "config escalation.pocInconclusive"),
    },
  };
  rejectUnknown(escalationSource, "config escalation");
  rejectUnknown(source, "config file");
  return config;
}

export function serializeConfig(config: LifecycleConfig): string {
  return `${JSON.stringify(parseConfig(config), null, 2)}\n`;
}

export function exampleConfig(overrides: Partial<LifecycleConfig> = {}): LifecycleConfig {
  return parseConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    lane: overrides.lane ?? "fixture",
    baseBranch: overrides.baseBranch ?? "main",
    gate: overrides.gate ?? "true",
    requiredCheck: overrides.requiredCheck ?? "validate",
    testPaths: overrides.testPaths ?? "test",
    rebaseResolver: overrides.rebaseResolver ?? "",
    validation: overrides.validation ?? "",
    blockerReporting: overrides.blockerReporting ?? "ask",
    codeScanning: overrides.codeScanning ?? "required",
    codeqlSecurityThreshold: overrides.codeqlSecurityThreshold ?? "high_or_higher",
    codeqlAlertsThreshold: overrides.codeqlAlertsThreshold ?? "errors",
    escalation: {
      pushbacks: 3,
      findings: 2,
      seconds: 3600,
      ciBlocked: 2,
      pocInconclusive: 2,
      ...overrides.escalation,
    },
  });
}

function environmentInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name] ?? "";
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(`${name} must be a positive integer`);
  return Number(raw);
}

/** Bootstrap's validated environment becomes the strict config document. */
export function configFromEnvironment(env: NodeJS.ProcessEnv): LifecycleConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") fail(`${name} is required`);
    return value;
  };
  return parseConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    lane: required("REPO"),
    baseBranch: required("BASE_BRANCH"),
    gate: required("GATE"),
    requiredCheck: required("REQUIRED_CHECK"),
    testPaths: required("TEST_PATHS"),
    rebaseResolver: env.REBASE_RESOLVER ?? "",
    validation: env.VALIDATION ?? "",
    blockerReporting: env.A4S_BLOCKER_REPORTING,
    codeScanning: env.CODE_SCANNING,
    codeqlSecurityThreshold: env.CODEQL_SECURITY_THRESHOLD,
    codeqlAlertsThreshold: env.CODEQL_ALERTS_THRESHOLD,
    escalation: {
      pushbacks: environmentInteger(env, "ESCALATION_PUSHBACKS"),
      findings: environmentInteger(env, "ESCALATION_FINDINGS"),
      seconds: environmentInteger(env, "ESCALATION_SECONDS"),
      ciBlocked: environmentInteger(env, "ESCALATION_CI_BLOCKED"),
      pocInconclusive: environmentInteger(env, "ESCALATION_POC_INCONCLUSIVE"),
    },
  });
}

export function readConfigFile(path: string): LifecycleConfig {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    fail(`invalid config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(value);
}

/** Policy admitted for a run is the consumer commit, not a dirty worktree edit. */
export function readCommittedConfig(repo: string): CommittedConfig {
  let commit = "";
  try { commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { fail(`admission requires a consumer git checkout containing committed ${CONFIG_PATH}`); }
  let text = "";
  try {
    text = execFileSync("git", ["-C", repo, "show", `${commit}:${CONFIG_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    fail(`missing committed config file ${CONFIG_PATH} at ${commit.slice(0, 12)}; commit consumer policy before admission`);
  }
  const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all", "--", CONFIG_PATH], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (dirty) fail(`uncommitted config file ${CONFIG_PATH} (${dirty.split("\n")[0]}); commit it before admission so the admitted policy is the committed revision`);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { fail(`invalid JSON in committed ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`); }
  return { config: parseConfig(value), text, commit, digest: digest(text) };
}
