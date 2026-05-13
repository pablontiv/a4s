import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_PATH, POLICY_PARAMETERS, readCommittedConfig, type CommittedConfig } from "../../launcher/src/config.ts";
import { dagName, materializeDag, type LifecycleDag } from "./materialize.ts";
import type { RunDetails } from "./status/progress.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";
import { requirePocScope, scopeTargets } from "./poc-scope.ts";
import { HOST_PRIMARY_REFERENCE, bindSnapshotPrimary, resolvePrimaryBinding } from "../../launcher/src/primary.ts";
import { assertReceiptVersion } from "./receipt-version.ts";
import { requireOwnerSession } from "./owner-session.ts";
import { packageRoot } from "./executable.ts";
import { artifactToken, parseArtifact, releaseRepository, sameArtifact } from "../../launcher/src/release.ts";
import { artifactLock, inspectArtifact, type CachedArtifact } from "../../launcher/src/artifact-cache.ts";
import { assertArtifactReceipt, assertExecutingArtifact, receiptArtifact, USED_CONTRACTS, type ArtifactReceiptFields } from "./artifact-receipt.ts";
import { withFileLockAsync } from "../../launcher/src/file-lock.ts";
import { stationReadiness } from "./queue.ts";
import { stationTransaction, readStationState } from "../../launcher/src/station-state.ts";
import { handoff } from "../../launcher/src/select.ts";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function deploymentFingerprint(components: unknown): string { return sha256(canonical(components)); }
function git(cwd: string, ...args: string[]): string { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function pending(cause: string): { state: "pending"; cause: string } { return { state: "pending", cause }; }
function fields(names: string, cause: string): Record<string, unknown> { return Object.fromEntries(names.split(" ").map(name => [name, pending(cause)])); }
function tree(path: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? Object.entries(tree(child)).map(([key, value]) => [`${entry.name}/${key}`, value]) : [[entry.name, sha256(readFileSync(child))]];
  }));
}
export const loadedExtensionDigest = deploymentFingerprint(tree(join(packageRoot, "src")));
export interface AdmissionOptions {
  cwd: string; dag: string; run: string; params: string[]; artifact?: string; parent?: string; check?: boolean;
  session?: { transcriptRoot?: string; model?: unknown; extensionDigest?: string };
}
export interface Receipt {
  schemaVersion: 1 | 2;
  artifact?: ArtifactReceiptFields["artifact"];
  artifactSupport?: ArtifactReceiptFields["artifactSupport"];
  contracts?: ArtifactReceiptFields["contracts"];
  parent?: ArtifactReceiptFields["parent"];
  sourceVersion: { version: string; commit: string; origin: string };
  deploymentFingerprint: string;
  initial: { admittedAt: string; deployment: Record<string, unknown>; runtimeAndModels: Record<string, unknown>; execution: Record<string, unknown> & { dagSnapshot: string }; eventsAndExternalState: Record<string, unknown> };
  runReceipt: { dag: string; run: string; attempt: number; observations: Observation[] };
}
export interface Observation { at: string; dag: string; run: string; attempt: number; category: "deployment" | "runtimeAndModels" | "execution" | "eventsAndExternalState"; kind: string; data: unknown }
export function parseObservation(value: unknown): Omit<Observation, "at"> {
  if (!isRecord(value) || typeof value.dag !== "string" || typeof value.run !== "string" || typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || typeof value.kind !== "string") throw new Error("Observation requires DAG, run, positive integer attempt and kind");
  const category = value.category;
  if (category !== "deployment" && category !== "runtimeAndModels" && category !== "execution" && category !== "eventsAndExternalState") throw new Error("Observation requires a receipt category");
  return { dag: value.dag, run: value.run, attempt: value.attempt, category, kind: value.kind, data: value.data };
}
/** Observation can report legacy records; it grants no permission to execute them. */
function readReceipt(path: string): Receipt {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertReceiptVersion(value, path);
  if (typeof value.deploymentFingerprint !== "string") throw new Error(`Invalid receipt schema: ${path}`);
  const source = value.sourceVersion;
  const initial = value.initial;
  const run = value.runReceipt;
  if (!isRecord(source) || typeof source.version !== "string" || typeof source.commit !== "string" || typeof source.origin !== "string") throw new Error(`Invalid receipt sourceVersion: ${path}`);
  if (!isRecord(initial) || typeof initial.admittedAt !== "string" || !isRecord(initial.deployment) || !isRecord(initial.runtimeAndModels) || !isRecord(initial.execution) || typeof initial.execution.dagSnapshot !== "string" || !isRecord(initial.eventsAndExternalState)) throw new Error(`Invalid receipt initial snapshot: ${path}`);
  if (!isRecord(run) || typeof run.dag !== "string" || typeof run.run !== "string" || typeof run.attempt !== "number" || !Array.isArray(run.observations)) throw new Error(`Invalid runReceipt: ${path}`);
  for (const entry of run.observations) {
    if (!isRecord(entry) || typeof entry.at !== "string") throw new Error(`Invalid receipt observation timestamp: ${path}`);
    parseObservation(entry);
  }
  return value as unknown as Receipt;
}
export function receiptPath(cwd: string, run: string): string {
  if (!/^[\w-]+$/.test(run)) throw new Error(`run=${run} expected an explicit Dagu run ID containing letters, numbers, underscores or hyphens`);
  return join(git(cwd, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`), "receipt.json");
}
function existingAncestor(path: string): string {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return path;
    current = parent;
  }
}
function consumerRoot(cwd: string, dag: string): string {
  const starts = dag.includes("/") || dag.endsWith(".yaml") ? [existingAncestor(resolve(cwd, dag)), cwd] : [cwd];
  for (const start of starts) {
    try { return git(start, "rev-parse", "--show-toplevel"); } catch { /* Try the caller's checkout. */ }
  }
  throw new Error(`admission requires a consumer git checkout containing committed ${CONFIG_PATH}`);
}
/** Side-effect-free validation also used by the OMP shell interception boundary. */
export function preflightAdmission(options: AdmissionOptions): AdmissionContext {
  const name = dagName(options.dag);
  const rejected = options.params.map(param => param.split("=", 1)[0]!)
    .filter(field => field.startsWith("ESCALATION_") || field.startsWith("CODEQL_") || (POLICY_PARAMETERS as readonly string[]).includes(field));
  if (rejected.length) throw new Error(`admission rejected run parameter: ${rejected.join(", ")}; policy comes only from committed ${CONFIG_PATH}`);
  const owners = options.params.filter(param => param.startsWith("OMP_SESSION_ID="));
  const owner = requireOwnerSession(owners.length === 1 ? owners[0]!.slice(15) : undefined);
  const hintedRoot = realpathSync(consumerRoot(options.cwd, options.dag));
  let committed = readCommittedConfig(hintedRoot);
  const primary = realpathSync(resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { workspace: committed.config.lane }));
  const repo = realpathSync(git(primary, "rev-parse", "--show-toplevel"));
  if (repo !== hintedRoot) {
    committed = readCommittedConfig(repo);
    const again = realpathSync(resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { workspace: committed.config.lane }));
    if (realpathSync(git(again, "rev-parse", "--show-toplevel")) !== repo) throw new Error(`config lane=${committed.config.lane} does not resolve to consumer checkout ${repo}`);
  }
  receiptPath(primary, options.run);
  if (name === "poc.yaml") {
    const param = (key: string) => options.params.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1) || "";
    requirePocScope(primary, { issue: param("ISSUE"), question: param("QUESTION"),
      requiredTargets: scopeTargets(JSON.parse(param("REQUIRED_TARGETS") || "[]")),
      authorizedTargets: scopeTargets(JSON.parse(param("AUTHORIZED_TARGETS") || "[]")), basis: param("SCOPE_BASIS") },
    param("SCOPE_REQUEST") || undefined, committed.config.escalation.pocInconclusive);
  }
  return { name, owner, primary, repo, committed };
}
export interface AdmissionContext { name: LifecycleDag; owner: string; primary: string; repo: string; committed: CommittedConfig }
async function selectParent(options: AdmissionOptions, context: AdmissionContext, home: string): Promise<ArtifactReceiptFields["parent"]> {
  if (!options.parent) return undefined;
  const path = realpathSync(resolve(options.cwd, options.parent));
  const { receipt } = await receiptArtifact(home, path);
  const run = receipt.runReceipt;
  const initial = receipt.initial;
  if (!isRecord(run) || typeof run.dag !== "string" || typeof run.run !== "string" || !isRecord(initial) || !isRecord(initial.execution) || initial.execution.primary !== context.primary || initial.execution.ompSession !== context.owner || realpathSync(receiptPath(context.primary, run.run)) !== path) throw new Error("Invalid parent receipt lineage/owner/consumer");
  const transitions: Record<string, string> = { feature: "poc.yaml", poc: "feature.yaml", discovery: "planning.yaml" };
  if (transitions[run.dag] !== context.name || run.run === options.run) throw new Error(`Invalid successor transition ${run.dag} -> ${context.name}`);
  if (options.artifact && !sameArtifact(parseArtifact(options.artifact), receipt.artifact)) throw new Error("Child artifact differs from parent receipt");
  return { receipt: path, dag: run.dag, run: run.run, artifact: receipt.artifact };
}
function createReceipt(options: AdmissionOptions, context: AdmissionContext, cached: CachedArtifact, parent: ArtifactReceiptFields["parent"], persist: boolean): { path: string; receipt: Receipt } {
  const { name, owner, primary, repo, committed } = context;
  const path = receiptPath(primary, options.run);
  const { version, commit } = cached.record;
  const origin = `https://github.com/${releaseRepository()}`;
  const daguHome = realpathSync(process.env.DAGU_HOME || join(homedir(), ".dagu"));
  const templateFile = join(cached.directory, "skills", "issue-execution", name);
  const templateText = readFileSync(templateFile, "utf8");
  const generated = materializeDag(cached.directory, name, committed.config, { version, source: `${origin}@${commit}`, executable: cached.executable });
  const snapshot = name === "reconcile.yaml" ? generated : bindSnapshotPrimary(generated, primary);
  const generatedDigest = sha256(snapshot);
  const daguVersion = execFileSync("dagu", ["version"], { encoding: "utf8" }).trim();
  const deployment = {
    artifact: cached.record,
    sourceTemplate: { version, canonicalPath: templateFile, origin, digest: sha256(templateText) },
    installedDAG: { relationship: "materialized-from-cache", version, canonicalPath: templateFile, origin, digest: sha256(templateText),
      template: { path: `skills/issue-execution/${name}`, commit, digest: sha256(templateText) }, configDigest: committed.digest, generatedDigest, dagu: daguVersion, snapshot: generated },
    config: { path: CONFIG_PATH, schemaVersion: committed.config.schemaVersion, uses: committed.config.uses, commit: committed.commit, digest: committed.digest },
    generatedDagDigest: generatedDigest,
    relationships: { templateToArtifact: "verified-cache", protocols: USED_CONTRACTS.protocols },
  };
  const diff = git(primary, "diff", "HEAD", "--binary");
  const receipt: Receipt = {
    schemaVersion: 2, artifact: { version, commit, digest: cached.record.digest }, artifactSupport: cached.identity.support, contracts: USED_CONTRACTS,
    ...(parent ? { parent } : {}), sourceVersion: { version, commit, origin }, deploymentFingerprint: deploymentFingerprint(deployment),
    initial: {
      admittedAt: new Date().toISOString(), deployment,
      runtimeAndModels: { ...fields("omp systemPromptDigest profile roles roleMapHash requestedRole resolvedModel fallback resolvedModelIsFallback crossFamilyDecision", "not exposed at admission; append linked runtime observations"),
        node: { version: process.version, path: realpathSync(process.execPath) }, dagu: { version: daguVersion }, daguHome,
        roleJobStore: join(daguHome, "role-jobs.sqlite"), admissionPid: process.pid, admissionPpid: process.ppid,
        transcriptRoot: options.session?.transcriptRoot ?? pending("operator CLI has no OMP session context"), model: options.session?.model ?? pending("not exposed at admission") },
      execution: { ...fields("base owner refs step approvalIteration sourceSession destinationSession triageGeneration triageMarker", "not yet resolved at admission"), repo, primary,
        head: git(primary, "rev-parse", "HEAD"), branch: git(primary, "branch", "--show-current"), worktree: repo,
        dirty: git(primary, "status", "--porcelain", "--untracked-files=all"), diffDigest: sha256(diff), parameters: options.params, ompSession: owner, dagSnapshot: snapshot },
      eventsAndExternalState: fields("eventIds cursor source transition destination delivery trigger queue reconcile merge checks configuration locks lockOwner restarts activeRuns exit signal latency errors incidents", "not observed before enqueue"),
    }, runReceipt: { dag: name.replace(/\.yaml$/, ""), run: options.run, attempt: 1, observations: [] },
  };
  assertArtifactReceipt(receipt, path);
  if (!persist) {
    if (existsSync(path)) throw new Error(`run=${options.run} already has an immutable admission receipt; choose a new run ID`);
    return { path, receipt };
  }
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    throw new Error(`run=${options.run} already has an immutable admission receipt; choose a new run ID`);
  }
  return { path, receipt };
}
async function selectedAdmission<T>(options: AdmissionOptions, persist: boolean, use: (admission: { path: string; receipt: Receipt }) => T): Promise<T> {
  const context = preflightAdmission(options);
  const home = realpathSync(process.env.DAGU_HOME || join(homedir(), ".dagu"));
  const parent = await selectParent(options, context, home);
  const tuple = options.artifact ? parseArtifact(options.artifact) : parent?.artifact;
  if (!tuple) throw new Error("Admission requires a resolved --artifact handoff or --parent receipt");
  assertExecutingArtifact(tuple);
  return stationTransaction(home, () => withFileLockAsync(artifactLock(home, tuple), async () => {
    const cached = await inspectArtifact(home, tuple);
    if (realpathSync(process.execPath) !== cached.executable) throw new Error(`Admission must execute the cached artifact ${cached.executable}`);
    return use(createReceipt(options, context, cached, parent, persist));
  }));
}
/** Internal explicit-artifact admission. Root CLI admission always hands off first. */
export async function admit(options: AdmissionOptions, persist = true): Promise<{ path: string; receipt: Receipt }> {
  return selectedAdmission(options, persist, result => result);
}
export function appendObservation(path: string, observation: Omit<Observation, "at">): void {
  assertReceiptVersion(JSON.parse(readFileSync(path, "utf8")), path);
  const lock = `${path}.lock`;
  mkdirSync(lock);
  try {
    const receipt = readReceipt(path);
    if (observation.dag !== receipt.runReceipt.dag || observation.run !== receipt.runReceipt.run || !Number.isSafeInteger(observation.attempt) || observation.attempt < 1) throw new Error("Receipt observation DAG/run/attempt mismatch");
    receipt.runReceipt.observations.push({ at: new Date().toISOString(), ...observation });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(lock, { recursive: true }); }
}
export function enqueueArguments(args: string[], cwd: string): AdmissionOptions {
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  let run = ""; let dag = ""; let artifact: string | undefined; let parent: string | undefined; let check = false;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const arg = flags[index]!;
    const key = arg.split("=", 1)[0]!;
    if (arg === "--check") {
      if (seen.has(arg)) throw new Error(`Duplicate admission flag ${arg}`);
      seen.add(arg);
      check = true;
    } else if (["--run-id", "--artifact", "--parent"].includes(key)) {
      if (seen.has(key)) throw new Error(`Duplicate admission flag ${key}`);
      seen.add(key);
      const value = arg.includes("=") ? arg.slice(key.length + 1) : flags[++index] || "";
      if (!value || value.startsWith("--")) throw new Error(`Missing admission flag value ${key}`);
      if (key === "--run-id") run = value;
      else if (key === "--artifact") { parseArtifact(value); artifact = value; }
      else parent = value;
    } else if (arg.startsWith("-")) throw new Error(`Unsupported admission flag ${arg}; use [--check] --run-id <id> [--artifact <tuple> | --parent <receipt>] <DAG> -- PARAM=value`);
    else if (dag) throw new Error("Ambiguous DAG identity; provide exactly one DAG path");
    else dag = arg;
  }
  if (!run || !dag) throw new Error("Admission requires --run-id <id> <DAG> -- PARAM=value");
  const params = separator < 0 ? [] : args.slice(separator + 1);
  if (params.some(param => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(param))) throw new Error("Admission parameters must be NAME=value");
  const keys = params.map(param => param.slice(0, param.indexOf("=")));
  if (new Set(keys).size !== keys.length) throw new Error("Ambiguous admission parameters: each NAME must occur once");
  let session: AdmissionOptions["session"];
  if (process.env.DAGU_ADMISSION_SESSION) {
    const value: unknown = JSON.parse(process.env.DAGU_ADMISSION_SESSION);
    if (!isRecord(value) || (value.transcriptRoot !== undefined && typeof value.transcriptRoot !== "string") || (value.extensionDigest !== undefined && typeof value.extensionDigest !== "string")) throw new Error("Indeterminate loaded session identity");
    session = { ...(typeof value.transcriptRoot === "string" ? { transcriptRoot: value.transcriptRoot } : {}), ...(typeof value.extensionDigest === "string" ? { extensionDigest: value.extensionDigest } : {}), ...(value.model !== undefined ? { model: value.model } : {}) };
  }
  if (check && (artifact || parent)) throw new Error("--check reads station.current; --artifact and --parent are not supported");
  return { cwd, dag, run, params, ...(artifact ? { artifact } : {}), ...(parent ? { parent } : {}), ...(check ? { check } : {}), ...(session ? { session } : {}) };
}
/** Root CLI hands off through the stable selector; successors inherit their parent's tuple. */
export async function enqueue(args: string[], cwd: string): Promise<number> {
  try {
    const options = enqueueArguments(args, cwd);
    const context = preflightAdmission(options);
    // Planning checks stop before cache publication, handoff, locks, receipts or
    // Dagu CLI calls. Reuse queue's GET-only station readiness boundary.
    if (options.check) {
      const state = await readStationState(process.env.DAGU_HOME || join(homedir(), ".dagu"));
      const report = await stationReadiness(process.env.DAGU_HOME || join(homedir(), ".dagu"), context.committed.config.lane);
      console.log(report.checks.join("\n"));
      console.log(`admissible=${report.ready ? "yes" : "no"} artifact=${artifactToken(state.current)} lane=${context.committed.config.lane}`);
      return report.ready ? 0 : 1;
    }
    if (!options.artifact) return await handoff(process.env.DAGU_HOME || join(homedir(), ".dagu"), ["admit", ...args]);
    return await selectedAdmission(options, true, ({ path, receipt }) => {
      const snapshot = join(dirname(path), "snapshot", `${receipt.runReceipt.dag}.yaml`);
      mkdirSync(dirname(snapshot));
      writeFileSync(snapshot, receipt.initial.execution.dagSnapshot, { flag: "wx", mode: 0o600 });
      const result = spawnSync("dagu", ["enqueue", "--run-id", options.run, snapshot, "--", ...options.params], { stdio: "inherit" });
      appendObservation(path, { dag: receipt.runReceipt.dag, run: options.run, attempt: 1, category: "eventsAndExternalState", kind: result.status === 0 ? "enqueued" : "incident", data: { exit: result.status, signal: result.signal, error: result.error?.message, originalDag: resolve(cwd, options.dag), snapshot, latency: Date.now() - Date.parse(receipt.initial.admittedAt) } });
      console.log(`receipt=${path} sourceVersion=${receipt.sourceVersion.version} deploymentFingerprint=${receipt.deploymentFingerprint}`);
      return result.status ?? 1;
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    if (args.includes("--check")) {
      console.log(`admissible=no cause=${JSON.stringify(cause)}`);
      return 1;
    }
    throw new Error(`DAGU_ADMISSION_REJECTED: ${cause}`);
  }
}
/** Append runtime facts; initial identities are never recalculated for an old run. */
export function observeRunReceipt(run: RunDetails, cwd: string, kind = "runtime", error?: string,
  observer = { observerPid: process.pid, observerPpid: process.ppid, loadedExtensionDigest }): void {
  let path: string;
  try { path = receiptPath(cwd, run.dagRunId); } catch { return; }
  let receipt: Receipt;
  try { receipt = readReceipt(path); }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return; throw error; }
  const data = { source: "dagu-rest-and-persisted-events", ...observer, run, ...(error ? { error } : {}) };
  const incident = error || run.receiptEvent?.cursorReset || ["failed", "aborted", "cancelled"].includes(run.statusLabel);
  const resolvedKind = run.receiptEvent?.cursorReset ? "incident:cursor-reset" : incident ? `incident:${kind}` : kind;
  const prior = receipt.runReceipt.observations.at(-1);
  if (prior?.kind === resolvedKind && canonical(prior.data) === canonical(data)) return;
  if (run.receiptEvent && receipt.runReceipt.observations.some(observation => {
    const previous = observation.data;
    return isRecord(previous) && isRecord(previous.run) && isRecord(previous.run.receiptEvent) && previous.run.receiptEvent.id === run.receiptEvent?.id;
  })) return;
  const attempt = "attempt" in run && typeof run.attempt === "number" ? run.attempt : receipt.runReceipt.attempt;
  let lastObserver: Observation | undefined;
  for (let index = receipt.runReceipt.observations.length - 1; index >= 0; index--) {
    const observation = receipt.runReceipt.observations[index]!;
    if (isRecord(observation.data) && typeof observation.data.observerPid === "number") { lastObserver = observation; break; }
  }
  if (lastObserver && isRecord(lastObserver.data) && lastObserver.data.observerPid !== observer.observerPid) appendObservation(path, { dag: run.name, run: run.dagRunId, attempt, category: "eventsAndExternalState", kind: "incident:observer-restart", data });
  appendObservation(path, { dag: run.name, run: run.dagRunId, attempt, category: "eventsAndExternalState", kind: resolvedKind, data });
}
