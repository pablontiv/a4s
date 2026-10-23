import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "triage" | "implement" | "conflict-resolution";
export interface JobBinding {
  repo: string; worktree: string; lane: string; dag: string; run: string;
  stage: string; role: Role; sha: string; iteration: number; attempt: string;
}
export interface ExecutorIdentity { host: string; pid: number; processStartedAt: string }
export interface NativeEvidence {
  session: string; transcript: string; bytes: number; digest: string;
  event: string; provider: string; model: string;
  attempts: unknown[]; fallbacks: unknown[]; routing: unknown;
}
export interface JobResult {
  schemaVersion: 1; id: string; binding: JobBinding; executor: ExecutorIdentity;
  state: "completed" | "failed" | "interrupted"; readyAt: string; startedAt: string; finishedAt: string;
  readyToStartMs: number; output?: Record<string, unknown>; native?: NativeEvidence; error?: string;
}
export interface Job {
  schemaVersion: 1; id: string; binding: JobBinding; executor: ExecutorIdentity;
  directory: string; state: "running" | JobResult["state"]; readyAt: string; startedAt: string;
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function jobId(binding: JobBinding): string {
  if (realpathSync(binding.repo) !== binding.repo || realpathSync(binding.worktree) !== binding.worktree ||
      !/^[a-f0-9]{40}$/.test(binding.sha) || !Number.isSafeInteger(binding.iteration) || binding.iteration < 0 ||
      !["triage", "implement", "conflict-resolution"].includes(binding.role) ||
      [binding.lane, binding.dag, binding.run, binding.stage, binding.attempt].some(value => !value || /[\r\n\0]/.test(value))) {
    throw new Error("Invalid canonical role-job binding");
  }
  return createHash("sha256").update(stable(binding)).digest("hex");
}
export function executorIdentity(): ExecutorIdentity {
  return { host: hostname(), pid: process.pid,
    processStartedAt: execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim() };
}
export function executorAlive(owner: ExecutorIdentity): boolean {
  // A foreign host is uncertain, not permission to replace its owner.
  if (owner.host !== hostname()) return true;
  try {
    return execFileSync("ps", ["-p", String(owner.pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === owner.processStartedAt;
  } catch { return false; }
}
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** One transactional capacity domain per canonical DAGU_HOME, across repositories/processes. */
export class RoleJobStore {
  private readonly db: DatabaseSync;
  constructor(home: string, readonly capacity: number,
    private readonly alive: (owner: ExecutorIdentity) => boolean = executorAlive) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Role-job capacity must be a positive integer");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(realpathSync(home), "role-jobs.sqlite"));
    this.db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY, capacity INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL, result TEXT);");
    this.db.prepare("INSERT OR IGNORE INTO policy VALUES (1, ?)").run(capacity);
    const policy = this.db.prepare("SELECT capacity FROM policy WHERE id=1").get();
    if (policy?.capacity !== capacity) { this.db.close(); throw new Error("Role-job capacity differs from the persisted DAGU_HOME policy"); }
  }
  close(): void { this.db.close(); }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private recover(): void {
    for (const row of this.db.prepare("SELECT id,document FROM jobs WHERE result IS NULL").all()) {
      const job = JSON.parse(String(row.document)) as Job;
      if (this.alive(job.executor)) continue;
      const result: JobResult = { schemaVersion: 1, id: job.id, binding: job.binding, executor: job.executor,
        state: "interrupted", readyAt: job.readyAt, startedAt: job.startedAt, finishedAt: new Date().toISOString(),
        readyToStartMs: Date.parse(job.startedAt) - Date.parse(job.readyAt),
        error: "Executor identity is no longer live; retained session/artifacts require inspection. Retry with a fresh authorized attempt." };
      job.state = "interrupted";
      this.db.prepare("UPDATE jobs SET document=?,result=? WHERE id=? AND result IS NULL").run(JSON.stringify(job), JSON.stringify(result), job.id);
    }
  }
  claim(binding: JobBinding, directory: string, readyAt: string, authorize: () => void,
    executor = executorIdentity()): { kind: "claimed" | "active"; job: Job } | { kind: "terminal"; result: JobResult } | { kind: "capacity" } {
    const id = jobId(binding);
    if (!Number.isFinite(Date.parse(readyAt))) throw new Error("Invalid role-job readiness timestamp");
    return this.transaction(() => {
      authorize();
      this.recover();
      const previous = this.db.prepare("SELECT document,result FROM jobs WHERE id=?").get(id);
      if (previous) {
        if ((JSON.parse(String(previous.document)) as Job).directory !== directory) throw new Error("Role-job delivery changed its retained artifact directory");
        if (previous.result) return { kind: "terminal", result: JSON.parse(String(previous.result)) as JobResult };
        return { kind: "active", job: JSON.parse(String(previous.document)) as Job };
      }
      const active = this.db.prepare("SELECT count(*) AS count FROM jobs WHERE result IS NULL").get();
      if (Number(active?.count) >= this.capacity) return { kind: "capacity" };
      const mutating = (role: Role) => role === "implement" || role === "conflict-resolution";
      for (const row of this.db.prepare("SELECT document FROM jobs WHERE result IS NULL").all()) {
        const activeJob = JSON.parse(String(row.document)) as Job;
        if (activeJob.binding.worktree === binding.worktree &&
            (mutating(binding.role) || mutating(activeJob.binding.role))) return { kind: "capacity" };
      }
      const job: Job = { schemaVersion: 1, id, binding, executor, directory,
        state: "running", readyAt, startedAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO jobs (id,document) VALUES (?,?)").run(id, JSON.stringify(job));
      return { kind: "claimed", job };
    });
  }
  finish(job: Job, result: JobResult): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT document,result FROM jobs WHERE id=?").get(job.id);
      const owner = row ? JSON.parse(String(row.document)) as Job : undefined;
      if (!owner || row?.result || stable(owner.executor) !== stable(job.executor) ||
          result.id !== job.id || stable(result.binding) !== stable(job.binding) || stable(result.executor) !== stable(job.executor)) {
        throw new Error("Role-job terminal result does not belong to the active execution");
      }
      this.db.prepare("UPDATE jobs SET document=?,result=? WHERE id=?").run(JSON.stringify({ ...job, state: result.state }), JSON.stringify(result), job.id);
    });
    // SQLite is authoritative: a crash during materialization is repaired on redelivery.
    this.materialize(job.directory, result);
  }
  materialize(directory: string, result: JobResult): void {
    atomicJson(join(directory, "job.json"), { schemaVersion: 1, id: result.id, binding: result.binding,
      executor: result.executor, directory, readyAt: result.readyAt, startedAt: result.startedAt, state: result.state });
    atomicJson(join(directory, "result.json"), result);
  }
}

export function verifyJobResult(path: string, expected: Partial<JobBinding> = {}): JobResult {
  const result = JSON.parse(readFileSync(path, "utf8")) as JobResult;
  if (result.schemaVersion !== 1 || result.id !== jobId(result.binding) || result.state !== "completed" || !result.native || !result.output) throw new Error("Role job lacks a completed native result");
  for (const [key, value] of Object.entries(expected)) {
    if (result.binding[key as keyof JobBinding] !== value) throw new Error(`Role-job ${key} mismatch`);
  }
  const native = result.native;
  const bytes = readFileSync(native.transcript);
  if (!Number.isSafeInteger(native.bytes) || native.bytes < 1 || bytes.length < native.bytes ||
      createHash("sha256").update(bytes.subarray(0, native.bytes)).digest("hex") !== native.digest) throw new Error("Role-job transcript changed");
  const rows = bytes.subarray(0, native.bytes).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  if (rows.filter(row => row.type === "session" && row.id === native.session).length !== 1 ||
      rows.filter(row => row.id === native.event && row.message?.role === "assistant" && row.message.provider === native.provider && row.message.model === native.model).length !== 1) throw new Error("Role-job native session/model provenance mismatch");
  const event = rows.find(row => row.id === native.event);
  const parts = event.message.content;
  const yielded = Array.isArray(parts) ? parts.find((part: { type: string; name?: string }) => part.type === "toolCall" && part.name === "yield") : undefined;
  const outcomes = yielded?.id ? rows.filter(row => row.message?.role === "toolResult" &&
    row.message.toolName === "yield" && row.message.toolCallId === yielded.id &&
    !row.message.isError && row.message.details?.status === "success") : [];
  if (outcomes.length !== 1 || stable(outcomes[0].message.details.data) !== stable(result.output)) throw new Error("Role-job output differs from the native response");
  return result;
}
