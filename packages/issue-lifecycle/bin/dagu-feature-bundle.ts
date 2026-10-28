#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admit, appendObservation, enqueue, enqueueArguments, parseObservation, receiptPath } from "../src/admission.ts";
import { CONFIG_PATH, configFromEnvironment, readConfigFile, readCommittedConfig, serializeConfig } from "../src/config.ts";
import { validatePlanningUnitsCommand } from "../src/planning-validator.ts";
import { planningReviewer, type TranscriptRow } from "../src/transcript-identity.ts";
import { BUNDLE_VERSION, lifecycleProtocolToken } from "../src/bundle.ts";
import { dagName, materializeInstalled } from "../src/materialize.ts";
import { currentQueueConcurrency, queueCompatibility, queueFromConfigFile, reconcileQueue } from "../src/queue.ts";

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function replaceIfChanged(dest: string, text: string): void {
  if (readIfPresent(dest) === text) return;
  const stage = mkdtempSync(join(dirname(dest), ".reconcile-"));
  try {
    const temporary = join(stage, basename(dest));
    writeFileSync(temporary, text);
    renameSync(temporary, dest);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
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
    const queue = queueFromConfigFile(path);
    const report = queueCompatibility(process.env.DAGU_HOME || join(homedir(), ".dagu"), queue);
    console.log(`config path=${CONFIG_PATH} schema=${loaded.config.schemaVersion} digest=${loaded.digest} lane=${loaded.config.lane} base=${loaded.config.baseBranch} ${report}`);
    console.log(`config policy gate=${JSON.stringify(loaded.config.gate)} requiredCheck=${JSON.stringify(loaded.config.requiredCheck)} testPaths=${JSON.stringify(loaded.config.testPaths)}`);
    return report.endsWith("compat=ok");
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

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "escalation") {
    const result = spawnSync("python3", [fileURLToPath(new URL("../skills/issue-execution/escalation.py", import.meta.url)), ...args], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
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
  if (command === "write-config" || command === "config-check" || command === "install-reconciler") {
    try {
      if (command === "write-config") {
        const dest = args[0];
        if (!dest) throw new Error("write-config requires the consumer config path");
        const config = configFromEnvironment(process.env);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, serializeConfig(config));
        console.log(`config=${dest} schema=${config.schemaVersion}`);
      } else if (command === "config-check") {
        const file = args[0];
        if (!file) throw new Error("config-check requires the consumer config path");
        const config = readConfigFile(file);
        console.log(`config=${file} schema=${config.schemaVersion} lane=${config.lane} queue=${config.queueConcurrency}`);
      } else {
        const [file, dest] = args;
        if (!file || !dest) throw new Error("install-reconciler requires <config> <reconcile.yaml>");
        const text = materializeInstalled(dagName("reconcile.yaml"), readConfigFile(file));
        mkdirSync(dirname(dest), { recursive: true });
        replaceIfChanged(dest, text);
        console.log(`reconcile=${dest}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "queue-default" || command === "queue-reconcile" || command === "queue-check") {
    try {
      if (command === "queue-default") console.log(currentQueueConcurrency(args));
      else {
        if (args.length !== 1) throw new Error(`${command} requires one config file`);
        const queue = queueFromConfigFile(args[0]!);
        const home = process.env.DAGU_HOME || join(homedir(), ".dagu");
        if (command === "queue-reconcile") console.log(reconcileQueue(home, queue));
        else {
          const report = queueCompatibility(home, queue);
          console.log(report);
          if (!report.endsWith("compat=ok")) process.exitCode = 1;
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "admit" || command === "enqueue") {
    try {
      if (command === "enqueue") process.exitCode = enqueue(args, process.cwd());
      else {
        const result = admit(enqueueArguments(args, process.cwd()));
        console.log(JSON.stringify(result));
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "observe") {
    try {
      const [run, input] = args;
      if (!run || !input) throw new Error("Usage: observe <run> '<JSON observation with dag/run/attempt/category/kind/data>'");
      const observation = parseObservation(JSON.parse(input));
      appendObservation(receiptPath(process.cwd(), run), observation);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
const argumentsOrCwd = process.argv.length > 2 ? process.argv.slice(2) : [process.cwd()];
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
main();
