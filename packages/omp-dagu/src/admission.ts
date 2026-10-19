import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_VERSION, classifyCompatibility, parseBundleStamp, REQUIRED_DAGU_VERSION } from "./bundle.ts";
import type { RunDetails } from "./status/progress.ts";
import { isRecord } from "./type-guard.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const correction = "Apply bootstrap from a clean compatible @a4s/omp-dagu checkout, adopt its stamped DAGs, install its reconciler and reload both OMP extensions; retry with a new run ID.";
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
  schemaVersion: 1;
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
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.deploymentFingerprint !== "string") throw new Error(`Invalid receipt schema: ${path}`);
  const source = value.sourceVersion;
  const initial = value.initial;
  const run = value.runReceipt;
  if (!isRecord(source) || typeof source.version !== "string" || typeof source.commit !== "string" || typeof source.origin !== "string") throw new Error(`Invalid receipt sourceVersion: ${path}`);
  if (!isRecord(initial) || typeof initial.admittedAt !== "string" || !isRecord(initial.deployment) || !isRecord(initial.runtimeAndModels) || !isRecord(initial.execution) || typeof initial.execution.dagSnapshot !== "string" || !isRecord(initial.eventsAndExternalState)) throw new Error(`Invalid receipt initial snapshot: ${path}`);
  if (!isRecord(run) || typeof run.dag !== "string" || typeof run.run !== "string" || typeof run.attempt !== "number" || !Array.isArray(run.observations)) throw new Error(`Invalid runReceipt: ${path}`);
  return {
    schemaVersion: 1, sourceVersion: { version: source.version, commit: source.commit, origin: source.origin }, deploymentFingerprint: value.deploymentFingerprint,
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
function checkRender(path: string, name: string, sourceRoot: string, prefix: string) {
  const contents = readFileSync(path, "utf8");
  const stamp = parseBundleStamp(contents);
  if (!stamp || classifyCompatibility(stamp.version) !== "ok") throw new Error(`${name} observed=${stamp?.version ?? "indeterminate"} expected compatible with package=${BUNDLE_VERSION} (same major; major 0: same minor)`);
  if (stamp.dagu !== REQUIRED_DAGU_VERSION) throw new Error(`${name} dagu=${stamp.dagu} expected=${REQUIRED_DAGU_VERSION}`);
  const source = /^(.+)@([a-f0-9]{40})$/.exec(stamp.source);
  const labels = [...contents.matchAll(/^\s+- dagu-feature-bundle=(\S+)\s*$/gm)];
  if (!source || labels.length !== 1 || labels[0]?.[1] !== stamp.version) throw new Error(`${name} source/label ambiguous observed=${stamp.source} labels=${labels.map(label => label[1])} expected one matching bundle label and owner/repo@sha40`);
  const expectedSource = git(sourceRoot, "remote", "get-url", "origin").replace(/\.git\/?$/, "").replace(/\/$/, "").split(/[/:]/).slice(-2).join("/");
  if (source[1] !== expectedSource) throw new Error(`${name} origin=${source[1]} expected=${expectedSource}`);
  const templatePath = `${prefix}skills/dagu-feature/${name}`;
  const declared = manifestVersion(git(sourceRoot, "show", `${source[2]}:${prefix}package.json`));
  if (declared !== stamp.version) throw new Error(`${name} declared=${stamp.version} source package=${declared} expected identical provenance`);
  // Versioned renders follow their templates in the same PR, so the installed checkout's template is also a valid source.
  for (const commit of [source[2], git(sourceRoot, "rev-parse", "HEAD")]) {
    const template = execFileSync("git", ["-C", sourceRoot, "show", `${commit}:${templatePath}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (isRender(contents, template)) return { ...identity(path, stamp.version, stamp.source), stamp, sourceTemplate: { path: templatePath, commit, digest: sha256(template) }, relationship: "verified-source-render", snapshot: contents };
  }
  throw new Error(`${name} digest=${sha256(contents)} expected a render of ${stamp.source}:${templatePath} or of the installed checkout`);
}

function isRender(contents: string, template: string): boolean {
  const literals = template.trimEnd().split(/__[A-Z_]+__|TEMPLATE_[A-Z_]+/);
  let remaining = contents;
  if (!remaining.startsWith(literals[0]!)) return false;
  remaining = remaining.slice(literals[0]!.length);
  for (const literal of literals.slice(1, -1)) {
    const offset = remaining.indexOf(literal);
    if (offset < 0) return false;
    remaining = remaining.slice(offset + literal.length);
  }
  const suffix = literals.at(-1)!;
  const suffixOffset = remaining.lastIndexOf(suffix);
  return literals.length === 1 ? remaining.trim() === "" : suffixOffset >= 0 && remaining.slice(suffixOffset + suffix.length).trim() === "";
}

export function admit(options: AdmissionOptions, persist = true): { path: string; receipt: Receipt } {
  try {
    const dagPath = realpathSync(resolve(options.cwd, options.dag));
    const name = basename(dagPath);
    if (!["feature.yaml", "poc.yaml", "discovery.yaml", "reconcile.yaml"].includes(name)) throw new Error(`DAG=${name} expected a distributed lifecycle DAG`);
    let primaryParam = options.params.find(param => param.startsWith("PRIMARY="))?.slice(8);
    if (name === "feature.yaml" || name === "poc.yaml") {
      const snapshot = readFileSync(dagPath, "utf8");
      const policy: Record<string, unknown> = {};
      for (const field of ["PRIMARY", "GATE", "REBASE_RESOLVER", "REQUIRED_CHECK"]) {
        const literal = new RegExp(`^  - ${field}: (.+)$`, "m").exec(snapshot)?.[1];
        if (literal) policy[field] = JSON.parse(literal);
      }
      const issue = options.params.find(param => param.startsWith("ISSUE="))?.slice(6);
      policy.BRANCH = name === "feature.yaml" ? `dagu/issue-${issue}` : `poc/${options.run}`;
      const rejected = options.params.map(param => param.slice(0, param.indexOf("=")))
        .filter(field => ["PRIMARY", "BRANCH", "GATE", "REBASE_RESOLVER", "REQUIRED_CHECK"].includes(field));
      if (rejected.length) throw new Error(`admission rejected run parameter: ${rejected.join(", ")}; adopted policy ${JSON.stringify(policy)}`);
      if (typeof policy.PRIMARY !== "string" || !policy.PRIMARY) throw new Error(`${name} requires an adoption-fixed PRIMARY`);
      primaryParam = policy.PRIMARY;
    }
    const primary = realpathSync(resolve(options.cwd, primaryParam || "."));
    const repo = realpathSync(git(primary, "rev-parse", "--show-toplevel"));
    const path = receiptPath(primary, options.run);
    const root = git(packageRoot, "rev-parse", "--show-toplevel");
    const prefix = git(packageRoot, "rev-parse", "--show-prefix");
    const commit = git(packageRoot, "rev-parse", "HEAD");
    const origin = git(packageRoot, "remote", "get-url", "origin");
    const daguHome = realpathSync(process.env.DAGU_HOME || join(homedir(), ".dagu"));
    const installedDAG = checkRender(dagPath, name, root, prefix);
    const reconciler = checkRender(join(daguHome, "dags", "reconcile.yaml"), "reconcile.yaml", root, prefix);
    const installedPackageVersion = manifestVersion(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (installedPackageVersion !== BUNDLE_VERSION) throw new Error(`loaded package version=${BUNDLE_VERSION} installed package version=${installedPackageVersion}; reload OMP`);
    const sourceTemplate = identity(join(packageRoot, "skills", "dagu-feature", name), BUNDLE_VERSION, `${origin}@${commit}`);
    const extensionFiles = tree(join(packageRoot, "src"));
    if (options.session?.extensionDigest && options.session.extensionDigest !== deploymentFingerprint(extensionFiles)) throw new Error(`loaded extension digest=${options.session.extensionDigest} expected current installed=${deploymentFingerprint(extensionFiles)}; restart OMP after redeployment`);
    const deployment = {
      package: identity(join(packageRoot, "package.json"), BUNDLE_VERSION, `${origin}@${commit}`),
      sourceTemplate, installedDAG, installedReconciler: reconciler,
      loadedExtension: { version: BUNDLE_VERSION, canonicalPath: realpathSync(join(packageRoot, "src", "triage", "index.ts")), origin: `${origin}@${commit}`, digest: deploymentFingerprint(extensionFiles), files: extensionFiles, status: identity(join(packageRoot, "src", "status", "index.ts"), BUNDLE_VERSION, `${origin}@${commit}`) },
      bootstrap: identity(join(packageRoot, "skills", "dagu-feature", "dagu-feature-bootstrap.yaml"), BUNDLE_VERSION, `${origin}@${commit}`),
      skill: identity(join(packageRoot, "skills", "dagu-feature", "SKILL.md"), BUNDLE_VERSION, `${origin}@${commit}`),
      agents: tree(join(packageRoot, "agents")),
      cli: identity(join(packageRoot, "bin", "dagu-feature-bundle.ts"), BUNDLE_VERSION, `${origin}@${commit}`),
      relationships: { packageToExtension: "same-loaded-package", templateToPackage: "same-checkout", installedToSource: "verified-source-render", compatibility: "same-major; major-zero-same-minor" },
    };
    const daguVersion = execFileSync("dagu", ["version"], { encoding: "utf8" }).trim();
    if (daguVersion !== REQUIRED_DAGU_VERSION) throw new Error(`Dagu observed=${daguVersion} expected=${REQUIRED_DAGU_VERSION}`);
    const diff = git(primary, "diff", "HEAD", "--binary");
    const dirty = git(primary, "status", "--porcelain", "--untracked-files=all");
    const config: Record<string, unknown> = {};
    for (const candidate of [join(daguHome, "config.yaml"), join(primary, ".omp", "settings.json"), join(homedir(), ".omp", "agent", "settings.json")]) {
      try { config[candidate] = sha256(readFileSync(candidate)); }
      catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        config[candidate] = { state: "unavailable", cause: "file not present" };
      }
    }
    const receipt: Receipt = {
      schemaVersion: 1, sourceVersion: { version: BUNDLE_VERSION, commit, origin }, deploymentFingerprint: deploymentFingerprint(deployment),
      initial: {
        admittedAt: new Date().toISOString(), deployment,
        runtimeAndModels: { ...fields("omp systemPromptDigest profile roles roleMapHash requestedRole resolvedModel fallback resolvedModelIsFallback crossFamilyDecision serverPid serverPpid serverStartedAt", "not exposed at admission; append a linked runtime observation when resolved"), node: { version: process.version, path: realpathSync(process.execPath) }, dagu: { version: daguVersion, path: realpathSync(execFileSync("/bin/sh", ["-c", "command -v dagu"], { encoding: "utf8" }).trim()) }, daguHome, endpoint: process.env.DAGU_URL || "http://127.0.0.1:8080", admissionPid: process.pid, admissionPpid: process.ppid, config, transcriptRoot: options.session?.transcriptRoot ?? pending("operator CLI has no OMP session context"), model: options.session?.model ?? pending("OMP model not exposed to CLI") },
        execution: { ...fields("base owner refs step approvalIteration sourceSession destinationSession triageGeneration triageMarker", "not yet resolved at admission"), repo, primary, head: git(primary, "rev-parse", "HEAD"), branch: git(primary, "branch", "--show-current"), worktree: repo, dirty, diffDigest: sha256(diff), parameters: options.params, ompSession: options.params.find(param => param.startsWith("OMP_SESSION_ID="))?.slice(15) ?? pending("OMP_SESSION_ID not supplied"), dagSnapshot: installedDAG.snapshot },
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
