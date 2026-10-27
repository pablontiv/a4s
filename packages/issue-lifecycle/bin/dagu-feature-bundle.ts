#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admit, appendObservation, enqueue, enqueueArguments, parseObservation, receiptPath } from "../src/admission.ts";
import { ANSWERS_PATH, answersFromEnvironment, readAnswersFile, readCommittedAnswers, serializeAnswers } from "../src/answers.ts";
import { validatePlanningUnitsCommand } from "../src/planning-validator.ts";
import { planningReviewer, type TranscriptRow } from "../src/transcript-identity.ts";
import { BUNDLE_VERSION, lifecycleProtocolToken, REQUIRED_DAGU_VERSION } from "../src/bundle.ts";
import { dagName, materializeInstalled } from "../src/materialize.ts";
import { currentQueueConcurrency, queueCompatibility, queueFromAnswersFile, reconcileQueue } from "../src/queue.ts";

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
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

function inspectAnswers(repo: string): boolean {
  const path = join(repo, ANSWERS_PATH);
  try {
    const loaded = readCommittedAnswers(repo);
    const queue = queueFromAnswersFile(path);
    const report = queueCompatibility(process.env.DAGU_HOME || join(homedir(), ".dagu"), queue);
    console.log(`answers path=${ANSWERS_PATH} schema=${loaded.answers.schemaVersion} digest=${loaded.digest} lane=${loaded.answers.lane} base=${loaded.answers.baseBranch} ${report}`);
    console.log(`answers policy gate=${JSON.stringify(loaded.answers.gate)} requiredCheck=${JSON.stringify(loaded.answers.requiredCheck)} testPaths=${JSON.stringify(loaded.answers.testPaths)}`);
    return report.endsWith("compat=ok");
  } catch (error) {
    console.log(`answers path=${path} compat=invalid cause=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
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
  if (command === "write-answers" || command === "answers-check" || command === "install-reconciler") {
    try {
      if (command === "write-answers") {
        const dest = args[0];
        if (!dest) throw new Error("write-answers requires the consumer answers path");
        const answers = answersFromEnvironment(process.env);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, serializeAnswers(answers));
        console.log(`answers=${dest} schema=${answers.schemaVersion}`);
      } else if (command === "answers-check") {
        const file = args[0];
        if (!file) throw new Error("answers-check requires the consumer answers path");
        const answers = readAnswersFile(file);
        console.log(`answers=${file} schema=${answers.schemaVersion} lane=${answers.lane} queue=${answers.queueConcurrency}`);
      } else {
        const [file, dest] = args;
        if (!file || !dest) throw new Error("install-reconciler requires <answers> <reconcile.yaml>");
        const text = materializeInstalled(dagName("reconcile.yaml"), readAnswersFile(file));
        mkdirSync(dirname(dest), { recursive: true });
        if (readIfPresent(dest) !== text) writeFileSync(dest, text);
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
        if (args.length !== 1) throw new Error(`${command} requires one answers file`);
        const queue = queueFromAnswersFile(args[0]!);
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
  ok = inspectAnswers(path) && ok;
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
const daguOk = dagu.status === 0
  && dagu.stdout === `${REQUIRED_DAGU_VERSION}\n`
  && dagu.stderr === "";
const observed = dagu.status === null ? "unavailable" : JSON.stringify(dagu.stdout.replace(/\n$/, ""));
console.log(`dagu version=${observed} required=${REQUIRED_DAGU_VERSION} compat=${daguOk ? "ok" : "incompatible"}`);
ok = daguOk && ok;
process.exitCode = ok ? 0 : 1;
}
main();
