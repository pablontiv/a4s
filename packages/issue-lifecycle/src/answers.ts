import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRecord } from "./type-guard.ts";

/** Independent of the package version. Unknown fields are rejected. */
export const ANSWERS_SCHEMA_VERSION = 1;
export const ANSWERS_PATH = ".workspace/dagu/answers.json";

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

export interface LifecycleAnswers {
  schemaVersion: 1;
  lane: string;
  baseBranch: string;
  queueConcurrency: number;
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
  "PRIMARY", "A4S_PRIMARY", "BRANCH", "GATE", "REBASE_RESOLVER", "REQUIRED_CHECK",
  "A4S_BLOCKER_REPORTING", "CODEQL_SECURITY_THRESHOLD", "CODEQL_ALERTS_THRESHOLD",
  "CODE_SCANNING", "TEST_PATHS", "VALIDATION", "QUEUE_CONCURRENCY", "LANE",
] as const;

export interface CommittedAnswers {
  answers: LifecycleAnswers;
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
    fail(`${label} rejected unknown field ${keys.join(", ")}; answers schema ${ANSWERS_SCHEMA_VERSION} rejects unknown fields and run-time overrides`);
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

export function parseAnswers(value: unknown): LifecycleAnswers {
  const source = record(value, "answers file");
  const schemaVersion = take(source, "schemaVersion", "answers file");
  if (schemaVersion !== ANSWERS_SCHEMA_VERSION) {
    fail(`answers schemaVersion=${JSON.stringify(schemaVersion)} expected ${ANSWERS_SCHEMA_VERSION}; the answers schema is independent of the package version`);
  }
  const escalationSource = record(take(source, "escalation", "answers file"), "answers escalation");
  const answers: LifecycleAnswers = {
    schemaVersion: ANSWERS_SCHEMA_VERSION,
    lane: text(take(source, "lane", "answers file"), "answers lane", LANE),
    baseBranch: text(take(source, "baseBranch", "answers file"), "answers baseBranch", BRANCH),
    queueConcurrency: positiveInteger(take(source, "queueConcurrency", "answers file"), "answers queueConcurrency"),
    gate: text(take(source, "gate", "answers file"), "answers gate"),
    requiredCheck: text(take(source, "requiredCheck", "answers file"), "answers requiredCheck"),
    testPaths: text(take(source, "testPaths", "answers file"), "answers testPaths"),
    rebaseResolver: text(take(source, "rebaseResolver", "answers file"), "answers rebaseResolver", undefined, true),
    validation: text(take(source, "validation", "answers file"), "answers validation", undefined, true),
    blockerReporting: choice(take(source, "blockerReporting", "answers file"), "answers blockerReporting", BLOCKER),
    codeScanning: choice(take(source, "codeScanning", "answers file"), "answers codeScanning", SCANNING),
    codeqlSecurityThreshold: choice(take(source, "codeqlSecurityThreshold", "answers file"), "answers codeqlSecurityThreshold", SECURITY),
    codeqlAlertsThreshold: choice(take(source, "codeqlAlertsThreshold", "answers file"), "answers codeqlAlertsThreshold", ALERTS),
    escalation: {
      pushbacks: positiveInteger(take(escalationSource, "pushbacks", "answers escalation"), "answers escalation.pushbacks"),
      findings: positiveInteger(take(escalationSource, "findings", "answers escalation"), "answers escalation.findings"),
      seconds: positiveInteger(take(escalationSource, "seconds", "answers escalation"), "answers escalation.seconds"),
      ciBlocked: positiveInteger(take(escalationSource, "ciBlocked", "answers escalation"), "answers escalation.ciBlocked"),
      pocInconclusive: positiveInteger(take(escalationSource, "pocInconclusive", "answers escalation"), "answers escalation.pocInconclusive"),
    },
  };
  rejectUnknown(escalationSource, "answers escalation");
  rejectUnknown(source, "answers file");
  return answers;
}

export function serializeAnswers(answers: LifecycleAnswers): string {
  return `${JSON.stringify(parseAnswers(answers), null, 2)}\n`;
}

export function exampleAnswers(overrides: Partial<LifecycleAnswers> = {}): LifecycleAnswers {
  return parseAnswers({
    schemaVersion: ANSWERS_SCHEMA_VERSION,
    lane: overrides.lane ?? "fixture",
    baseBranch: overrides.baseBranch ?? "main",
    queueConcurrency: overrides.queueConcurrency ?? 1,
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

/** Bootstrap's validated environment becomes the strict answers document. */
export function answersFromEnvironment(env: NodeJS.ProcessEnv): LifecycleAnswers {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") fail(`${name} is required`);
    return value;
  };
  return parseAnswers({
    schemaVersion: ANSWERS_SCHEMA_VERSION,
    lane: required("REPO"),
    baseBranch: required("BASE_BRANCH"),
    queueConcurrency: environmentInteger(env, "QUEUE_CONCURRENCY"),
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

export function readAnswersFile(path: string): LifecycleAnswers {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    fail(`invalid answers file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseAnswers(value);
}

/** Policy admitted for a run is the consumer commit, not a dirty worktree edit. */
export function readCommittedAnswers(repo: string): CommittedAnswers {
  let commit = "";
  try { commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { fail(`admission requires a consumer git checkout containing committed ${ANSWERS_PATH}`); }
  let text = "";
  try {
    text = execFileSync("git", ["-C", repo, "show", `${commit}:${ANSWERS_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    fail(`missing committed answers file ${ANSWERS_PATH} at ${commit.slice(0, 12)}; commit consumer policy before admission`);
  }
  const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all", "--", ANSWERS_PATH], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (dirty) fail(`uncommitted answers file ${ANSWERS_PATH} (${dirty.split("\n")[0]}); commit it before admission so the admitted policy is the committed revision`);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { fail(`invalid JSON in committed ${ANSWERS_PATH}: ${error instanceof Error ? error.message : String(error)}`); }
  return { answers: parseAnswers(value), text, commit, digest: digest(text) };
}
