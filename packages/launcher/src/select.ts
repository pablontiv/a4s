import { readServiceEnvironment } from "./service-environment.ts";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cachePath, ensureArtifact, inspectArtifact, assertCachedArtifactPresent, type CachedArtifact } from "./artifact-cache.ts";
import { artifactToken, parseArtifact, resolveRelease, sameArtifact, type ArtifactTuple } from "./release.ts";
import { assertLauncher, readJsonFile, readStateLocked, readStationState, stationTransaction, tupleFromJson, type StateDependencies } from "./station-state.ts";
import { createLeaseLocked, prepareLease, type BuildLease } from "./lease.ts";
import { bindTickLocked, readTickBinding, confirmFirstAttempt, type Attempt } from "./tick-binding.ts";
import { isRecord } from "./type-guard.ts";
import { assertProtocols, formatSupport } from "./artifact-support.ts";
import { SHARED_FORMATS } from "./contracts.ts";

export interface SelectionDependencies extends StateDependencies {
  restore?: typeof restoreArtifact;
  confirm?: (dagRunId: string) => Promise<Attempt>;
  receipt?: (path: string) => ArtifactTuple;
  cwd?: string;
}
/** Missing means restore; damaged/conflicting cache entries never trigger replacement. */
export async function restoreArtifact(home: string, tuple: ArtifactTuple): Promise<CachedArtifact> {
  try { lstatSync(cachePath(home, tuple)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const release = resolveRelease(tuple.version);
    if (!sameArtifact(release, tuple)) throw new Error(`Immutable release differs from selected tuple ${artifactToken(tuple)}`);
    return ensureArtifact(home, release);
  }
  return inspectArtifact(home, tuple);
}
export function runReceiptPath(primary: string, run: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run)) throw new Error("Invalid run ID");
  return join(execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), "receipt.json");
}
export function cancellationReceipt(primary: string, run: string): { path: string; primary: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run)) throw new Error("Invalid run ID");
  const common = execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const path = join(common, "dagu-feature", "runs", run, "receipt.json"), receipt = readJsonFile(path);
  if (!isRecord(receipt) || !isRecord(receipt.initial) || !isRecord(receipt.initial.execution) || typeof receipt.initial.execution.primary !== "string") throw new Error("Cancellation receipt lacks primary identity");
  const owner = realpathSync(receipt.initial.execution.primary);
  if (execFileSync("git", ["-C", owner, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim() !== common) throw new Error("Cancellation receipt belongs to a different repository");
  return { path, primary: owner };
}
export function receiptTuple(path: string): ArtifactTuple {
  const value = readJsonFile(path);
  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.sourceVersion) || !isRecord(value.contracts) || !isRecord(value.artifactSupport)) throw new Error(`Receipt lacks supported artifact declarations: ${path}`);
  const tuple = tupleFromJson(value.artifact);
  if (value.sourceVersion.version !== tuple.version || value.sourceVersion.commit !== tuple.commit) throw new Error(`Receipt source identity mismatch: ${path}`);
  assertProtocols(value.contracts);
  formatSupport(value.artifactSupport);
  return tuple;
}
function flag(args: string[], name: string): string | undefined {
  const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  const values = flags.flatMap((arg, index) => arg === name ? [flags[index + 1] || ""] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []);
  if (values.length > 1 || values[0] === "") throw new Error(`Ambiguous or missing ${name}`);
  return values[0];
}
export interface SelectedPayload { cached: CachedArtifact; lease: BuildLease; args: string[] }
/** Argv routing precedes tick selection. A tick's DAG_RUN_ID never selects a foreign action. */
export async function selectPayload(home: string, args: string[], dependencies: SelectionDependencies = {}): Promise<SelectedPayload> {
  if (!args.length) throw new Error("Usage: a4s <command> [args...]");
  const env = dependencies.env ?? process.env, cwd = dependencies.cwd ?? process.cwd();
  // Routing may spawn git, and tick discovery may wait on HTTP. Neither needs
  // exclusive access to the atomically published state envelope.
  const state = await readStationState(home);
  let tuple = state.current, selectedArgs = [...args], receiptPath: string | undefined;
  let tickAttempt: Attempt = "unknown";
  const admission = args[0] === "admit" || args[0] === "enqueue";
  const parent = admission ? flag(args, "--parent") : undefined;
  if (parent) receiptPath = resolve(cwd, parent);
  else if (args[0] === "run") {
    const primary = flag(args, "--primary"), run = flag(args, "--run");
    if (!primary || !run) throw new Error("Run dispatch requires --primary and --run");
    receiptPath = runReceiptPath(realpathSync(primary), run);
  } else if (args[0] === "reconcile" && (args[1] === "inspect" || args[1] === "finish")) {
    const row: unknown = JSON.parse(args[2] || "{}");
    const primary = isRecord(row) ? row[args[1] === "inspect" ? "PRIMARY" : "primary"] : undefined;
    const run = isRecord(row) ? row[args[1] === "inspect" ? "RUN" : "run"] : undefined;
    if (typeof primary !== "string" || typeof run !== "string") throw new Error("Reconcile action requires primary and run");
    receiptPath = runReceiptPath(realpathSync(primary), run);
  } else if (args[0] === "cancel") {
    const run = flag(args, "--run");
    if (!run) throw new Error("Cancel requires --run");
    receiptPath = cancellationReceipt(realpathSync(env.PRIMARY || cwd), run).path;
  } else if (args[0] === "prioritize") {
    if (!args[2]) throw new Error("Prioritize requires an existing run");
    receiptPath = runReceiptPath(realpathSync(env.PRIMARY || cwd), args[2]);
  } else if (args[0] === "observe") {
    const observation: unknown = args[1] === "runtime" ? JSON.parse(args[2] || "{}") : undefined;
    const run = args[1] === "runtime" ? (isRecord(observation) && isRecord(observation.run) && typeof observation.run.dagRunId === "string" ? observation.run.dagRunId : undefined) : args[1];
    if (!run) throw new Error("Observation requires a run");
    receiptPath = runReceiptPath(realpathSync(env.PRIMARY || cwd), run);
  } else if (args[0] === "cancellation" && env.PRIMARY && (env.RUN || env.DAG_RUN_ID)) {
    receiptPath = cancellationReceipt(realpathSync(env.PRIMARY), (env.RUN || env.DAG_RUN_ID)!).path;
  } else if (!admission && args[0] !== "tick" && env.RUN && env.PRIMARY && ["reconcile", "stale-recovery", "protect", "role-jobs", "escalation", "codeql", "poc-scope", "native"].includes(args[0]!)) {
    receiptPath = runReceiptPath(realpathSync(env.PRIMARY), env.RUN);
  } else if (args[0] === "tick") {
    if (args.length !== 1) throw new Error("Usage: a4s tick");
    const binding = readTickBinding(home, env.DAG_RUN_ID || "");
    if (binding) tuple = binding.tuple;
    else {
      tickAttempt = await (dependencies.confirm ?? (run => confirmFirstAttempt(run, env)))(env.DAG_RUN_ID || "");
      if (tickAttempt !== "first") throw new Error(`Missing tick binding for ${env.DAG_RUN_ID}; attempt=${tickAttempt}; refusing to repin`);
    }
  }
  if (receiptPath) tuple = (dependencies.receipt ?? receiptTuple)(receiptPath);
  const explicit = flag(args, "--artifact");
  if (explicit && !sameArtifact(parseArtifact(explicit), tuple)) throw new Error("Requested artifact differs from selected receipt/state tuple");
  const cached = await (dependencies.restore ?? restoreArtifact)(home, tuple);
  assertLauncher(cached.identity);
  if (!sameArtifact(cached.record, tuple)) throw new Error("Restored artifact differs from selected tuple");
  const prepared = prepareLease(tuple, state.generation, "launcher", args[0]!);
  return stationTransaction(home, async () => {
    const latest = readStateLocked(home, dependencies);
    if (!isDeepStrictEqual(latest, state)) throw new Error("Station changed during payload preparation; retry");
    assertCachedArtifactPresent(home, cached);
    if (receiptPath && !sameArtifact((dependencies.receipt ?? receiptTuple)(receiptPath), tuple)) throw new Error("Receipt changed during payload preparation; retry");
    if (receiptPath && !dependencies.receipt) {
      const receipt = readJsonFile(receiptPath);
      if (!isRecord(receipt) || !sameArtifact(receiptTuple(receiptPath), tuple) || !isDeepStrictEqual(receipt.artifactSupport, cached.identity.support) || !isRecord(receipt.contracts)) throw new Error("Receipt/cache declarations differ");
      const support = formatSupport(cached.identity.support);
      const legacy = isRecord(receipt.artifactSupport) && "receiptSchemas" in receipt.artifactSupport;
      for (const name of SHARED_FORMATS) {
        const version = receipt.contracts[name] ?? (legacy && ["roleJobPayload", "runState", "prCheckpoint"].includes(name) ? 1 : undefined);
        if (!support[name].read.includes(Number(version))) throw new Error(`Unsupported receipt ${name} contract`);
      }
    }
    if ((admission && !args.includes("--check") || args[0] === "run") && !explicit) selectedArgs = [args[0]!, "--artifact", artifactToken(tuple), ...args.slice(1)];
    if (args[0] === "tick" && !sameArtifact(bindTickLocked(home, env.DAG_RUN_ID || "", state.current, tickAttempt).tuple, tuple)) throw new Error("Tick binding changed during payload preparation; retry");
    const lease = createLeaseLocked(home, prepared);
    return { cached, lease, args: selectedArgs };
  }, dependencies);
}
export async function handoff(home: string, args: string[]): Promise<never> {
  const service = readServiceEnvironment({ ...process.env, DAGU_HOME: home });
  const selected = await selectPayload(home, args);
  const executable = selected.cached.executable;
  if (!process.execve) throw new Error("a4s-launch requires execve support");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  process.execve(executable, [executable, ...selected.args], { ...env, ...service, A4S_ARTIFACT: artifactToken(selected.lease.artifact), A4S_BIN: executable });
  throw new Error("a4s-launch did not replace the caller process");
}
