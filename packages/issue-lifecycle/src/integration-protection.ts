import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./type-guard.ts";
import { requireOwnerSession } from "./owner-session.ts";

/** Visible checkpoint named in gate, push and auto-merge logs and [DAGU STATE]. */
export const INTEGRATION_HOLD_CHECKPOINT = "integration_hold";
/** Admission waits and retries; the candidate, run id and iteration stay put. */
export const INTEGRATION_HOLD_EXIT = 86;

export const CHECKPOINTS = ["gate", "push", "auto_merge"] as const;
export type IntegrationCheckpoint = (typeof CHECKPOINTS)[number];
export const RELEASE_REASONS = ["close_gate", "terminal", "operator", "abort"] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export interface ProtectionProvenance {
  recordedAt: string;
  command: string;
  sessionId?: string;
}

export interface HeldRun {
  run: string;
  issue: string;
  checkpoint: IntegrationCheckpoint;
  paths: string[];
  since: string;
  waiterPid?: number;
  noticeKey: string;
}

export interface IntegrationProtectionRecord {
  schemaVersion: 1;
  status: "active" | "released";
  protectedRun: string;
  issue: string;
  paths: string[];
  candidateSha: string;
  decision: string;
  provenance: ProtectionProvenance;
  pathsRefreshedAt: string;
  held: HeldRun[];
  releasedAt?: string;
  releaseReason?: ReleaseReason;
  releaseDecision?: string;
}

export interface ActiveIntegrationProtection {
  protectedRun: string;
  issue: string;
  held: string[];
  recordedAt: string;
}

export interface AdmitRequest {
  primary: string;
  worktree: string;
  run: string;
  issue: string;
  checkpoint: IntegrationCheckpoint;
  /** The caller already holds the per-primary gate lock. */
  heldLock: boolean;
  waiterPid?: number;
}

export interface AdmitResult {
  action: "proceed" | "hold";
  line?: string;
  protectedRun?: string;
  protectedIssue?: string;
  paths?: string[];
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const ISSUE = /^\d{1,10}$/;
const SHA = /^[a-f0-9]{40}$/;

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

export function commonDir(primary: string): string {
  return git(primary, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

function featureDir(primary: string): string {
  return join(commonDir(primary), "dagu-feature");
}

export function protectionPath(primary: string): string {
  return join(featureDir(primary), "integration-protection.json");
}

function lockPath(primary: string, name: string): string {
  return join(featureDir(primary), name);
}

function runState(primary: string, run: string): string {
  requireRun(run);
  return git(primary, ["rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`]);
}

function requireRun(run: string): void {
  if (!RUN_ID.test(run)) throw new Error(`integration protection: invalid run: ${run}`);
}

function requireIssue(issue: string): void {
  if (!issue) throw new Error("integration protection: missing ISSUE");
  if (!ISSUE.test(issue)) throw new Error(`integration protection: invalid issue: ${issue}`);
}

export function requireDecision(decision: string): string {
  const text = decision.trim();
  if (!text || text.length > 2000 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error("integration protection: an explicit operator decision is required");
  }
  return text;
}

function requirePath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`integration protection: invalid changed path: ${path}`);
  }
}

export function pathsFromNameStatus(text: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [status, first, second] = line.split("\t");
    if (!status || !first) throw new Error("integration protection: unreadable changed path");
    requirePath(first);
    paths.add(first);
    if (status.startsWith("R") || status.startsWith("C")) {
      if (!second) throw new Error("integration protection: rename is missing its destination");
      requirePath(second);
      paths.add(second);
    }
  }
  return [...paths].sort();
}

export function changedPaths(worktree: string, base: string, sha: string): string[] {
  if (!SHA.test(base) || !SHA.test(sha)) throw new Error("integration protection: candidate SHA is invalid");
  return pathsFromNameStatus(git(worktree, ["diff", "--name-status", "--find-renames", base, sha]));
}

function candidateIdentity(primary: string, run: string): { sha: string; base: string } {
  const file = join(runState(primary, run), "candidate.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`integration protection: candidate is not readable for ${run}`);
  }
  if (!isRecord(value) || typeof value.sha !== "string" || typeof value.base !== "string" || !SHA.test(value.sha) || !SHA.test(value.base)) {
    throw new Error(`integration protection: candidate is missing sha or base for ${run}`);
  }
  return { sha: value.sha, base: value.base };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`integration protection: invalid ${label}`);
  return value as string[];
}

function parseHeld(value: unknown): HeldRun {
  if (!isRecord(value) || typeof value.run !== "string" || typeof value.issue !== "string"
    || typeof value.checkpoint !== "string" || typeof value.since !== "string" || typeof value.noticeKey !== "string"
    || (value.waiterPid !== undefined && (typeof value.waiterPid !== "number" || !Number.isInteger(value.waiterPid) || value.waiterPid < 0))) {
    throw new Error("integration protection: invalid held run");
  }
  requireRun(value.run);
  requireIssue(value.issue);
  if (!CHECKPOINTS.includes(value.checkpoint as IntegrationCheckpoint)) throw new Error("integration protection: invalid held checkpoint");
  const paths = stringList(value.paths, "held paths");
  for (const path of paths) requirePath(path);
  const held: HeldRun = {
    run: value.run, issue: value.issue, checkpoint: value.checkpoint as IntegrationCheckpoint,
    paths, since: value.since, noticeKey: value.noticeKey,
  };
  if (typeof value.waiterPid === "number") held.waiterPid = value.waiterPid;
  return held;
}

function parseRecord(value: unknown): IntegrationProtectionRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.status !== "active" && value.status !== "released")
    || typeof value.protectedRun !== "string" || typeof value.issue !== "string" || typeof value.candidateSha !== "string"
    || typeof value.decision !== "string" || typeof value.pathsRefreshedAt !== "string" || !isRecord(value.provenance)
    || typeof value.provenance.recordedAt !== "string" || typeof value.provenance.command !== "string"
    || (value.provenance.sessionId !== undefined && typeof value.provenance.sessionId !== "string")
    || !Array.isArray(value.held) || !SHA.test(value.candidateSha)) {
    throw new Error("integration protection: invalid record");
  }
  requireRun(value.protectedRun);
  requireIssue(value.issue);
  requireDecision(value.decision);
  const paths = stringList(value.paths, "protected paths");
  for (const path of paths) requirePath(path);
  if (value.releasedAt !== undefined && typeof value.releasedAt !== "string") throw new Error("integration protection: invalid record");
  if (value.releaseReason !== undefined && !RELEASE_REASONS.includes(value.releaseReason as ReleaseReason)) throw new Error("integration protection: invalid record");
  if (value.releaseDecision !== undefined && typeof value.releaseDecision !== "string") throw new Error("integration protection: invalid record");
  const provenance: ProtectionProvenance = { recordedAt: value.provenance.recordedAt, command: value.provenance.command };
  if (typeof value.provenance.sessionId === "string") provenance.sessionId = value.provenance.sessionId;
  const record: IntegrationProtectionRecord = {
    schemaVersion: 1, status: value.status, protectedRun: value.protectedRun, issue: value.issue,
    paths, candidateSha: value.candidateSha, decision: value.decision, provenance,
    pathsRefreshedAt: value.pathsRefreshedAt, held: value.held.map(parseHeld),
  };
  if (typeof value.releasedAt === "string") record.releasedAt = value.releasedAt;
  if (typeof value.releaseReason === "string") record.releaseReason = value.releaseReason as ReleaseReason;
  if (typeof value.releaseDecision === "string") record.releaseDecision = value.releaseDecision;
  return record;
}

function readRecord(primary: string): IntegrationProtectionRecord | undefined {
  const file = protectionPath(primary);
  try {
    return parseRecord(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function writeRecord(primary: string, record: IntegrationProtectionRecord): void {
  const file = protectionPath(primary);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function withFileLock<T>(file: string, body: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a+", 0o600);
  try {
    const locked = spawnSync("python3", ["-c", "import fcntl; fcntl.flock(3, fcntl.LOCK_EX)"], {
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || "integration protection: lock failed");
    return body();
  } finally {
    closeSync(fd);
  }
}

function withProtectionLock<T>(primary: string, body: () => T): T {
  return withFileLock(lockPath(primary, "integration-protection.lock"), body);
}

function withGateLock<T>(primary: string, body: () => T): T {
  return withFileLock(lockPath(primary, "gate.lock"), body);
}

function sessionProvenance(command: string, sessionId: string | undefined): ProtectionProvenance {
  const provenance: ProtectionProvenance = { recordedAt: new Date().toISOString(), command };
  if (sessionId) {
    provenance.sessionId = requireOwnerSession(sessionId);
  }
  return provenance;
}

export function protectCandidate(input: {
  primary: string; worktree: string; run: string; issue: string; decision: string; sessionId?: string;
}): IntegrationProtectionRecord {
  requireRun(input.run);
  requireIssue(input.issue);
  const decision = requireDecision(input.decision);
  const identity = candidateIdentity(input.primary, input.run);
  const paths = changedPaths(input.worktree, identity.base, identity.sha);
  return withProtectionLock(input.primary, () => {
    const current = readRecord(input.primary);
    if (current?.status === "active" && current.protectedRun !== input.run) {
      throw new Error(`integration protection: active protected_run=${current.protectedRun} issue=${current.issue}; release it before protecting another run`);
    }
    const provenance = sessionProvenance("dagu-feature-protect protect", input.sessionId);
    const record: IntegrationProtectionRecord = {
      schemaVersion: 1, status: "active", protectedRun: input.run, issue: input.issue, paths,
      candidateSha: identity.sha, decision, provenance, pathsRefreshedAt: provenance.recordedAt,
      held: current?.protectedRun === input.run ? current.held : [],
    };
    writeRecord(input.primary, record);
    return record;
  });
}

export function refreshProtectedPaths(primary: string, worktree: string, run: string): IntegrationProtectionRecord | undefined {
  requireRun(run);
  return withProtectionLock(primary, () => {
    const current = readRecord(primary);
    if (!current || current.status !== "active" || current.protectedRun !== run) return undefined;
    const identity = candidateIdentity(primary, run);
    current.paths = changedPaths(worktree, identity.base, identity.sha);
    current.candidateSha = identity.sha;
    current.pathsRefreshedAt = new Date().toISOString();
    writeRecord(primary, current);
    return current;
  });
}

export function releaseProtection(primary: string, input: {
  reason: ReleaseReason; decision?: string; run?: string;
}): IntegrationProtectionRecord | undefined {
  if (input.run) requireRun(input.run);
  const decision = input.reason === "operator" ? requireDecision(input.decision ?? "") : undefined;
  if (input.reason !== "operator" && input.decision) throw new Error("integration protection: automatic release has no operator decision");
  return withProtectionLock(primary, () => {
    const current = readRecord(primary);
    if (!current || current.status !== "active") return undefined;
    if (input.run && current.protectedRun !== input.run) return undefined;
    current.status = "released";
    current.releasedAt = new Date().toISOString();
    current.releaseReason = input.reason;
    current.held = [];
    if (decision) current.releaseDecision = decision;
    else delete current.releaseDecision;
    writeRecord(primary, current);
    return current;
  });
}

function holdLine(record: IntegrationProtectionRecord, request: AdmitRequest, paths: string[]): string {
  return `integration protection: checkpoint=${INTEGRATION_HOLD_CHECKPOINT} stage=${request.checkpoint} run=${request.run} issue=${request.issue} protected_run=${record.protectedRun} protected_issue=${record.issue} paths=${paths.join(",")}`;
}

function admitLocked(request: AdmitRequest): AdmitResult {
  requireRun(request.run);
  const current = readRecord(request.primary);
  const removeHold = (): AdmitResult => {
    if (current?.held.some(held => held.run === request.run)) {
      current.held = current.held.filter(held => held.run !== request.run);
      writeRecord(request.primary, current);
    }
    return { action: "proceed" };
  };
  if (!current || current.status !== "active" || current.protectedRun === request.run) return removeHold();
  const identity = candidateIdentity(request.primary, request.run);
  const own = new Set(changedPaths(request.worktree, identity.base, identity.sha));
  const intersection = current.paths.filter(path => own.has(path));
  if (!intersection.length) return removeHold();
  requireIssue(request.issue);
  const noticeKey = [current.protectedRun, current.candidateSha, request.checkpoint, intersection.join(","), String(request.waiterPid ?? "")].join("\0");
  const previous = current.held.find(held => held.run === request.run);
  const entry: HeldRun = {
    run: request.run, issue: request.issue, checkpoint: request.checkpoint, paths: intersection,
    since: previous?.since ?? new Date().toISOString(), noticeKey,
  };
  if (request.waiterPid !== undefined) entry.waiterPid = request.waiterPid;
  current.held = [...current.held.filter(held => held.run !== request.run), entry].sort((left, right) => left.run < right.run ? -1 : left.run > right.run ? 1 : 0);
  writeRecord(request.primary, current);
  const result: AdmitResult = {
    action: "hold", protectedRun: current.protectedRun, protectedIssue: current.issue, paths: intersection,
  };
  if (previous?.noticeKey !== noticeKey) result.line = holdLine(current, request, intersection);
  return result;
}

export function admit(request: AdmitRequest): AdmitResult {
  const decide = (): AdmitResult => withProtectionLock(request.primary, () => admitLocked(request));
  return request.heldLock ? decide() : withGateLock(request.primary, decide);
}

export function readProtection(primary: string): IntegrationProtectionRecord | undefined {
  return withProtectionLock(primary, () => readRecord(primary));
}

/** Status display tolerates a missing or unreadable record. */
export function readActiveProtection(primary: string): ActiveIntegrationProtection | undefined {
  try {
    const record = readRecord(primary);
    if (!record || record.status !== "active") return undefined;
    return {
      protectedRun: record.protectedRun,
      issue: record.issue,
      held: record.held.map(held => held.run).sort(),
      recordedAt: record.provenance.recordedAt,
    };
  } catch {
    return undefined;
  }
}
