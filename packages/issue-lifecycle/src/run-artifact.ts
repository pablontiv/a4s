import { readServiceEnvironment } from "../../launcher/src/service-environment.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";

import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { receiptArtifact, assertExecutingArtifact } from "./artifact-receipt.ts";
import { artifactToken, parseArtifact, sameArtifact } from "../../launcher/src/release.ts";
import { compiled } from "./executable.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";
import { fileDigest, inspectArtifact, type CachedArtifact } from "../../launcher/src/artifact-cache.ts";
import { identity } from "./identity.ts";
import type { Receipt } from "./admission.ts";
import { restoreArtifact } from "../../launcher/src/select.ts";
import { createLeaseLocked } from "../../launcher/src/lease.ts";
import { stationRoot, stationTransaction } from "../../launcher/src/station-state.ts";

const NATIVE_FLAGS: Record<string, "value" | "boolean"> = {
  "--run-id": "value", "-r": "value", "--step": "value", "--sub-run-id": "value", "-s": "value",
  "--expected-iteration": "value", "--input": "value", "--feedback": "value",
  "--downstream": "boolean", "--bypass-preconditions": "boolean",
};
let bound: VerifiedRun | undefined;
export function executingRunArtifact(): boolean { return bound !== undefined; }
export function runArtifactState(): string {
  if (!bound) throw new Error("Run state requires a verified receipt-bound dispatch");
  return bound.state;
}
export interface VerifiedRun { primary: string; home: string; state: string; path: string; receipt: Receipt; cached: CachedArtifact }
export async function verifiedRun(primary: string, run: string, inspect = restoreArtifact): Promise<VerifiedRun> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run)) throw new Error("Run artifact requires an unambiguous run ID");
  primary = realpathSync(primary);
  const home = realpathSync(readServiceEnvironment().DAGU_HOME);
  const state = execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`], { encoding: "utf8" }).trim();
  const path = join(state, "receipt.json");
  const { receipt: value, cached } = await receiptArtifact(home, path, inspect);
  const receipt = value as unknown as Receipt;
  if (receipt.runReceipt?.run !== run || receipt.initial.execution.primary !== primary || receipt.initial.runtimeAndModels.daguHome !== home) throw new Error(`Run receipt location/identity mismatch: ${path}`);
  return { primary, home, state, path, receipt, cached };
}

/** Verification lives for one tick, never across ticks or plugin actions. */
export class RunArtifactScope {
  readonly #artifacts = new Map<string, Promise<CachedArtifact>>();
  #executableDigest: Promise<string> | undefined;
  private readonly inspect: typeof inspectArtifact;
  constructor(inspect = restoreArtifact) { this.inspect = inspect; }
  get artifactVerifications(): number { return this.#artifacts.size; }
  verify(primary: string, run: string): Promise<VerifiedRun> {
    return verifiedRun(primary, run, (home, tuple) => {
      const key = `${home}/${artifactToken(tuple)}`;
      let cached = this.#artifacts.get(key);
      if (!cached) { cached = this.inspect(home, tuple); this.#artifacts.set(key, cached); }
      return cached;
    });
  }
  // These package-independent actions read no implementation assets outside the
  // executable. Other run commands continue through their cached process.
  async locally<T>(context: VerifiedRun, phase: "inspect" | "finish", execute: () => T): Promise<{ local: true; value: T } | { local: false }> {
    const { cached } = context;
    const pin = process.env.A4S_ARTIFACT;
    if (!compiled || !pin || !sameArtifact(parseArtifact(pin), cached.record) ||
        identity.version !== cached.record.version || identity.commit !== cached.record.commit) return { local: false };
    // An identity string is not byte identity. Only the exact pinned tuple and
    // its verified executable bytes authorize running this process's code.
    if (realpathSync(process.execPath) !== cached.executable &&
        await (this.#executableDigest ??= fileDigest(process.execPath)) !== cached.executableDigest) return { local: false };
    const nextEnvironment = environment(context), previous = bound, previousEnvironment = process.env;
    bound = context;
    process.env = nextEnvironment;
    try {
      console.error(`a4s-run run=${context.receipt.runReceipt.run} artifact=${artifactToken(cached.record)} command=reconcile ${phase} dispatch=in-process`);
      return { local: true, value: execute() };
    } finally { bound = previous; process.env = previousEnvironment; }
  }
}
function environment(context: VerifiedRun): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...readServiceEnvironment(), PRIMARY: context.primary, RUN: context.receipt.runReceipt.run,
    A4S_BIN: context.cached.executable, A4S_ARTIFACT: artifactToken(context.cached.record) };
  // The run's admitted policy, not the station reconciler's policy, is authoritative.
  const snapshot: unknown = parseAllDocuments(context.receipt.initial.execution.dagSnapshot)[0]?.toJSON();
  if (isRecord(snapshot) && Array.isArray(snapshot.env)) for (const entry of snapshot.env) {
    if (isRecord(entry)) for (const [key, value] of Object.entries(entry)) {
      if ((/^ESCALATION_/.test(key) || ["DAGU_URL", "DAGU_HOME", "PATH", "A4S_SERVICE_ENV"].includes(key)) && (typeof value === "string" || typeof value === "number")) env[key] = String(value);
    }
  }
  // A changed declaration cannot silently retarget a previously admitted run.
  readServiceEnvironment(env);
  return env;
}
export async function invokeRun(primary: string, run: string, args: string[], options: { capture?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  const home = realpathSync(readServiceEnvironment().DAGU_HOME);
  const { context, lease } = await stationTransaction(home, async () => {
    const context = await verifiedRun(primary, run);
    return { context, lease: createLeaseLocked(home, context.cached.record, 0, "launcher", `run ${run}`) };
  });
  const token = artifactToken(context.cached.record);
  try {
  return await new Promise((resolve, reject) => {
    const child = spawn(context.cached.executable, ["run", "--primary", context.primary, "--run", run, "--artifact", token, "--", ...args], {
      cwd: context.primary, env: { ...environment(context), ...Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) => ["ISSUE", "BRANCH", "PR_NUMBER", "REPO", "DAGU_OUTPUT_FILE"].includes(key))) }, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ status: code ?? 1, stdout, stderr }));
  });
  } finally { rmSync(join(stationRoot(context.home), "leases", `${lease.id}.json`), { force: true }); }
}
/** Native transitions cannot change the receipt's DAG/run or station binding. */
export function executeNative(args: string[]): void {
  if (!bound || !["human-task", "retry", "stop"].includes(args[0] || "")) throw new Error("Native mutation requires a receipt-bound action");
  const positional: string[] = [], runs: string[] = [];
  for (let index = args[0] === "human-task" ? 2 : 1; index < args.length; index++) {
    const argument = args[index]!, equal = argument.indexOf("=");
    const flag = equal < 0 ? argument : argument.slice(0, equal);
    if (NATIVE_FLAGS[flag] === "value") {
      const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
      if (!value || value.startsWith("--")) throw new Error(`Native mutation missing ${flag}`);
      if (flag === "--run-id" || flag === "-r") runs.push(value);
    } else if (NATIVE_FLAGS[argument] !== "boolean") {
      if (argument.startsWith("-")) throw new Error(`Unsupported native mutation flag ${argument}; station overrides are not allowed`);
      positional.push(argument);
    }
  }
  if (runs.length !== 1 || runs[0] !== bound.receipt.runReceipt.run || positional.length !== 1 || positional[0] !== bound.receipt.runReceipt.dag) throw new Error("Native mutation differs from the receipt's DAG/run binding");
  // Retry/resume (and terminal handlers) can execute in this process's PATH,
  // not the scheduler's. Fail before invoking Dagu rather than partly running.
  const tools = spawnSync("bash", ["-c", 'missing=0; for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || { printf "a4s native: required command not found: %s (caller PATH; no Dagu mutation started)\\n" "$tool" >&2; missing=1; }; done; exit "$missing"',
    "a4s-native", "bash", "git", "gh", "jq", "curl", "node", "omp", "dagu"], { encoding: "utf8" });
  if (tools.error) throw new Error(`a4s native: required command unavailable: bash; no Dagu mutation started (${tools.error.message})`);
  if (tools.status !== 0) throw new Error(tools.stderr.trim() || "a4s native: toolchain preflight failed; no Dagu mutation started");
  const result = spawnSync("dagu", args, { stdio: "inherit", env: { ...process.env, ...readServiceEnvironment() } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
export async function main(args: string[], execute: (args: string[]) => Promise<void>): Promise<void> {
  const separator = args.indexOf("--");
  const flags = args.slice(0, separator);
  if (separator < 0 || !args[separator + 1] || flags.length % 2) throw new Error("Usage: a4s run --primary <path> --run <id> [--artifact <tuple>] -- <command> [args...]");
  const values = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index]!;
    if (!["--primary", "--run", "--artifact"].includes(key) || values.has(key)) throw new Error(`Invalid run dispatch flag ${key}`);
    values.set(key, flags[index + 1]!);
  }
  const primary = values.get("--primary"), run = values.get("--run");
  if (!primary || !run) throw new Error("Run dispatch requires --primary and --run");
  const context = await verifiedRun(primary, run);
  const command = args.slice(separator + 1);
  if (!["reconcile", "stale-recovery", "protect", "role-jobs", "observe", "escalation", "codeql", "poc-scope", "admit", "enqueue", "native"].includes(command[0]!)) throw new Error(`Unsupported run action ${command[0]}`);
  const requested = values.get("--artifact");
  if (!requested) { process.exitCode = (await invokeRun(primary, run, command)).status; return; }
  if (!sameArtifact(parseArtifact(requested), context.cached.record)) throw new Error("Run handoff tuple differs from the receipt/cache");
  assertExecutingArtifact(context.cached.record);
  if (!compiled || realpathSync(process.execPath) !== context.cached.executable) throw new Error("Run actions require the receipt's cached executable");
  Object.assign(process.env, environment(context));
  bound = context;
  console.error(`a4s-run run=${run} artifact=${artifactToken(context.cached.record)} command=${command.slice(0, 2).join(" ")}`);
  await execute(command);
}
