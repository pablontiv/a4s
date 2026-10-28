import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  POLICY_PARAMETERS,
  readCommittedConfig,
  type LifecycleConfig,
} from "./config.ts";
import {
  BUNDLE_VERSION,
  formatProtocolRejection,
  inferLifecycleProtocols,
  lifecycleProtocolToken,
  missingLifecycleProtocols,
} from "./bundle.ts";
import { dagName, materializeDag, packageIdentity } from "./materialize.ts";
import type { RunDetails } from "./status/progress.ts";
import { isRecord } from "./type-guard.ts";
import { requirePocScope, scopeTargets } from "./poc-scope.ts";
import { HOST_PRIMARY_REFERENCE, bindSnapshotPrimary, resolvePrimaryBinding } from "./primary.ts";
import { assertReceiptVersion } from "./receipt-version.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const correction = "Commit .workspace/dagu/config.json in the consumer repository. Admission materializes the DAG from the installed package templates and resolves PRIMARY before enqueue; retry with a new run ID.";
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
function identity(path: string, version: string, origin: string) {
  const canonicalPath = realpathSync(path);
  return { version, canonicalPath, origin, digest: sha256(readFileSync(canonicalPath)) };
}
function tree(path: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? Object.entries(tree(child)).map(([key, value]) => [`${entry.name}/${key}`, value]) : [[entry.name, sha256(readFileSync(child))]];
  }));
}
export const loadedExtensionDigest = deploymentFingerprint(tree(join(packageRoot, "src")));
export interface AdmissionOptions { cwd: string; dag: string; run: string; params: string[]; session?: { transcriptRoot?: string; model?: unknown; extensionDigest?: string } }
export interface Receipt {
  schemaVersion: 1 | 2;
  sourceVersion: { version: string; commit: string; origin: string };
  deploymentFingerprint: string;
  initial: { admittedAt: string; deployment: Record<string, unknown>; runtimeAndModels: Record<string, unknown>; execution: Record<string, unknown> & { dagSnapshot: string }; eventsAndExternalState: Record<string, unknown> };
  runReceipt: { dag: string; run: string; attempt: number; observations: Observation[] };
}
export interface Observation { at: string; dag: string; run: string; attempt: number; category: "deployment" | "runtimeAndModels" | "execution" | "eventsAndExternalState"; kind: string; data: unknown }

function manifestVersion(contents: string): string {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value) || typeof value.version !== "string") throw new Error("Package identity requires a declared version");
  return value.version;
}
export function parseObservation(value: unknown): Omit<Observation, "at"> {
  if (!isRecord(value) || typeof value.dag !== "string" || typeof value.run !== "string" || typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || typeof value.kind !== "string") throw new Error("Observation requires DAG, run, positive integer attempt and kind");
  const category = value.category;
  if (category !== "deployment" && category !== "runtimeAndModels" && category !== "execution" && category !== "eventsAndExternalState") throw new Error("Observation requires a receipt category");
  return { dag: value.dag, run: value.run, attempt: value.attempt, category, kind: value.kind, data: value.data };
}
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
  return {
    schemaVersion: value.schemaVersion, sourceVersion: { version: source.version, commit: source.commit, origin: source.origin }, deploymentFingerprint: value.deploymentFingerprint,
    initial: { admittedAt: initial.admittedAt, deployment: initial.deployment, runtimeAndModels: initial.runtimeAndModels, execution: { ...initial.execution, dagSnapshot: initial.execution.dagSnapshot }, eventsAndExternalState: initial.eventsAndExternalState },
    runReceipt: { dag: run.dag, run: run.run, attempt: run.attempt, observations: run.observations.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.at !== "string") throw new Error(`Invalid receipt observation timestamp: ${path}`);
      return { at: entry.at, ...parseObservation(entry) };
    }) },
  };
}
export function receiptPath(cwd: string, run: string): string {
  if (!/^[\w-]+$/.test(run)) throw new Error(`run=${run} expected an explicit Dagu run ID containing letters, numbers, underscores or hyphens`);
  return join(git(cwd, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`), "receipt.json");
}
function existingAncestor(path: string): string {
  let current = path;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return path;
    current = parent;
  }
  return path;
}

function gitRoot(start: string): string | undefined {
  try { return git(start, "rev-parse", "--show-toplevel"); }
  catch { return undefined; }
}

/** The consumer checkout is the DAG path's repository, or the process cwd for a bare DAG name. */
function consumerRoot(cwd: string, dag: string): string {
  const resolved = resolve(cwd, dag);
  const starts = dag.includes("/") || dag.endsWith(".yaml") ? [existingAncestor(resolved), cwd] : [cwd];
  for (const start of starts) {
    const root = gitRoot(start);
    if (root) return root;
  }
  throw new Error(`admission requires a consumer git checkout containing committed ${CONFIG_PATH}`);
}

function policyRecord(config: LifecycleConfig, primary: string, branch: string): Record<string, unknown> {
  return {
    PRIMARY: primary, BRANCH: branch, LANE: config.lane, GATE: config.gate,
    REBASE_RESOLVER: config.rebaseResolver, REQUIRED_CHECK: config.requiredCheck,
    TEST_PATHS: config.testPaths, VALIDATION: config.validation,
    A4S_BLOCKER_REPORTING: config.blockerReporting, CODE_SCANNING: config.codeScanning,
    CODEQL_SECURITY_THRESHOLD: config.codeqlSecurityThreshold, CODEQL_ALERTS_THRESHOLD: config.codeqlAlertsThreshold,
    QUEUE_CONCURRENCY: config.queueConcurrency,
    ESCALATION_PUSHBACKS: config.escalation.pushbacks, ESCALATION_FINDINGS: config.escalation.findings,
    ESCALATION_SECONDS: config.escalation.seconds, ESCALATION_CI_BLOCKED: config.escalation.ciBlocked,
    ESCALATION_POC_INCONCLUSIVE: config.escalation.pocInconclusive,
  };
}

export function admit(options: AdmissionOptions, persist = true): { path: string; receipt: Receipt } {
  try {
    const name = dagName(options.dag);
    const hintedRoot = realpathSync(consumerRoot(options.cwd, options.dag));
    const hinted = readCommittedConfig(hintedRoot);
    let primaryParam = options.params.find(param => param.startsWith("PRIMARY="))?.slice(8);
    let config = hinted.config;
    let configCommit = hinted.commit;
    let configDigest = hinted.digest;
    let executionSnapshot: string | undefined;
    if (name === "feature.yaml" || name === "poc.yaml") {
      const bound = resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { workspace: config.lane });
      const resolved = realpathSync(bound);
      const primaryRepo = realpathSync(git(resolved, "rev-parse", "--show-toplevel"));
      if (primaryRepo !== hintedRoot) {
        const canonical = readCommittedConfig(primaryRepo);
        const again = realpathSync(resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { workspace: canonical.config.lane }));
        if (realpathSync(git(again, "rev-parse", "--show-toplevel")) !== primaryRepo) {
          throw new Error(`config lane=${canonical.config.lane} resolved PRIMARY ${again}, which is not the consumer checkout ${primaryRepo}`);
        }
        config = canonical.config;
        configCommit = canonical.commit;
        configDigest = canonical.digest;
      }
      const issue = options.params.find(param => param.startsWith("ISSUE="))?.slice(6);
      const branch = name === "feature.yaml" ? `dagu/issue-${issue}` : `poc/${options.run}`;
      const policy = policyRecord(config, resolved, branch);
      primaryParam = resolved;
      const rejected = options.params.map(param => param.slice(0, param.indexOf("=")))
        .filter(field => field.startsWith("ESCALATION_") || (POLICY_PARAMETERS as readonly string[]).includes(field));
      if (rejected.length) throw new Error(`admission rejected run parameter: ${rejected.join(", ")}; adopted policy ${JSON.stringify(policy)}`);
    }
    const primary = realpathSync(resolve(options.cwd, primaryParam || "."));
    const repo = realpathSync(git(primary, "rev-parse", "--show-toplevel"));
    if (name !== "feature.yaml" && name !== "poc.yaml" && hintedRoot !== repo) {
      const canonical = readCommittedConfig(repo);
      config = canonical.config;
      configCommit = canonical.commit;
      configDigest = canonical.digest;
    }
    if (name === "poc.yaml") {
      const param = (key: string) => options.params.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1) || "";
      requirePocScope(primary, { issue: param("ISSUE"), question: param("QUESTION"),
        requiredTargets: scopeTargets(JSON.parse(param("REQUIRED_TARGETS") || "[]")),
        authorizedTargets: scopeTargets(JSON.parse(param("AUTHORIZED_TARGETS") || "[]")), basis: param("SCOPE_BASIS") },
      param("SCOPE_REQUEST") || undefined, config.escalation.pocInconclusive);
    }
    const path = receiptPath(primary, options.run);
    const installed = packageIdentity(packageRoot);
    const commit = installed.commit;
    const origin = installed.origin;
    const daguHome = realpathSync(process.env.DAGU_HOME || join(homedir(), ".dagu"));
    const templateFile = join(packageRoot, "skills", "issue-execution", name);
    const templateText = readFileSync(templateFile, "utf8");
    const generated = materializeDag(packageRoot, name, config, installed);
    const declared = inferLifecycleProtocols(name, generated);
    const missing = missingLifecycleProtocols(declared);
    if (missing.length) throw new Error(formatProtocolRejection(name, missing));
    if (name === "feature.yaml" || name === "poc.yaml") executionSnapshot = bindSnapshotPrimary(generated, primary);
    const snapshot = executionSnapshot ?? generated;
    const reconcilerPath = join(daguHome, "dags", "reconcile.yaml");
    let installedReconciler: Record<string, unknown>;
    try {
      installedReconciler = { relationship: "station-installed", canonicalPath: realpathSync(reconcilerPath), digest: sha256(readFileSync(reconcilerPath)) };
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      installedReconciler = { state: "absent", cause: "station reconciler is not installed; bootstrap installs it from the package template without a consumer DAG" };
    }
    const installedPackageVersion = manifestVersion(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (installedPackageVersion !== BUNDLE_VERSION) throw new Error(`loaded package version=${BUNDLE_VERSION} installed package version=${installedPackageVersion}; restart OMP after redeployment`);
    const sourceTemplate = identity(templateFile, BUNDLE_VERSION, `${origin}@${commit}`);
    const extensionFiles = tree(join(packageRoot, "src"));
    if (options.session?.extensionDigest && options.session.extensionDigest !== deploymentFingerprint(extensionFiles)) throw new Error(`loaded extension digest=${options.session.extensionDigest} expected current installed=${deploymentFingerprint(extensionFiles)}; restart OMP after redeployment`);
    const generatedDigest = sha256(snapshot);
    const daguVersion = execFileSync("dagu", ["version"], { encoding: "utf8" }).trim();
    const installedDAG = {
      relationship: "materialized-from-config", version: BUNDLE_VERSION, canonicalPath: realpathSync(templateFile),
      origin: `${origin}@${commit}`, digest: sha256(templateText),
      template: { path: `skills/issue-execution/${name}`, commit, digest: sha256(templateText) },
      configDigest, generatedDigest, dagu: daguVersion, snapshot: generated,
    };
    const deployment = {
      package: identity(join(packageRoot, "package.json"), BUNDLE_VERSION, `${origin}@${commit}`),
      sourceTemplate, installedDAG, installedReconciler,
      config: { path: CONFIG_PATH, schemaVersion: config.schemaVersion, commit: configCommit, digest: configDigest },
      generatedDagDigest: generatedDigest,
      loadedExtension: { version: BUNDLE_VERSION, canonicalPath: realpathSync(join(packageRoot, "src", "triage", "index.ts")), origin: `${origin}@${commit}`, digest: deploymentFingerprint(extensionFiles), files: extensionFiles, status: identity(join(packageRoot, "src", "status", "index.ts"), BUNDLE_VERSION, `${origin}@${commit}`) },
      bootstrap: identity(join(packageRoot, "skills", "issue-execution", "dagu-feature-bootstrap.yaml"), BUNDLE_VERSION, `${origin}@${commit}`),
      skill: identity(join(packageRoot, "skills", "issue-execution", "SKILL.md"), BUNDLE_VERSION, `${origin}@${commit}`),
      agents: tree(join(packageRoot, "agents")),
      cli: identity(join(packageRoot, "bin", "dagu-feature-bundle.ts"), BUNDLE_VERSION, `${origin}@${commit}`),
      lifecycleHelpers: [
        identity(join(packageRoot, "skills", "issue-execution", "escalation.py"), BUNDLE_VERSION, `${origin}@${commit}`),
        identity(join(packageRoot, "bin", "dagu-poc-scope.ts"), BUNDLE_VERSION, `${origin}@${commit}`),
      ],
      relationships: { packageToExtension: "same-loaded-package", templateToPackage: "same-checkout", installedToSource: "materialized-from-config", compatibility: "installed-template", protocols: lifecycleProtocolToken() },
    };
    const diff = git(primary, "diff", "HEAD", "--binary");
    const dirty = git(primary, "status", "--porcelain", "--untracked-files=all");
    const runtimeConfig: Record<string, unknown> = {};
    for (const candidate of [join(daguHome, "config.yaml"), join(primary, ".omp", "settings.json"), join(homedir(), ".omp", "agent", "settings.json")]) {
      try { runtimeConfig[candidate] = sha256(readFileSync(candidate)); }
      catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        runtimeConfig[candidate] = { state: "unavailable", cause: "file not present" };
      }
    }
    const receipt: Receipt = {
      schemaVersion: 2, sourceVersion: { version: BUNDLE_VERSION, commit, origin }, deploymentFingerprint: deploymentFingerprint(deployment),
      initial: {
        admittedAt: new Date().toISOString(), deployment,
        runtimeAndModels: { ...fields("omp systemPromptDigest profile roles roleMapHash requestedRole resolvedModel fallback resolvedModelIsFallback crossFamilyDecision serverPid serverPpid serverStartedAt", "not exposed at admission; append a linked runtime observation when resolved"), node: { version: process.version, path: realpathSync(process.execPath) }, dagu: { version: daguVersion, path: realpathSync(execFileSync("/bin/sh", ["-c", "command -v dagu"], { encoding: "utf8" }).trim()) }, daguHome, endpoint: process.env.DAGU_URL || "http://127.0.0.1:8080", admissionPid: process.pid, admissionPpid: process.ppid, config: runtimeConfig, transcriptRoot: options.session?.transcriptRoot ?? pending("operator CLI has no OMP session context"), model: options.session?.model ?? pending("OMP model not exposed to CLI") },
        execution: { ...fields("base owner refs step approvalIteration sourceSession destinationSession triageGeneration triageMarker", "not yet resolved at admission"), repo, primary, head: git(primary, "rev-parse", "HEAD"), branch: git(primary, "branch", "--show-current"), worktree: repo, dirty, diffDigest: sha256(diff), parameters: options.params, ompSession: options.params.find(param => param.startsWith("OMP_SESSION_ID="))?.slice(15) ?? pending("OMP_SESSION_ID not supplied"), dagSnapshot: executionSnapshot ?? installedDAG.snapshot },
        eventsAndExternalState: fields("eventIds cursor source transition destination delivery trigger queue reconcile merge checks configuration locks lockOwner restarts activeRuns exit signal latency errors incidents", "not observed before enqueue; linked observations append without replacing initial state"),
      },
      runReceipt: { dag: name.replace(/\.yaml$/, ""), run: options.run, attempt: 1, observations: [] },
    };
    if (persist) {
      mkdirSync(dirname(path), { recursive: true });
      try { writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        throw new Error(`run=${options.run} already has an immutable admission receipt; choose a new run ID`);
      }
    } else {
      try { readFileSync(path); }
      catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return { path, receipt };
        throw error;
      }
      throw new Error(`run=${options.run} already has an immutable admission receipt; choose a new run ID`);
    }
    return { path, receipt };
  } catch (error) { throw new Error(`DAGU_ADMISSION_REJECTED: ${error instanceof Error ? error.message : String(error)}. ${correction}`); }
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
  let run = ""; let dag = "";
  for (let index = 0; index < flags.length; index++) {
    const arg = flags[index]!;
    if (arg === "--run-id") run = flags[++index] || "";
    else if (arg.startsWith("--run-id=")) run = arg.slice(9);
    else if (arg.startsWith("-")) throw new Error(`Unsupported admission flag ${arg}; use --run-id <id> <DAG> -- PARAM=value`);
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
  return { cwd, dag, run, params, ...(session ? { session } : {}) };
}
export function enqueue(args: string[], cwd: string): number {
  const options = enqueueArguments(args, cwd);
  const { path, receipt } = admit(options);
  // Enqueue the exact admitted bytes, not a mutable deployment path.
  const snapshot = join(dirname(path), "snapshot", `${receipt.runReceipt.dag}.yaml`);
  mkdirSync(dirname(snapshot));
  writeFileSync(snapshot, receipt.initial.execution.dagSnapshot, { flag: "wx", mode: 0o600 });
  const result = spawnSync("dagu", ["enqueue", "--run-id", options.run, snapshot, "--", ...options.params], { stdio: "inherit" });
  appendObservation(path, { dag: receipt.runReceipt.dag, run: options.run, attempt: 1, category: "eventsAndExternalState", kind: result.status === 0 ? "enqueued" : "incident", data: { exit: result.status, signal: result.signal, error: result.error?.message, originalDag: resolve(cwd, options.dag), snapshot, latency: Date.now() - Date.parse(receipt.initial.admittedAt) } });
  console.log(`receipt=${path} sourceVersion=${receipt.sourceVersion.version} deploymentFingerprint=${receipt.deploymentFingerprint}`);
  return result.status ?? 1;
}

/** Append runtime facts; initial identities are never recalculated for an old run. */
export function observeRunReceipt(run: RunDetails, cwd: string, kind = "runtime", error?: string): void {
  const primary = cwd;
  let path: string;
  try { path = receiptPath(primary, run.dagRunId); }
  catch { return; } // Non-adopted repositories have no receipt namespace.
  let receipt: Receipt;
  try { receipt = readReceipt(path); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  const data = { source: "dagu-rest-and-persisted-events", observerPid: process.pid, observerPpid: process.ppid, loadedExtensionDigest, run, ...(error ? { error } : {}) };
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
    if (isRecord(observation.data) && typeof observation.data.observerPid === "number") {
      lastObserver = observation;
      break;
    }
  }
  if (lastObserver && isRecord(lastObserver.data) && lastObserver.data.observerPid !== process.pid) {
    appendObservation(path, { dag: run.name, run: run.dagRunId, attempt, category: "eventsAndExternalState", kind: "incident:observer-restart", data });
  }
  appendObservation(path, { dag: run.name, run: run.dagRunId, attempt, category: "eventsAndExternalState", kind: resolvedKind, data });
}
