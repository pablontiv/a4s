import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson } from "./role-jobs.ts";

export const LONG_COMPUTATION_CONTRACT = [
  "Long computation contract: before a long computation, run a bounded representative sample and record measured throughput and the projected duration.",
  "Run the full computation as a background job with durable shard checkpoints under the run evidence directory (<git-dir>/dagu-feature/runs/<run>/computations/<id>/, or <git-dir>/poc/runs/<run>/computations/<id>/ for run_poc).",
  "Each shard records its index, range and completion time.",
  "Resume from the last completed shard after interruption.",
  "When no new shard completes within the configured multiple of the measured shard time, the role-job executor reports one stall to the owning OMP session with the last progress and waits for continue, resize, or stop.",
  "Completed shards stay preserved.",
].join(" ");

export interface ShardRange { start: number; end: number }
export interface SampleRecord {
  schemaVersion: 1;
  units: number;
  elapsedMs: number;
  throughputPerSecond: number;
  projectedUnits: number;
  projectedDurationMs: number;
  shardUnits: number;
  measuredShardMs: number;
  recordedAt: string;
}
export interface PlannedShard { index: number; range: ShardRange }
export interface ComputationManifest {
  schemaVersion: 1;
  id: string;
  run: string;
  session: string;
  totalUnits: number;
  shardUnits: number;
  stallMultiple: number;
  measuredShardMs: number;
  openedAt: string;
  sample: SampleRecord;
  shards: PlannedShard[];
}
export interface ShardCheckpoint {
  schemaVersion: 1;
  index: number;
  range: ShardRange;
  completedAt: string;
  output: string;
}
export interface ProgressRecord {
  schemaVersion: 1;
  completed: number;
  total: number;
  lastShard?: ShardCheckpoint;
}
export interface StallNotice {
  schemaVersion: 1;
  session: string;
  computation: string;
  directory: string;
  progress: ProgressRecord;
  measuredShardMs: number;
  stallMultiple: number;
  deadlineMs: number;
  notifiedAt: string;
}
export interface OwnerDecision {
  schemaVersion: 1;
  decision: "continue" | "resize" | "stop";
  stallMultiple?: number;
  decidedAt: string;
}
export interface ComputationClock {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}
type ComputationState = "running" | "completed" | "stopped";

function identifier(value: string, label: string): string {
  if (!value || value.length > 200 || /[\s\0/\\]/.test(value)) throw new Error(`Invalid computation ${label}`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return value;
}
function timestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}`);
  return value;
}
function clockNow(now?: () => number): number {
  const value = now ? now() : Date.now();
  if (!Number.isFinite(value)) throw new Error("Invalid computation clock");
  return value;
}
function iso(now?: () => number): string {
  return new Date(clockNow(now)).toISOString();
}
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
function isRange(value: unknown): value is ShardRange {
  if (!value || typeof value !== "object") return false;
  const range = value as ShardRange;
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start;
}
function planShards(totalUnits: number, shardUnits: number): PlannedShard[] {
  const shards: PlannedShard[] = [];
  let start = 0;
  let index = 1;
  while (start < totalUnits) {
    const end = Math.min(totalUnits, start + shardUnits);
    shards.push({ index, range: { start, end } });
    index += 1;
    start = end;
  }
  return shards;
}
function measuredShardMs(elapsedMs: number, units: number, shardUnits: number): number {
  return shardUnits * elapsedMs / units;
}
export function computationDirectory(runEvidenceDir: string, id: string): string {
  return join(runEvidenceDir, "computations", identifier(id, "id"));
}
export function runEvidenceForComputation(directory: string): string {
  const computations = dirname(directory);
  if (basename(computations) !== "computations") throw new Error("Computation directory must be <run-evidence>/computations/<id>");
  return dirname(computations);
}

export function recordSample(directory: string, input: {
  units: number; elapsedMs: number; projectedUnits: number; shardUnits: number;
}, now?: () => number): SampleRecord {
  const units = positiveInteger(input.units, "Sample units");
  const elapsedMs = positiveInteger(input.elapsedMs, "Sample elapsed time");
  const projectedUnits = positiveInteger(input.projectedUnits, "Projected units");
  const shardUnits = positiveInteger(input.shardUnits, "Shard units");
  if (shardUnits > projectedUnits) throw new Error("Shard units exceed the projected computation");
  if (existsSync(join(directory, "manifest.json"))) throw new Error("Sample is already committed to a computation plan");
  const sample: SampleRecord = {
    schemaVersion: 1, units, elapsedMs, projectedUnits, shardUnits,
    throughputPerSecond: units * 1000 / elapsedMs,
    projectedDurationMs: projectedUnits * elapsedMs / units,
    measuredShardMs: measuredShardMs(elapsedMs, units, shardUnits),
    recordedAt: iso(now),
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicJson(join(directory, "sample.json"), sample);
  return sample;
}

function parseSample(value: unknown): SampleRecord {
  if (!value || typeof value !== "object") throw new Error("Computation sample is invalid");
  const sample = value as SampleRecord;
  if (sample.schemaVersion !== 1) throw new Error("Computation sample is invalid");
  positiveInteger(sample.units, "Sample units");
  positiveInteger(sample.elapsedMs, "Sample elapsed time");
  positiveInteger(sample.projectedUnits, "Projected units");
  positiveInteger(sample.shardUnits, "Shard units");
  positiveNumber(sample.throughputPerSecond, "Measured throughput");
  positiveNumber(sample.projectedDurationMs, "Projected duration");
  positiveNumber(sample.measuredShardMs, "Measured shard time");
  timestamp(sample.recordedAt, "sample time");
  return sample;
}
export function readSample(directory: string): SampleRecord {
  return parseSample(readJson(join(directory, "sample.json")));
}

function assertPlan(manifest: ComputationManifest): void {
  let cursor = 0;
  manifest.shards.forEach((shard, offset) => {
    if (shard.index !== offset + 1 || !isRange(shard.range) || shard.range.start !== cursor) throw new Error("Computation shard plan is invalid");
    cursor = shard.range.end;
  });
  if (!manifest.shards.length || cursor !== manifest.totalUnits) throw new Error("Computation shard plan does not cover the projected units");
}
function parseManifest(value: unknown): ComputationManifest {
  if (!value || typeof value !== "object") throw new Error("Computation manifest is invalid");
  const manifest = value as ComputationManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.shards)) throw new Error("Computation manifest is invalid");
  identifier(manifest.id, "id");
  identifier(manifest.run, "run");
  identifier(manifest.session, "session");
  positiveInteger(manifest.totalUnits, "Total units");
  positiveInteger(manifest.shardUnits, "Shard units");
  positiveNumber(manifest.stallMultiple, "Stall multiple");
  positiveNumber(manifest.measuredShardMs, "Measured shard time");
  timestamp(manifest.openedAt, "computation open time");
  manifest.sample = parseSample(manifest.sample);
  assertPlan(manifest);
  return manifest;
}
export function readManifest(directory: string): ComputationManifest {
  const manifest = parseManifest(readJson(join(directory, "manifest.json")));
  if (basename(directory) !== manifest.id) throw new Error("Computation id does not match its evidence directory");
  return manifest;
}
export function openComputation(directory: string, input: {
  id: string; run: string; session: string; totalUnits: number; shardUnits: number; stallMultiple: number;
}, now?: () => number): ComputationManifest {
  const manifestPath = join(directory, "manifest.json");
  if (existsSync(manifestPath)) return readManifest(directory);
  const sample = readSample(directory);
  const totalUnits = positiveInteger(input.totalUnits, "Total units");
  const shardUnits = positiveInteger(input.shardUnits, "Shard units");
  const stallMultiple = positiveNumber(input.stallMultiple, "Stall multiple");
  if (totalUnits !== sample.projectedUnits || shardUnits !== sample.shardUnits) {
    throw new Error("Computation plan must match the recorded sample projection");
  }
  const manifest: ComputationManifest = {
    schemaVersion: 1, id: identifier(input.id, "id"), run: identifier(input.run, "run"),
    session: identifier(input.session, "session"), totalUnits, shardUnits, stallMultiple,
    measuredShardMs: sample.measuredShardMs, openedAt: iso(now), sample,
    shards: planShards(totalUnits, shardUnits),
  };
  if (basename(directory) !== manifest.id) throw new Error("Computation id must match its evidence directory name");
  assertPlan(manifest);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicJson(manifestPath, manifest);
  atomicJson(join(directory, "state.json"), { schemaVersion: 1, state: "running" });
  return manifest;
}

function parseCheckpoint(value: unknown): ShardCheckpoint {
  if (!value || typeof value !== "object") throw new Error("Shard checkpoint is invalid");
  const checkpoint = value as ShardCheckpoint;
  if (checkpoint.schemaVersion !== 1 || !isRange(checkpoint.range) || typeof checkpoint.output !== "string") throw new Error("Shard checkpoint is invalid");
  positiveInteger(checkpoint.index, "Shard index");
  timestamp(checkpoint.completedAt, "shard completion time");
  return checkpoint;
}
export function readCompleted(directory: string, manifest = readManifest(directory)): ShardCheckpoint[] {
  const shardDir = join(directory, "shards");
  if (!existsSync(shardDir)) return [];
  const planned = new Map(manifest.shards.map(shard => [shard.index, shard]));
  const completed: ShardCheckpoint[] = [];
  for (const name of readdirSync(shardDir)) {
    if (!/^[1-9]\d*\.json$/.test(name)) throw new Error(`Unexpected shard evidence ${name}`);
    const checkpoint = parseCheckpoint(readJson(join(shardDir, name)));
    const shard = planned.get(checkpoint.index);
    if (!shard || shard.range.start !== checkpoint.range.start || shard.range.end !== checkpoint.range.end || name !== `${checkpoint.index}.json`) {
      throw new Error(`Shard ${checkpoint.index} checkpoint does not match the computation plan`);
    }
    completed.push(checkpoint);
  }
  return completed.sort((left, right) => left.index - right.index);
}
export function nextShard(manifest: ComputationManifest, completed: ShardCheckpoint[]): PlannedShard | undefined {
  const done = new Set(completed.map(shard => shard.index));
  return manifest.shards.find(shard => !done.has(shard.index));
}
function writeCheckpoint(directory: string, checkpoint: ShardCheckpoint): void {
  const path = join(directory, "shards", `${checkpoint.index}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const current = parseCheckpoint(readJson(path));
    if (current.index !== checkpoint.index || current.range.start !== checkpoint.range.start || current.range.end !== checkpoint.range.end || current.output !== checkpoint.output) {
      throw new Error(`Shard ${checkpoint.index} output is already preserved`);
    }
    return;
  }
  atomicJson(path, checkpoint);
}
export function progressOf(manifest: ComputationManifest, completed: ShardCheckpoint[]): ProgressRecord {
  const lastShard = completed.length ? completed[completed.length - 1] : undefined;
  const progress: ProgressRecord = { schemaVersion: 1, completed: completed.length, total: manifest.shards.length };
  if (lastShard) progress.lastShard = lastShard;
  return progress;
}
function readState(directory: string): ComputationState {
  if (!existsSync(join(directory, "state.json"))) return "running";
  const value = readJson(join(directory, "state.json")) as { schemaVersion?: number; state?: string };
  if (value.schemaVersion !== 1 || (value.state !== "running" && value.state !== "completed" && value.state !== "stopped")) {
    throw new Error("Computation state is invalid");
  }
  return value.state;
}
function writeState(directory: string, state: ComputationState): void {
  atomicJson(join(directory, "state.json"), { schemaVersion: 1, state });
}
export function writeProgress(directory: string, progress: ProgressRecord): void {
  atomicJson(join(directory, "progress.json"), progress);
}

function parseDecision(value: unknown): OwnerDecision {
  if (!value || typeof value !== "object") throw new Error("Computation decision is invalid");
  const decision = value as OwnerDecision;
  if (decision.schemaVersion !== 1 || !["continue", "resize", "stop"].includes(decision.decision)) throw new Error("Computation decision is invalid");
  timestamp(decision.decidedAt, "decision time");
  if (decision.decision === "resize") decision.stallMultiple = positiveNumber(decision.stallMultiple ?? Number.NaN, "Resized stall multiple");
  else if (decision.stallMultiple !== undefined) throw new Error("stallMultiple is only valid for resize");
  return decision;
}
export function writeDecision(directory: string, input: { decision: OwnerDecision["decision"]; stallMultiple?: number }, now?: () => number): OwnerDecision {
  const path = join(directory, "decision.json");
  if (existsSync(path)) throw new Error("A computation decision is already waiting");
  const record: OwnerDecision = { schemaVersion: 1, decision: input.decision, decidedAt: iso(now) };
  if (input.decision === "resize") {
    if (input.stallMultiple === undefined) throw new Error("resize requires stallMultiple");
    record.stallMultiple = positiveNumber(input.stallMultiple, "Resized stall multiple");
  } else if (input.stallMultiple !== undefined) throw new Error("stallMultiple is only valid for resize");
  atomicJson(path, record);
  return record;
}
function archive(directory: string, name: string, stamp: string): void {
  const history = join(directory, "history");
  mkdirSync(history, { recursive: true, mode: 0o700 });
  renameSync(join(directory, name), join(history, `${name.replace(/\.json$/, "")}-${stamp.replace(/[:.]/g, "")}.json`));
}

interface WatchFile { schemaVersion: 1; anchor: string }
function readWatch(directory: string, fallback: string): WatchFile {
  const path = join(directory, "watch.json");
  if (!existsSync(path)) return { schemaVersion: 1, anchor: fallback };
  const value = readJson(path) as WatchFile;
  if (value?.schemaVersion !== 1) throw new Error("Computation watch state is invalid");
  return { schemaVersion: 1, anchor: timestamp(value.anchor, "watch anchor") };
}
function latestAnchor(manifest: ComputationManifest, completed: ShardCheckpoint[]): string {
  const latest = completed.reduce((max, shard) => Math.max(max, Date.parse(shard.completedAt)), Date.parse(manifest.openedAt));
  return new Date(latest).toISOString();
}
export function parseStallNotice(value: unknown): StallNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const notice = value as StallNotice;
  if (notice.schemaVersion !== 1 || typeof notice.session !== "string" || typeof notice.computation !== "string"
    || typeof notice.directory !== "string" || typeof notice.notifiedAt !== "string" || !Number.isFinite(Date.parse(notice.notifiedAt))
    || !notice.progress || notice.progress.schemaVersion !== 1 || !Number.isSafeInteger(notice.progress.completed)
    || !Number.isSafeInteger(notice.progress.total) || !Number.isFinite(notice.measuredShardMs) || !Number.isFinite(notice.stallMultiple)
    || !Number.isFinite(notice.deadlineMs)) return undefined;
  const last = notice.progress.lastShard;
  if (last !== undefined && (last.schemaVersion !== 1 || !isRange(last.range) || typeof last.completedAt !== "string" || typeof last.output !== "string")) return undefined;
  return notice;
}
export function appendStallNotice(evidenceDir: string, notice: StallNotice): void {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const path = join(evidenceDir, "stall-notices.jsonl");
  const line = `${JSON.stringify(notice)}\n`;
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.split("\n").some(entry => {
    if (!entry) return false;
    try { return parseStallNotice(JSON.parse(entry))?.notifiedAt === notice.notifiedAt; } catch { return false; }
  })) return;
  appendFileSync(path, line, { mode: 0o600 });
}
function readStall(directory: string): StallNotice | undefined {
  const path = join(directory, "stall.json");
  if (!existsSync(path)) return undefined;
  const notice = parseStallNotice(readJson(path));
  if (!notice) throw new Error("Computation stall notice is invalid");
  return notice;
}
function createStall(directory: string, notice: StallNotice): boolean {
  const path = join(directory, "stall.json");
  try {
    writeFileSync(path, `${JSON.stringify(notice, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await delay(ms, undefined, { signal }).catch(() => undefined);
}
export async function superviseComputation(directory: string, options: ComputationClock & {
  signal?: AbortSignal;
  notify?: (notice: StallNotice) => void | Promise<void>;
} = {}): Promise<"completed" | "stopped" | "detached"> {
  const signal = options.signal ?? new AbortController().signal;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 200;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error("Computation poll interval must be positive");
  let appliedDecisionAt = "";
  while (!signal.aborted) {
    const manifest = readManifest(directory);
    const state = readState(directory);
    const completed = readCompleted(directory, manifest);
    const progress = progressOf(manifest, completed);
    writeProgress(directory, progress);
    if (state === "stopped") return "stopped";
    if (state === "completed" || completed.length === manifest.shards.length) {
      if (state !== "completed") writeState(directory, "completed");
      return "completed";
    }
    const stall = readStall(directory);
    const decisionPath = join(directory, "decision.json");
    if (stall && existsSync(decisionPath)) {
      const decision = parseDecision(readJson(decisionPath));
      if (decision.decidedAt === appliedDecisionAt) throw new Error("Computation decision was already applied");
      if (decision.decision === "resize") {
        const resized = { ...manifest, stallMultiple: decision.stallMultiple! };
        atomicJson(join(directory, "manifest.json"), resized);
      }
      if (decision.decision === "stop") {
        stopWorker(directory);
        writeState(directory, "stopped");
      }
      const anchor = decision.decision === "stop" ? readWatch(directory, latestAnchor(manifest, completed)).anchor : iso(options.now);
      atomicJson(join(directory, "watch.json"), { schemaVersion: 1, anchor });
      archive(directory, "stall.json", stall.notifiedAt);
      archive(directory, "decision.json", decision.decidedAt);
      appliedDecisionAt = decision.decidedAt;
      if (decision.decision === "stop") return "stopped";
      continue;
    }
    const anchor = readWatch(directory, latestAnchor(manifest, completed)).anchor;
    const advanced = latestAnchor(manifest, completed);
    const effective = !stall && Date.parse(advanced) > Date.parse(anchor) ? advanced : anchor;
    if (effective !== anchor) atomicJson(join(directory, "watch.json"), { schemaVersion: 1, anchor: effective });
    const deadlineMs = manifest.measuredShardMs * manifest.stallMultiple;
    if (!stall && clockNow(options.now) - Date.parse(effective) > deadlineMs) {
      const notice: StallNotice = {
        schemaVersion: 1, session: manifest.session, computation: manifest.id, directory,
        progress, measuredShardMs: manifest.measuredShardMs, stallMultiple: manifest.stallMultiple,
        deadlineMs, notifiedAt: iso(options.now),
      };
      if (createStall(directory, notice)) {
        appendStallNotice(runEvidenceForComputation(directory), notice);
        if (options.notify) await options.notify(notice);
      }
    }
    await sleep(pollMs, signal);
  }
  return "detached";
}

export async function superviseRunComputations(options: ComputationClock & {
  evidenceDir: string;
  session: string;
  signal: AbortSignal;
  notify?: (notice: StallNotice) => void | Promise<void>;
}): Promise<void> {
  const tasks = new Map<string, Promise<void>>();
  const children = new Map<string, AbortController>();
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 200;
  try {
    while (!options.signal.aborted) {
      const root = join(options.evidenceDir, "computations");
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          const directory = join(root, name);
          if (tasks.has(directory) || !existsSync(join(directory, "manifest.json"))) continue;
          let manifest: ComputationManifest;
          try { manifest = readManifest(directory); } catch (error) {
            console.error(`ROLE_JOB_COMPUTATION ${error instanceof Error ? error.message : String(error)}`);
            tasks.set(directory, Promise.resolve());
            continue;
          }
          if (manifest.session !== options.session) continue;
          const child = new AbortController();
          children.set(directory, child);
          tasks.set(directory, superviseComputation(directory, {
            signal: child.signal, pollMs, ...(options.now ? { now: options.now } : {}),
            ...(options.sleep ? { sleep: options.sleep } : {}),
            ...(options.notify ? { notify: options.notify } : {}),
          }).then(() => undefined, error => {
            console.error(`ROLE_JOB_COMPUTATION ${error instanceof Error ? error.message : String(error)}`);
          }));
        }
      }
      await sleep(pollMs, options.signal);
    }
  } finally {
    for (const child of children.values()) child.abort();
    await Promise.all([...tasks.values()]);
  }
}

function processStart(pid: number): string | undefined {
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return started || undefined;
  } catch { return undefined; }
}
interface WorkerIdentity { schemaVersion: 1; pid: number; processStartedAt: string }
function readWorker(directory: string): WorkerIdentity | undefined {
  const path = join(directory, "worker.json");
  if (!existsSync(path)) return undefined;
  const worker = readJson(path) as WorkerIdentity;
  if (worker?.schemaVersion !== 1 || !Number.isSafeInteger(worker.pid) || worker.pid < 1 || typeof worker.processStartedAt !== "string") {
    throw new Error("Computation worker identity is invalid");
  }
  return worker;
}
export function workerAlive(directory: string): boolean {
  const worker = readWorker(directory);
  return worker !== undefined && processStart(worker.pid) === worker.processStartedAt;
}
export function stopWorker(directory: string): void {
  const worker = readWorker(directory);
  if (!worker || processStart(worker.pid) !== worker.processStartedAt) return;
  try { process.kill(worker.pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function writeWorker(directory: string): void {
  const processStartedAt = processStart(process.pid);
  if (!processStartedAt) throw new Error("Computation worker could not record its process start");
  atomicJson(join(directory, "worker.json"), { schemaVersion: 1, pid: process.pid, processStartedAt });
}

export async function runShards(directory: string, runShard: (shard: PlannedShard, signal: AbortSignal) => Promise<string>, signal: AbortSignal): Promise<"completed" | "interrupted"> {
  const state = readState(directory);
  if (state === "stopped") throw new Error("Stopped computation cannot resume; completed shards are preserved");
  if (state === "completed") return "completed";
  while (!signal.aborted) {
    const manifest = readManifest(directory);
    const next = nextShard(manifest, readCompleted(directory, manifest));
    if (!next) {
      writeState(directory, "completed");
      return "completed";
    }
    atomicJson(join(directory, "resume.json"), { schemaVersion: 1, index: next.index, recordedAt: new Date().toISOString() });
    let output: string;
    try {
      output = await runShard(next, signal);
    } catch (error) {
      if (signal.aborted) return "interrupted";
      throw error;
    }
    if (signal.aborted) return "interrupted";
    writeCheckpoint(directory, {
      schemaVersion: 1, index: next.index, range: next.range, completedAt: new Date().toISOString(), output,
    });
    writeProgress(directory, progressOf(manifest, readCompleted(directory, manifest)));
  }
  return "interrupted";
}

export async function computationCommand(args: string[], options: { script: string }): Promise<void> {
  const [command, ...rest] = args;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--") || token === "--") throw new Error(`Unexpected computation argument ${token}`);
    const name = token.slice(2);
    if (name === "background") {
      if (flags.has(name)) throw new Error("Duplicate --background");
      flags.set(name, "true");
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    if (flags.has(name)) throw new Error(`Duplicate --${name}`);
    flags.set(name, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = flags.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };
  const integer = (name: string, allowZero = false): number => {
    const raw = required(name);
    if (!(allowZero ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(raw)) throw new Error(`--${name} must be a positive integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be a positive integer`);
    return value;
  };
  const directory = (): string => {
    const requested = required("dir");
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    return realpathSync(requested);
  };
  if (command === "sample") {
    console.log(JSON.stringify(recordSample(directory(), {
      units: integer("units"), elapsedMs: integer("elapsed-ms"), projectedUnits: integer("projected-units"), shardUnits: integer("shard-units"),
    })));
    return;
  }
  if (command === "open") {
    console.log(JSON.stringify(openComputation(directory(), {
      id: required("id"), run: required("run"), session: required("session"),
      totalUnits: integer("total-units"), shardUnits: integer("shard-units"), stallMultiple: Number(required("stall-multiple")),
    })));
    return;
  }
  if (command === "decide") {
    const decision = required("decision");
    if (decision !== "continue" && decision !== "resize" && decision !== "stop") throw new Error("Decision must be continue, resize, or stop");
    const stallMultiple = flags.has("stall-multiple") ? Number(required("stall-multiple")) : undefined;
    console.log(JSON.stringify(writeDecision(directory(), stallMultiple === undefined ? { decision } : { decision, stallMultiple })));
    return;
  }
  if (command === "supervise") {
    const result = await superviseComputation(directory(), { notify: notice => { console.error(`ROLE_JOB_STALL ${JSON.stringify(notice)}`); } });
    console.log(JSON.stringify({ state: result }));
    return;
  }
  if (command !== "run") throw new Error("Usage: dagu-role-jobs computation sample|open|run|supervise|decide");
  const dir = directory();
  if (flags.get("background") === "true") {
    if (workerAlive(dir)) {
      console.log(JSON.stringify({ state: "running", worker: readWorker(dir) }));
      return;
    }
    rmSync(join(dir, "worker.json"), { force: true });
    const forwarded = rest.filter(token => token !== "--background");
    const runtime = process.execArgv.filter((token, index, all) => token !== "--test" && !token.startsWith("--test-") && all[index - 1] !== "--test-reporter" && all[index - 1] !== "--test-name-pattern" && all[index - 1] !== "--test-skip-pattern");
    const log = openSync(join(dir, "worker.log"), "a", 0o600);
    const child = spawn(process.execPath, [...runtime, options.script, "computation", "run", ...forwarded], {
      detached: true, stdio: ["ignore", log, log], env: { ...process.env, A4S_COMPUTATION_WORKER: "1" },
    });
    child.unref();
    closeSync(log);
    if (!child.pid) throw new Error("Computation worker failed to start");
    const pid = child.pid;
    for (let attempt = 0; attempt < 50 && readWorker(dir)?.pid !== pid; attempt += 1) await delay(20);
    if (readWorker(dir)?.pid !== pid || !workerAlive(dir)) throw new Error(`Computation worker failed to start; see ${join(dir, "worker.log")}`);
    console.log(JSON.stringify({ state: "running", worker: readWorker(dir) }));
    return;
  }
  writeWorker(dir);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const delayMs = flags.has("delay-ms") ? integer("delay-ms", true) : undefined;
  const commandText = flags.get("command");
  const stallShard = flags.has("stall-shard") ? integer("stall-shard") : undefined;
  if (delayMs === undefined && !commandText) throw new Error("computation run requires --delay-ms or --command");
  if (delayMs !== undefined && commandText) throw new Error("computation run accepts either --delay-ms or --command");
  const result = await runShards(dir, async (shard, signal) => {
    if (stallShard === shard.index) {
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error("aborted"));
        else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (delayMs !== undefined) {
      await delay(delayMs, undefined, { signal });
      return `shard ${shard.index} complete\n`;
    }
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("bash", ["-lc", commandText!], {
        env: {
          ...process.env, A4S_SHARD_INDEX: String(shard.index), A4S_SHARD_START: String(shard.range.start),
          A4S_SHARD_END: String(shard.range.end), A4S_COMPUTATION_DIR: dir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const kill = (): void => { child.kill("SIGTERM"); };
      signal.addEventListener("abort", kill, { once: true });
      child.once("close", code => {
        signal.removeEventListener("abort", kill);
        if (signal.aborted) reject(new Error("aborted"));
        else if (code === 0) resolve(stdout);
        else reject(new Error(`Shard ${shard.index} command exited ${code}: ${stderr}`));
      });
    });
    return output;
  }, controller.signal);
  const manifest = readManifest(dir);
  const next = nextShard(manifest, readCompleted(dir, manifest));
  console.log(JSON.stringify({ state: result, nextIndex: next?.index ?? null }));
}
