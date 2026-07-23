import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readCommittedConfig } from "./config.ts";
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
function gitPath(primary: string): string {
  return execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature"], { encoding: "utf8", timeout: 10000 }).trim();
}
const activeStatuses: Record<string, true> = { queued: true, waiting: true, running: true, recoverable: true, retrying: true, not_started: true };
const terminalStatuses: Record<string, true> = { succeeded: true, failed: true, aborted: true, cancelled: true, partially_succeeded: true, rejected: true };
export function nonterminal(run: StationRun): boolean {
  const status = run.statusLabel.toLowerCase();
  if (!activeStatuses[status] && !terminalStatuses[status]) throw new Error(`Unknown Dagu status ${run.statusLabel}`);
  return !!activeStatuses[status] || run.retryable === true;
}
async function api(path: string): Promise<Response> {
  return fetch(`${(process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "")}/api/v1/${path}`, { signal: AbortSignal.timeout(15000) });
}
/** All DAGs, all history pages: page size is never a retention limit. */
export async function listStationRuns(home = process.env.DAGU_HOME || join(homedir(), ".dagu"), limit = 100): Promise<StationRun[]> {
  const runs: StationRun[] = [];
  const seen = new Set<string>();
  // Cursor filters stay fixed. Dagu's second-resolution upper bound must cover
  // the whole current second, including native subsecond creation timestamps.
  const toDate = String(Math.floor(Date.now() / 1000) + 1);
  let cursor = "";
  for (;;) {
    const params = new URLSearchParams({ fromDate: "0", toDate, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const response = await api(`dag-runs?${params}`);
    if (!response.ok) throw new Error(`Dagu inventory HTTP ${response.status}`);
    const page: unknown = await response.json();
    if (!isRecord(page) || !Array.isArray(page.dagRuns)) throw new Error("Malformed Dagu inventory page");
    for (const row of page.dagRuns) {
      if (!isRecord(row) || typeof row.name !== "string" || !row.name || typeof row.dagRunId !== "string" || !row.dagRunId || typeof row.statusLabel !== "string") throw new Error("Malformed Dagu run");
      const run: StationRun = { name: row.name, dagRunId: row.dagRunId, statusLabel: row.statusLabel, retryable: row.retryable === true };
      const workspace = typeof row.workspace === "string" && row.workspace ? `?workspace=${encodeURIComponent(row.workspace)}` : "";
      // Dagu 2.24 exposes pending resumes only in details, not in list summaries.
      // Failed/aborted/partial runs may therefore still be recoverable readers.
      if (["failed", "aborted", "partially_succeeded"].includes(run.statusLabel.toLowerCase())) {
        const detailResponse = await api(`dag-runs/${encodeURIComponent(run.name)}/${encodeURIComponent(run.dagRunId)}${workspace}`);
        if (!detailResponse.ok) throw new Error(`Dagu recovery inventory HTTP ${detailResponse.status}`);
        const detail: unknown = await detailResponse.json();
        if (!isRecord(detail) || !isRecord(detail.dagRunDetails)) throw new Error("Malformed Dagu recovery details");
        const data = detail.dagRunDetails;
        run.retryable = run.retryable || data.humanTaskResumePending === true || data.approvalResumePending === true ||
          run.statusLabel.toLowerCase() === "failed" && typeof row.autoRetryLimit === "number" &&
          (typeof row.autoRetryCount !== "number" || row.autoRetryCount < row.autoRetryLimit);
      }
      // Resolve from the immutable spec, not from today's DAG file or a label guess.
      if (nonterminal(run)) {
        const specResponse = await api(`dag-runs/${encodeURIComponent(run.name)}/${encodeURIComponent(run.dagRunId)}/spec${workspace}`);
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
  return names(directory).map(name => {
    if (!name.endsWith(".json")) throw new Error(`Unknown tick binding file ${name}`);
    const path = join(directory, name), value = readJsonFile(path);
    const binding = validateTickBinding(value, name.slice(0, -5));
    return { path, binding };
  });
}
interface ReceiptEntry { value: Record<string, unknown>; primary: string; dag: string; run: string; artifact?: ArtifactTuple; created: number }
export interface StationInventory { formats: Partial<PersistedFormats>; references: BuildReference[]; expiredBindings: string[] }
/** Read-only inventory; every error propagates before the caller can delete anything. */
export async function inventoryStation(home: string, dependencies: InventoryDependencies = {}, includeRuns = true): Promise<StationInventory> {
  const versions = Object.fromEntries(SHARED_FORMATS.map(name => [name, new Set<number>()])) as Record<SharedFormat, Set<number>>;
  const add = (name: SharedFormat, value: unknown) => {
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
      const path = join(directory, "runs", run, "receipt.json");
      let value: unknown;
      try { value = readJsonFile(path); } catch (error) { if (missing(error)) continue; throw error; }
      if (!isRecord(value) || !isRecord(value.runReceipt) || typeof value.runReceipt.dag !== "string" || value.runReceipt.run !== run || !isRecord(value.initial)) throw new Error(`Unreadable run receipt ${run}`);
      add("receipt", value.schemaVersion);
      const contracts = isRecord(value.contracts) ? value.contracts : undefined;
      if (contracts) for (const name of SHARED_FORMATS) if (contracts[name] !== undefined) add(name, contracts[name]);
      const created = Date.parse(String(value.receiptCreatedAt ?? value.initial.admittedAt));
      if (!Number.isFinite(created)) throw new Error(`Missing receipt creation time ${run}`);
      receipts.push({ value, primary, dag: value.runReceipt.dag, run, created, ...(value.artifact ? { artifact: tupleFromJson(value.artifact) } : {}) });
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
      const schema = db.prepare("PRAGMA user_version").get();
      add("roleJobStore", Number(schema?.user_version) || 1); // Historical SQL schema 1 predates user_version.
      for (const row of db.prepare("SELECT document,result FROM jobs").all()) {
        const job: unknown = JSON.parse(String(row.document));
        if (!isRecord(job) || !isRecord(job.binding) || typeof job.binding.repo !== "string" || typeof job.binding.run !== "string" || typeof job.binding.dag !== "string") throw new Error("Unreadable role-job binding");
        add("roleJobPayload", job.schemaVersion);
        if (row.result !== null) {
          const result: unknown = JSON.parse(String(row.result));
          if (!isRecord(result)) throw new Error("Unreadable role-job result");
          add("roleJobPayload", result.schemaVersion);
        } else openJobs.push({ repo: realpathSync(job.binding.repo), run: job.binding.run, dag: job.binding.dag });
      }
    } finally { db.close(); }
  }
  if (includeRuns) {
    const runs = await (dependencies.listRuns ? dependencies.listRuns() : listStationRuns(home));
    for (const run of runs) nonterminal(run);
    for (const run of runs.filter(nonterminal)) {
      const matching = receipts.filter(receipt => receipt.run === run.dagRunId && receipt.dag === run.name && (!run.primary || receipt.primary === run.primary));
      if (!matching.length && run.primary && primaries.includes(run.primary)) throw new Error(`Nonterminal run has no receipt: ${run.name}/${run.dagRunId}`);
      for (const receipt of matching) {
        if (!receipt.artifact) throw new Error(`Unresolved nonterminal artifact ${receipt.run}`);
        references.push({ artifact: receipt.artifact, holder: `run ${run.name}/${run.dagRunId} ${run.statusLabel}` });
      }
    }
    const now = (dependencies.now ?? Date.now)();
    for (const receipt of receipts) {
      if (!runs.some(run => run.name === receipt.dag && run.dagRunId === receipt.run) && now - receipt.created < 7 * 86400000) {
        if (!receipt.artifact) throw new Error(`Unresolved pending admission ${receipt.run}`);
        references.push({ artifact: receipt.artifact, holder: `pending admission ${receipt.dag}/${receipt.run}` });
      }
    }
    for (const job of openJobs) {
      const receipt = receipts.find(receipt => receipt.primary === job.repo && receipt.run === job.run && receipt.dag === job.dag);
      if (!receipt?.artifact) throw new Error(`Unresolved open role job ${job.dag}/${job.run}`);
      references.push({ artifact: receipt.artifact, holder: `open role job ${job.dag}/${job.run}` });
    }
    const expiredBindings: string[] = [];
    for (const { path, binding } of readTickBindings(home)) {
      const listed = runs.find(run => run.name === TICK_DAG && run.dagRunId === binding.dagRunId);
      const run = listed ?? await (dependencies.bindingRun ?? bindingRun)(binding);
      if (!run) expiredBindings.push(path);
      else if (nonterminal(run)) references.push({ artifact: binding.tuple, holder: `tick ${TICK_DAG}/${binding.dagRunId}` });
    }
    return { formats: Object.fromEntries(SHARED_FORMATS.map(name => [name, [...versions[name]]])) as Partial<PersistedFormats>, references, expiredBindings };
  }
  return { formats: Object.fromEntries(SHARED_FORMATS.map(name => [name, [...versions[name]]])) as Partial<PersistedFormats>, references, expiredBindings: [] };
}
