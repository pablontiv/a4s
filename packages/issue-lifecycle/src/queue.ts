import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { readAnswersFile, type LifecycleAnswers } from "./answers.ts";

export interface RepoQueue { name: string; max_concurrency: number }

function document(contents: string) {
  const doc = parseDocument(contents);
  if (doc.errors.length) throw new Error(doc.errors.map(String).join("; "));
  if (!isMap(doc.contents)) throw new Error("Expected a YAML mapping");
  return doc;
}

function optionalRead(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function answersQueue(answers: LifecycleAnswers): RepoQueue {
  return { name: answers.lane, max_concurrency: answers.queueConcurrency };
}

export function queueFromAnswersFile(path: string): RepoQueue {
  return answersQueue(readAnswersFile(path));
}

export function currentQueueConcurrency(paths: string[]): number {
  const queues: RepoQueue[] = [];
  for (const path of paths) {
    if (optionalRead(path) === undefined) continue;
    queues.push(queueFromAnswersFile(path));
  }
  if (new Set(queues.map(queue => `${queue.name}:${queue.max_concurrency}`)).size > 1) throw new Error("Answers files disagree on queue concurrency; commit one lane policy before bootstrap");
  return queues[0]?.max_concurrency ?? 1;
}

export function deriveQueue(contents: string, queue: RepoQueue): { content: string; changed: boolean } {
  const doc = document(contents || "{}\n");
  if (!Number.isSafeInteger(queue.max_concurrency) || queue.max_concurrency < 1 || !queue.name) throw new Error("Queue requires a name and positive integer concurrency");
  const queues = doc.get("queues", true);
  if (queues !== undefined && !isMap(queues)) throw new Error("queues must be a mapping");
  const entries = doc.getIn(["queues", "config"], true);
  if (entries !== undefined && !isSeq(entries)) throw new Error("queues.config must be a sequence");
  const matching: number[] = [];
  if (isSeq(entries)) entries.items.forEach((entry, index) => {
    if (!isMap(entry) || typeof entry.get("name") !== "string") throw new Error("queues.config entries require names");
    if (entry.get("name") === queue.name) matching.push(index);
  });
  if (matching.length > 1) throw new Error(`Duplicate queue ${queue.name} in config.yaml`);
  const index = matching[0];
  if (index !== undefined && doc.getIn(["queues", "config", index, "max_concurrency"]) === queue.max_concurrency) return { content: contents, changed: false };
  if (index === undefined) {
    if (entries === undefined) doc.setIn(["queues", "config"], [queue]);
    else entries.add(queue);
  } else doc.setIn(["queues", "config", index, "max_concurrency"], queue.max_concurrency);
  return { content: doc.toString(), changed: true };
}

export function queueCompatibility(home: string, queue: RepoQueue): string {
  try {
    if (!deriveQueue(optionalRead(join(home, "config.yaml")) ?? "", queue).changed) return `queue=${queue.name} max_concurrency=${queue.max_concurrency} compat=ok`;
  } catch (error) {
    return `queue=${queue.name} max_concurrency=${queue.max_concurrency} compat=incompatible cause=${JSON.stringify(String(error))} action=re-run-bootstrap`;
  }
  return `queue=${queue.name} max_concurrency=${queue.max_concurrency} compat=incompatible action=re-run-bootstrap`;
}

type ServiceCommand = (command: string, args: string[]) => string;
const execute: ServiceCommand = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function schedulerRestart(home: string, run: ServiceCommand): () => void {
  const target = `gui/${process.getuid!()}/local.dagu.server`;
  try {
    const service = run("launchctl", ["print", target]);
    const path = /^\s*path = (.+)$/m.exec(service)?.[1];
    if (!path || !/^\s*state = running$/m.test(service) || !/^\s*pid = [1-9][0-9]*$/m.test(service)) throw new Error("service is not running");
    const plist = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", path])) as { ProgramArguments?: string[]; EnvironmentVariables?: { DAGU_HOME?: string } };
    const args = plist.ProgramArguments;
    const configuredHome = plist.EnvironmentVariables?.DAGU_HOME || join(homedir(), ".dagu");
    if (!args || args.length !== 2 || basename(args[0] ?? "") !== "dagu" || args[1] !== "start-all" || realpathSync(configuredHome) !== realpathSync(home)) throw new Error("service command/home does not match");
    return () => { run("launchctl", ["kickstart", "-k", target]); };
  } catch (error) {
    throw new Error(`Cannot determine scheduler restart for DAGU_HOME=${resolve(home)}: require a running launchd local.dagu.server using dagu start-all with this DAGU_HOME; install/load the matching service and re-run bootstrap. ${String(error)}`);
  }
}

export function reconcileQueue(home: string, queue: RepoQueue, run: ServiceCommand = execute): string {
  mkdirSync(home, { recursive: true });
  // Share exclusion with station installation; never check a path before writing it.
  const lock = join(home, ".station-install.lock");
  mkdirSync(lock);
  let stage: string | undefined;
  try {
    const path = join(home, "config.yaml");
    const original = optionalRead(path);
    const result = deriveQueue(original ?? "", queue);
    if (result.changed) {
      const restart = schedulerRestart(home, run);
      stage = mkdtempSync(join(home, ".queue-config-"));
      const replacement = join(stage, "config.yaml");
      writeFileSync(replacement, result.content, { mode: 0o600 });
      renameSync(replacement, path);
      try { restart(); }
      catch (error) {
        if (original === undefined) rmSync(path);
        else {
          writeFileSync(replacement, original, { mode: 0o600 });
          renameSync(replacement, path);
        }
        throw new Error(`Scheduler restart failed; restored config.yaml so bootstrap can be retried: ${String(error)}`);
      }
    }
    return `queue=${queue.name} max_concurrency=${queue.max_concurrency} changed=${result.changed ? "yes" : "no"}`;
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
  }
}
