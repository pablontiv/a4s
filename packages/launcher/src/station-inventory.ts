import { readServiceEnvironment } from "./service-environment.ts";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DatabaseSync } from "node:sqlite";
import { CONFIG_PATH, CONFIG_SCHEMA_VERSION, readCommittedConfig } from "./config.ts";
import { isRecord } from "./type-guard.ts";
import { tupleFromJson, readJsonFile, stationRoot, type PersistedFormats } from "./station-state.ts";
import type { ArtifactTuple } from "./release.ts";
import { primaryFromSpec } from "./primary.ts";
import { SHARED_FORMATS, type SharedFormat } from "./contracts.ts";
import { TICK_DAG, validateTickBinding, type TickBinding } from "./tick-binding.ts";

export interface StationRun { name: string; dagRunId: string; statusLabel: string; primary?: string; retryable?: boolean }
export interface BuildReference { artifact: ArtifactTuple; holder: string }
export type { TickBinding } from "./tick-binding.ts";
export interface InventoryDependencies {
  primaries?: (home: string) => string[];
  gitPath?: (primary: string) => string;
  configVersion?: (primary: string) => number;
  listRuns?: () => Promise<StationRun[]>;
  bindingRun?: (binding: TickBinding) => Promise<StationRun | undefined>;
  now?: () => number;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function names(directory: string): string[] {
  try {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error(`Inventory directory must be real: ${directory}`);
    return readdirSync(directory);
  } catch (error) { if (missing(error)) return []; throw error; }
}
export function registeredPrimaries(home: string): string[] {
  const paths: string[] = [];
  const add = (value: string) => {
    const path = value.replace(/\n$/, "");
    if (!isAbsolute(path) || path !== path.trim() || /[\r\n\0$]/.test(path)) throw new Error("Invalid registered PRIMARY");
    paths.push(realpathSync(path));
  };
  if (process.env.A4S_PRIMARY) add(process.env.A4S_PRIMARY);
  try { add(readFileSync(join(home, "a4s-primary"), "utf8")); } catch (error) { if (!missing(error)) throw error; }
  for (const name of names(join(home, "primaries"))) add(readFileSync(join(home, "primaries", name), "utf8"));
  return [...new Set(paths)];
}
/** Resolve native PRIMARY/worktree Git metadata without spawning under .state.lock. */
function gitDirectories(primary: string, track: (path: string) => void = () => {}): { directory: string; common: string } {
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_REPLACE_REF_BASE"]) {
    if (process.env[key] !== undefined) throw new Error(`Cannot establish inventory inputs with ${key} overridden; retry without Git path overrides`);
  }
  const dotGit = join(primary, ".git");
  track(dotGit);
  const stat = lstatSync(dotGit);
  let directory = dotGit;
  if (stat.isFile()) {
    const match = /^gitdir: ([^\r\n\0]+)\n?$/.exec(readFileSync(dotGit, "utf8"));
    if (!match) throw new Error(`Unreadable PRIMARY gitdir ${dotGit}`);
    directory = resolve(primary, match[1]!);
  } else if (!stat.isDirectory()) throw new Error(`PRIMARY gitdir must be real: ${dotGit}`);
  directory = realpathSync(directory);
  const commonFile = join(directory, "commondir");
  track(commonFile);
  let common = directory;
  try {
    const value = readFileSync(commonFile, "utf8").replace(/\n$/, "");
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`Unreadable PRIMARY commondir ${commonFile}`);
    common = realpathSync(resolve(directory, value));
  } catch (error) { if (!missing(error)) throw error; }
  return { directory, common };
}
function gitPath(primary: string): string { return join(gitDirectories(primary).directory, "dagu-feature"); }
const activeStatuses: Record<string, true> = { queued: true, waiting: true, running: true, recoverable: true, retrying: true, not_started: true };
const terminalStatuses: Record<string, true> = { succeeded: true, failed: true, aborted: true, cancelled: true, partially_succeeded: true, rejected: true };
const resumableStatuses: Record<string, true> = { failed: true, aborted: true, partially_succeeded: true };
export function nonterminal(run: StationRun): boolean {
  const status = run.statusLabel.toLowerCase();
  if (!activeStatuses[status] && !terminalStatuses[status]) throw new Error(`Unknown Dagu status ${run.statusLabel}`);
  return !!activeStatuses[status] || run.retryable === true;
}
async function api(path: string, signal = AbortSignal.timeout(15000), endpoint = readServiceEnvironment().DAGU_URL): Promise<Response> {
  return fetch(`${endpoint}/api/v1/${path}`, { signal });
}
/** All DAGs, all history pages: page size is never a retention limit. */
export async function listStationRuns(home = readServiceEnvironment().DAGU_HOME, limit = 100): Promise<StationRun[]> {
  return readStationRuns(home, limit, true);
}
/** Only aggregate list endpoints: prepare status proofs without per-run requests. */
export async function listStationRunSummaries(home = readServiceEnvironment().DAGU_HOME, limit = 1000, signal?: AbortSignal): Promise<StationRun[]> {
  return readStationRuns(home, limit, false, signal);
}
async function readStationRuns(home: string, limit: number, details: boolean, signal?: AbortSignal): Promise<StationRun[]> {
  const endpoint = readServiceEnvironment({ ...process.env, DAGU_HOME: home }).DAGU_URL;
  const runs: StationRun[] = [];
  const seen = new Set<string>();
  // Cursor filters stay fixed. Dagu's second-resolution upper bound must cover
  // the whole current second, including native subsecond creation timestamps.
  const toDate = String(Math.floor(Date.now() / 1000) + 1);
  let cursor = "";
  for (;;) {
    const params = new URLSearchParams({ fromDate: "0", toDate, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const response = await api(`dag-runs?${params}`, signal, endpoint);
    if (!response.ok) throw new Error(`Dagu inventory HTTP ${response.status}`);
    const page: unknown = await response.json();
    if (!isRecord(page) || !Array.isArray(page.dagRuns)) throw new Error("Malformed Dagu inventory page");
    for (const row of page.dagRuns) {
      if (!isRecord(row) || typeof row.name !== "string" || !row.name || typeof row.dagRunId !== "string" || !row.dagRunId || typeof row.statusLabel !== "string") throw new Error("Malformed Dagu run");
      const run: StationRun = { name: row.name, dagRunId: row.dagRunId, statusLabel: row.statusLabel, retryable: row.retryable === true };
      const workspace = typeof row.workspace === "string" && row.workspace ? `?workspace=${encodeURIComponent(row.workspace)}` : "";
      // Dagu 2.24 exposes pending resumes only in details, not in list summaries.
      // Failed/aborted/partial runs may therefore still be recoverable readers.
      if (details && resumableStatuses[run.statusLabel.toLowerCase()]) {
        const detailResponse = await api(`dag-runs/${encodeURIComponent(run.name)}/${encodeURIComponent(run.dagRunId)}${workspace}`, undefined, endpoint);
        if (!detailResponse.ok) throw new Error(`Dagu recovery inventory HTTP ${detailResponse.status}`);
        const detail: unknown = await detailResponse.json();
        if (!isRecord(detail) || !isRecord(detail.dagRunDetails)) throw new Error("Malformed Dagu recovery details");
        const data = detail.dagRunDetails;
        run.retryable = run.retryable || data.humanTaskResumePending === true || data.approvalResumePending === true ||
          run.statusLabel.toLowerCase() === "failed" && typeof row.autoRetryLimit === "number" &&
          (typeof row.autoRetryCount !== "number" || row.autoRetryCount < row.autoRetryLimit);
      }
      // Resolve from the immutable spec, not from today's DAG file or a label guess.
      if (details && nonterminal(run)) {
        const specResponse = await api(`dag-runs/${encodeURIComponent(run.name)}/${encodeURIComponent(run.dagRunId)}/spec${workspace}`, undefined, endpoint);
        if (!specResponse.ok) throw new Error(`Dagu spec inventory HTTP ${specResponse.status}`);
        const spec: unknown = await specResponse.json();
        if (!isRecord(spec) || typeof spec.spec !== "string") throw new Error("Malformed Dagu run spec");
        const primary = primaryFromSpec(spec.spec, { ...process.env, DAGU_HOME: home });
        if (primary) run.primary = realpathSync(primary);
      }
      runs.push(run);
    }
    if (page.nextCursor === undefined) break;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor)) throw new Error("Repeated or invalid Dagu inventory cursor; refusing partial inventory");
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  return runs;
}
/** Only the exact native run-detail unknown result authorizes binding deletion. */
export async function bindingRun(binding: TickBinding): Promise<StationRun | undefined> {
  const response = await api(`dag-runs/${TICK_DAG}/${encodeURIComponent(binding.dagRunId)}`);
  if (!response.headers.get("content-type")?.split(";")[0]?.trim().match(/^application\/json$/i)) throw new Error(`Cannot establish tick binding history: non-JSON HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (response.ok && isRecord(value) && isRecord(value.dagRunDetails)) {
    const detail = value.dagRunDetails;
    if (detail.name === TICK_DAG && detail.dagRunId === binding.dagRunId && typeof detail.statusLabel === "string") {
      const run = { name: TICK_DAG, dagRunId: binding.dagRunId, statusLabel: detail.statusLabel,
        retryable: detail.humanTaskResumePending === true || detail.approvalResumePending === true ||
          detail.statusLabel === "failed" && typeof detail.autoRetryLimit === "number" &&
          (typeof detail.autoRetryCount !== "number" || detail.autoRetryCount < detail.autoRetryLimit) };
      nonterminal(run);
      return run;
    }
  }
  if (response.status === 404 && isRecord(value) && value.code === "not_found" &&
      value.message === `dag-run ID ${binding.dagRunId} not found for DAG ${TICK_DAG}`) return undefined;
  throw new Error(`Cannot establish tick binding history: HTTP ${response.status}`);
}
export function readTickBindings(home: string): Array<{ path: string; binding: TickBinding }> {
  const directory = join(stationRoot(home), "ticks");
  return names(directory).filter(name => !/\.json\.[a-f0-9-]+\.tmp$/.test(name)).flatMap(name => {
    if (!name.endsWith(".json")) throw new Error(`Unknown tick binding file ${name}`);
    const path = join(directory, name);
    let value: unknown;
    try { value = readJsonFile(path); } catch (error) { if (missing(error)) return []; throw error; }
    const binding = validateTickBinding(value, name.slice(0, -5));
    return [{ path, binding }];
  });
}
interface ReceiptEntry { value: Record<string, unknown>; primary: string; dag: string; run: string; artifact?: ArtifactTuple; created: number; cancelled: boolean; changed: boolean }
interface CachedDecisionInput { stamp: string; value: unknown; changed: boolean }
interface InventoryReadContext {
  checkDeadline?: () => void;
  receiptCache?: Map<string, CachedDecisionInput>;
  rechecking?: boolean;
  previousTicks?: ReadonlyMap<string, TickBinding>;
}
function inputStamp(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function receiptFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const contracts = isRecord(value.contracts) ? value.contracts : undefined;
  return { schemaVersion: value.schemaVersion, artifact: value.artifact, receiptCreatedAt: value.receiptCreatedAt,
    contracts: contracts ? Object.fromEntries(SHARED_FORMATS.map(name => [name, contracts[name]])) : value.contracts,
    initial: isRecord(value.initial) ? { admittedAt: value.initial.admittedAt } : value.initial,
    runReceipt: isRecord(value.runReceipt) ? { dag: value.runReceipt.dag, run: value.runReceipt.run } : value.runReceipt };
}
function cancellationFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { run: value.run, outcome: value.outcome,
    cleanup: isRecord(value.cleanup) ? { admissionReleased: value.cleanup.admissionReleased } : value.cleanup };
}
/** Metadata is a refresh hint, never an abort criterion. Only changed receipts
 * are parsed in steady-state rechecks; counters and observations are discarded. */
function readDecisionInput(path: string, cache: Map<string, CachedDecisionInput> | undefined, project: (value: unknown) => unknown, rechecking: boolean): unknown {
  if (!cache) return project(readJsonFile(path));
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error(`Station runtime file must be regular: ${path}`);
  const cached = cache.get(path);
  if (cached?.stamp === inputStamp(stat)) return cached.value;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`Station runtime file must be regular: ${path}`);
    const value = project(JSON.parse(readFileSync(fd, "utf8")));
    if (inputStamp(before) !== inputStamp(fstatSync(fd, { bigint: true }))) throw new Error(`Station runtime input changed while reading ${path}; retry`);
    cache.set(path, { stamp: inputStamp(before), value, changed: rechecking });
    return value;
  } finally { closeSync(fd); }
}
// Covers receipt publication before enqueue becomes visible. Live admission
// processes also hold leases; absent history alone must not pin builds for days.
const PENDING_ADMISSION_WINDOW_MS = 5 * 60 * 1000;
export interface StationInventory { formats: Partial<PersistedFormats>; references: BuildReference[]; expiredBindings: string[]; runs?: StationRun[] }
/** Read-only inventory; every error propagates before the caller can delete anything. */
export async function inventoryStation(home: string, dependencies: InventoryDependencies = {}, includeRuns = true, conservativeGc = false, { checkDeadline = () => {}, receiptCache, rechecking = false, previousTicks }: InventoryReadContext = {}): Promise<StationInventory> {
  const versions = Object.fromEntries(SHARED_FORMATS.map(name => [name, new Set<number>()])) as Record<SharedFormat, Set<number>>;
  const add = (name: SharedFormat, value: unknown) => {
    checkDeadline();
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Unrecognized persisted ${name} version`);
    versions[name].add(Number(value));
  };
  const references: BuildReference[] = [], receipts: ReceiptEntry[] = [];
  const primaries = (dependencies.primaries ?? registeredPrimaries)(home);
  for (const primary of primaries) {
    add("config", (dependencies.configVersion ?? (p => readCommittedConfig(p).config.schemaVersion))(primary));
    const directory = (dependencies.gitPath ?? gitPath)(primary);
    if (names(directory).length) add("runState", 1); // Historical unversioned run-state decoder.
    for (const run of names(join(directory, "runs"))) {
      checkDeadline();
      const path = join(directory, "runs", run, "receipt.json");
      let value: unknown;
      try { value = readDecisionInput(path, receiptCache, receiptFields, rechecking); } catch (error) { if (missing(error)) continue; throw error; }
      if (!isRecord(value) || !isRecord(value.runReceipt) || typeof value.runReceipt.dag !== "string" || value.runReceipt.run !== run || !isRecord(value.initial)) throw new Error(`Unreadable run receipt ${run}`);
      add("receipt", value.schemaVersion);
      const contracts = isRecord(value.contracts) ? value.contracts : undefined;
      if (contracts) for (const name of SHARED_FORMATS) if (contracts[name] !== undefined) add(name, contracts[name]);
      const created = Date.parse(String(value.receiptCreatedAt ?? value.initial.admittedAt));
      if (!Number.isFinite(created)) throw new Error(`Missing receipt creation time ${run}`);
      let cancellation: unknown;
      try { cancellation = readDecisionInput(join(directory, "runs", run, "cancellation.json"), receiptCache, cancellationFields, rechecking); } catch (error) { if (!missing(error)) throw error; }
      const cancelled = isRecord(cancellation) && cancellation.run === run && cancellation.outcome === "cancelled" && isRecord(cancellation.cleanup) && cancellation.cleanup.admissionReleased === true;
      receipts.push({ value, primary, dag: value.runReceipt.dag, run, created, cancelled, changed: receiptCache?.get(path)?.changed === true, ...(value.artifact ? { artifact: tupleFromJson(value.artifact) } : {}) });
      // PR checkpoint protocol 1 used unversioned marker files; never rewrite them.
      if (names(join(directory, "runs", run)).some(name => /^(?:pr|checkpoint|publication)(?:[.-]|$)/.test(name))) add("prCheckpoint", 1);
    }
  }
  const database = join(home, "role-jobs.sqlite");
  const openJobs: Array<{ repo: string; run: string; dag: string }> = [];
  if (existsSync(database)) {
    if (!lstatSync(database).isFile()) throw new Error("Role-job store must be regular");
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      db.exec("BEGIN"); // One read snapshot for schema, payload versions and open bindings.
      const schema = db.prepare("PRAGMA user_version").get();
      add("roleJobStore", Number(schema?.user_version) || 1); // Historical SQL schema 1 predates user_version.
      // Only schema declarations and open bindings affect station decisions.
      // Read through SQLite (including WAL), not database/sidecar timestamps.
      for (const row of db.prepare(`SELECT DISTINCT json_extract(document, '$.schemaVersion') AS version FROM jobs
        UNION SELECT DISTINCT json_extract(result, '$.schemaVersion') AS version FROM jobs WHERE result IS NOT NULL`).all()) add("roleJobPayload", row.version);
      for (const row of db.prepare(`SELECT json_extract(document, '$.binding.repo') AS repo,
        json_extract(document, '$.binding.run') AS run, json_extract(document, '$.binding.dag') AS dag FROM jobs WHERE result IS NULL`).all()) {
        checkDeadline();
        if (typeof row.repo !== "string" || typeof row.run !== "string" || typeof row.dag !== "string") throw new Error("Unreadable role-job binding");
        openJobs.push({ repo: realpathSync(row.repo), run: row.run, dag: row.dag });
      }
    } finally { db.close(); }
  }
  if (includeRuns) {
    const runs = await (dependencies.listRuns ? dependencies.listRuns() : listStationRuns(home));
    const runKey = (dag: string, run: string) => JSON.stringify([dag, run]);
    const runsByKey = new Map<string, StationRun[]>(), receiptsByKey = new Map<string, ReceiptEntry[]>();
    for (const run of runs) {
      nonterminal(run);
      const key = runKey(run.name, run.dagRunId), group = runsByKey.get(key);
      if (group) group.push(run); else runsByKey.set(key, [run]);
    }
    for (const receipt of receipts) {
      const key = runKey(receipt.dag, receipt.run), group = receiptsByKey.get(key);
      if (group) group.push(receipt); else receiptsByKey.set(key, [receipt]);
    }
    for (const run of runs) if (nonterminal(run)) {
      checkDeadline();
      const matching = (receiptsByKey.get(runKey(run.name, run.dagRunId)) ?? []).filter(receipt => !run.primary || receipt.primary === run.primary);
      if (!matching.length && run.primary && primaries.includes(run.primary)) throw new Error(`Nonterminal run has no receipt: ${run.name}/${run.dagRunId}`);
      for (const receipt of matching) {
        if (receipt.cancelled) continue;
        if (!receipt.artifact) throw new Error(`Unresolved nonterminal artifact ${receipt.run}`);
        references.push({ artifact: receipt.artifact, holder: `run ${run.name}/${run.dagRunId} ${run.statusLabel}` });
      }
    }
    const now = (dependencies.now ?? Date.now)();
    for (const receipt of receipts) {
      checkDeadline();
      if (!receipt.cancelled && !runsByKey.has(runKey(receipt.dag, receipt.run)) && now - receipt.created < PENDING_ADMISSION_WINDOW_MS) {
        // Pre-launcher receipts cannot name a cache reader. Existing runs and
        // open role jobs still require resolvable artifacts above and below.
        if (receipt.value.schemaVersion === 1 && !receipt.artifact) continue;
        if (!receipt.artifact) throw new Error(`Unresolved pending admission ${receipt.run}`);
        references.push({ artifact: receipt.artifact, holder: `pending admission ${receipt.dag}/${receipt.run}` });
      }
    }
    if (conservativeGc) for (const receipt of receipts) {
      if (receipt.cancelled || !receipt.artifact) continue;
      const matching = (runsByKey.get(runKey(receipt.dag, receipt.run)) ?? []).filter(run => !run.primary || run.primary === receipt.primary);
      // Absence is not terminal proof. Failed/aborted/partial summaries also
      // cannot prove that native pending-resume flags will remain clear.
      if (receipt.changed || !matching.length || matching.some(run => nonterminal(run) || resumableStatuses[run.statusLabel.toLowerCase()])) {
        references.push({ artifact: receipt.artifact, holder: `possible reader ${receipt.dag}/${receipt.run} ${receipt.changed ? "new or changed receipt" : matching.map(run => run.statusLabel).join(",") || "unlisted"}` });
      }
    }
    for (const job of openJobs) {
      const receipt = receiptsByKey.get(runKey(job.dag, job.run))?.find(receipt => receipt.primary === job.repo);
      if (!receipt?.artifact) throw new Error(`Unresolved open role job ${job.dag}/${job.run}`);
      references.push({ artifact: receipt.artifact, holder: `open role job ${job.dag}/${job.run}` });
    }
    const expiredBindings: string[] = [];
    for (const { path, binding } of readTickBindings(home)) {
      checkDeadline();
      if (conservativeGc && rechecking && !isDeepStrictEqual(previousTicks?.get(binding.dagRunId), binding)) {
        references.push({ artifact: binding.tuple, holder: `tick ${TICK_DAG}/${binding.dagRunId} new or changed binding` });
        continue;
      }
      const listed = runsByKey.get(runKey(TICK_DAG, binding.dagRunId));
      const readers = listed ?? [await (dependencies.bindingRun ?? bindingRun)(binding)].filter((run): run is StationRun => !!run);
      if (!readers.length) expiredBindings.push(path);
      else if (readers.some(run => nonterminal(run) || conservativeGc && resumableStatuses[run.statusLabel.toLowerCase()])) references.push({ artifact: binding.tuple, holder: `tick ${TICK_DAG}/${binding.dagRunId}` });
    }
    return { formats: Object.fromEntries(SHARED_FORMATS.map(name => [name, [...versions[name]]])) as Partial<PersistedFormats>, references, expiredBindings, runs };
  }
  return { formats: Object.fromEntries(SHARED_FORMATS.map(name => [name, [...versions[name]]])) as Partial<PersistedFormats>, references, expiredBindings: [] };
}

export interface InventoryInputs {
  primaries: string[];
  files: Array<[string, string | null]>;
  listings: Array<[string, string[]]>;
  configs: Array<[string, number]>;
  ticks: Array<{ path: string; binding: TickBinding }>;
  receiptCache: Map<string, CachedDecisionInput>;
}
/** Only committed-config inputs need an optimistic proof: decoding them uses
 * Git outside the lock. Receipt fields, SQL schemas and readers are re-derived. */
export async function captureInventoryInputs(home: string, dependencies: InventoryDependencies = {}, deadline = Infinity): Promise<InventoryInputs> {
  const checkDeadline = () => {
    if (performance.now() >= deadline) throw new Error("Inventory input capture deadline exceeded");
  };
  const files = new Map<string, string | null>(), listings = new Map<string, string[]>(), configs: Array<[string, number]> = [];
  const track = (path: string) => {
    checkDeadline();
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stat && !stat.isFile() && !stat.isDirectory()) throw new Error(`Inventory input must be a real file or directory: ${path}`);
    // Directory timestamps include unrelated observer/runtime activity.
    if (!stat?.isDirectory()) files.set(path, stat ? inputStamp(stat) : null);
  };
  const listing = (path: string) => {
    checkDeadline();
    const entries = names(path).sort();
    listings.set(path, entries);
    return entries;
  };
  const primaries = [...new Set((dependencies.primaries ?? registeredPrimaries)(home))].sort();
  for (const primary of primaries) {
    checkDeadline();
    if (dependencies.configVersion) configs.push([primary, dependencies.configVersion(primary)]);
    else {
      const { directory, common } = gitDirectories(primary, track);
      track(join(primary, CONFIG_PATH));
      track(join(directory, "index"));
      track(join(directory, "packed-refs")); track(join(common, "packed-refs"));
      track(join(common, "config")); track(join(directory, "config.worktree"));
      for (const base of new Set([common, directory])) {
        for (const name of listing(join(base, "reftable"))) track(join(base, "reftable", name));
      }
      for (const name of listing(join(common, "refs", "replace"))) track(join(common, "refs", "replace", name));
      let ref = "HEAD";
      const seen = new Set<string>();
      for (;;) {
        if (seen.has(ref)) throw new Error(`Cyclic PRIMARY git ref ${primary}`);
        seen.add(ref);
        const path = join(ref === "HEAD" || /^(?:refs\/(?:worktree|bisect|rewritten)\/)/.test(ref) ? directory : common, ref);
        track(path);
        let value: string;
        try { value = readFileSync(path, "utf8").trim(); } catch (error) { if (missing(error)) break; throw error; }
        if (!value.startsWith("ref: ")) {
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error(`Unreadable PRIMARY git ref ${path}`);
          break;
        }
        ref = value.slice(5);
        if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Invalid PRIMARY git ref ${path}`);
      }
    }
  }
  return { primaries, files: [...files].sort(([a], [b]) => a.localeCompare(b)), listings: [...listings].sort(([a], [b]) => a.localeCompare(b)), configs, ticks: readTickBindings(home), receiptCache: new Map() };
}
export interface StationDecision extends StationInventory { checkDeadline: () => void }
/** Re-derive only the inputs that decide compatibility and retention. Ordinary
 * observation writes, role-job row churn and transient leases are not conflicts. */
export async function recheckInventory(home: string, expected: InventoryInputs, prepared: StationInventory, operation: string, dependencies: InventoryDependencies = {}, { includeRuns = true, conservativeGc = false }: { includeRuns?: boolean; conservativeGc?: boolean } = {}): Promise<StationDecision> {
  const deadline = performance.now() + 1000;
  const checkDeadline = () => {
    if (performance.now() >= deadline) throw Object.assign(new Error(`Station inventory recheck exceeded 1000ms during ${operation}; retry`), { code: "ESTALE" });
  };
  try {
    const current = await captureInventoryInputs(home, dependencies, deadline);
    checkDeadline();
    const { ticks: previousTicks, receiptCache, ...previousConfig } = expected, { ticks: _, receiptCache: __, ...currentConfig } = current;
    if (!isDeepStrictEqual(previousConfig, currentConfig)) throw Object.assign(new Error(`Station inventory inputs changed during ${operation} preparation; retry`), { code: "ESTALE" });
    const configs = new Map(current.configs), expired = new Set(prepared.expiredBindings);
    const previousBindings = new Map(previousTicks.map(({ binding }) => [binding.dagRunId, binding]));
    const expiredBindingIds = new Set(previousTicks.filter(({ path }) => expired.has(path)).map(({ binding }) => binding.dagRunId));
    const decision = await inventoryStation(home, { ...dependencies,
      // A successful native inventory decoded committed schema 2. Unchanged
      // Git/config inputs bind that value without running Git under the lock.
      configVersion: primary => configs.get(primary) ?? CONFIG_SCHEMA_VERSION,
      // Artifact readers publish leases/receipts with the same station lock.
      // GC treats new/changed receipts as readers even if this list is terminal.
      listRuns: async () => prepared.runs ?? [],
      bindingRun: async binding => {
        const prior = previousBindings.get(binding.dagRunId);
        if (prior && isDeepStrictEqual(prior, binding) && expiredBindingIds.has(binding.dagRunId)) return undefined;
        // An unlisted binding is a possible reader, not proof of native absence.
        return { name: TICK_DAG, dagRunId: binding.dagRunId, statusLabel: "waiting" };
      },
    }, includeRuns, conservativeGc, { checkDeadline, receiptCache, rechecking: true, previousTicks: previousBindings });
    checkDeadline();
    return { ...decision, checkDeadline };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESTALE") throw error;
    checkDeadline();
    throw Object.assign(new Error(`Station inventory inputs unavailable during ${operation} preparation; retry`), { code: "ESTALE", cause: error });
  }
}
