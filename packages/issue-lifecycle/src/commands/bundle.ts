import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { appendObservation, enqueue, parseObservation, receiptPath, observeRunReceipt } from "../admission.ts";
import { CONFIG_PATH, configFromEnvironment, readConfigFile, readCommittedConfig, serializeConfig } from "../../../launcher/src/config.ts";
import { validatePlanningUnitsCommand } from "../planning-validator.ts";
import { planningReviewer, type TranscriptRow } from "../transcript-identity.ts";
import { BUNDLE_VERSION, lifecycleProtocolToken } from "../bundle.ts";
import { queueReadiness, stationReadiness } from "../queue.ts";
import { main as escalation } from "../escalation.ts";
import { executingRunArtifact, invokeRun } from "../run-artifact.ts";
import type { RunDetails } from "../status/progress.ts";
import { isRecord } from "../../../launcher/src/type-guard.ts";

interface RuntimeObservation {
  run: RunDetails;
  kind: string;
  error?: string;
  observer: { observerPid: number; observerPpid: number; loadedExtensionDigest: string };
}
function runtimeObservation(input: string): RuntimeObservation {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || !isRecord(value.run) || !isRecord(value.observer)
    || typeof value.run.dagRunId !== "string" || typeof value.run.name !== "string" || typeof value.run.statusLabel !== "string"
    || typeof value.kind !== "string" || (value.error !== undefined && typeof value.error !== "string")
    || typeof value.observer.observerPid !== "number" || typeof value.observer.observerPpid !== "number"
    || typeof value.observer.loadedExtensionDigest !== "string") throw new Error("Invalid runtime observation");
  return value as unknown as RuntimeObservation;
}


function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repositoryName(path: string): string {
  try {
    const remote = git(path, "remote", "get-url", "origin")
      .replace(/^git@[^:]+:/, "")
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/^file:\/\//, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/$/, "");
    const parts = remote.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : basename(path);
  } catch {
    return basename(path);
  }
}

function inspectConfig(repo: string): boolean {
  const path = join(repo, CONFIG_PATH);
  try {
    const loaded = readCommittedConfig(repo);
    const report = queueReadiness(process.env.DAGU_HOME || join(homedir(), ".dagu"), loaded.config.lane);
    console.log(`config path=${CONFIG_PATH} schema=${loaded.config.schemaVersion} digest=${loaded.digest} lane=${loaded.config.lane} base=${loaded.config.baseBranch} ${report}`);
    console.log(`config policy gate=${JSON.stringify(loaded.config.gate)} requiredCheck=${JSON.stringify(loaded.config.requiredCheck)} testPaths=${JSON.stringify(loaded.config.testPaths)}`);
    return report.includes("ready=yes");
  } catch (error) {
    console.log(`config path=${path} compat=invalid cause=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    return false;
  }
}

function resolveRepository(argument: string): string | undefined {
  try {
    return git(resolve(argument), "rev-parse", "--show-toplevel");
  } catch {
    console.error(`repo path=${resolve(argument)} error=not-a-git-worktree`);
    return undefined;
  }
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "escalation") {
    await escalation(args);
    return;
  }
  if (command === "validate-planning-units") {
    process.exitCode = validatePlanningUnitsCommand(args);
    return;
  }
  if (command === "planning-reviewer-identity") {
    try {
      const file = args[0] === "--transcript" ? args[1] : undefined;
      if (!file) throw new Error("Usage: planning-reviewer-identity --transcript <jsonl>");
      const text = readFileSync(file, "utf8").trim();
      const rows = text ? text.split("\n").map(line => JSON.parse(line) as TranscriptRow) : [];
      console.log(JSON.stringify(planningReviewer(rows)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "protocols") {
    console.log(lifecycleProtocolToken());
    return;
  }
  if (command === "write-config" || command === "config-check") {
    try {
      if (command === "write-config") {
        const dest = args[0];
        if (!dest) throw new Error("write-config requires the consumer config path");
        const config = configFromEnvironment(process.env);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, serializeConfig(config));
        console.log(`config=${dest} schema=${config.schemaVersion}`);
      } else {
        const file = args[0];
        if (!file) throw new Error("config-check requires the consumer config path");
        const config = readConfigFile(file);
        console.log(`config=${file} schema=${config.schemaVersion} lane=${config.lane}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "readiness") {
    try {
      const lane = args.length === 2 && args[0] === "--lane" ? args[1]
        : args.length === 1 ? readConfigFile(args[0]!).lane : undefined;
      if (!lane) throw new Error("Usage: readiness <config> | readiness --lane <lane>");
      const report = await stationReadiness(process.env.DAGU_HOME || join(homedir(), ".dagu"), lane);
      console.log(report.checks.join("\n"));
      process.exitCode = report.ready ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "admit" || command === "enqueue") {
    try {
      process.exitCode = await enqueue(args, process.cwd());
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "observe") {
    try {
      const [run, input] = args;
      const runtime = run === "runtime" ? runtimeObservation(input || "{}") : undefined;
      const selectedRun = runtime?.run.dagRunId ?? run;
      if (!selectedRun) throw new Error("Receipt observation requires an admitted run");
      if (!executingRunArtifact()) {
        process.exitCode = (await invokeRun(process.env.PRIMARY || process.cwd(), selectedRun, ["observe", ...args])).status;
        return;
      }
      if (selectedRun !== process.env.RUN) throw new Error("Observation run differs from the dispatched receipt");
      if (runtime) {
        observeRunReceipt(runtime.run, process.env.PRIMARY!, runtime.kind, runtime.error, runtime.observer);
        return;
      }
      if (!run || !input) throw new Error("Usage: observe <run> '<JSON observation with dag/run/attempt/category/kind/data>'");
      const observation = parseObservation(JSON.parse(input));
      if (observation.run !== run) throw new Error("Observation names another run");
      appendObservation(receiptPath(process.cwd(), run), observation);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
const argumentsOrCwd = argv.length ? argv : [process.cwd()];
let ok = true;
for (const argument of argumentsOrCwd) {
  const path = resolveRepository(argument);
  if (!path) {
    ok = false;
    continue;
  }
  console.log(`repo=${repositoryName(path)} path=${path} bundle=${BUNDLE_VERSION}`);
  ok = inspectConfig(path) && ok;
}

const daguHome = process.env.DAGU_HOME || join(homedir(), ".dagu");
const reconciler = join(daguHome, "dags", "reconcile.yaml");
if (!existsSync(reconciler)) {
  console.log(`reconcile.yaml path=${reconciler} installed=absent`);
  ok = false;
} else {
  console.log(`reconcile.yaml path=${reconciler} installed=yes`);
}
const dagu = spawnSync("dagu", ["version"], { encoding: "utf8" });
const daguOk = dagu.status === 0;
const observed = dagu.status === null ? "unavailable" : JSON.stringify(dagu.stdout.replace(/\n$/, ""));
console.log(`dagu version=${observed}`);
ok = daguOk && ok;
process.exitCode = ok ? 0 : 1;
}
