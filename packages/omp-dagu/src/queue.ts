import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

export interface RepoQueue { name: string; max_concurrency: number }
const prefix = "dagu-feature-queue-concurrency=";

function document(contents: string) {
  const doc = parseDocument(contents);
  if (doc.errors.length) throw new Error(doc.errors.map(String).join("; "));
  if (!isMap(doc.contents)) throw new Error("Expected a YAML mapping");
  return doc;
}

export function stampedQueue(contents: string): RepoQueue {
  const doc = document(contents);
  const name = doc.get("queue");
  const labels = doc.get("labels");
  const values = isSeq(labels) ? labels.toJSON().filter((label: unknown) => typeof label === "string" && label.startsWith(prefix)) as string[] : [];
  const raw = values[0]?.slice(prefix.length) ?? "";
  const max_concurrency = Number(raw);
  if (typeof name !== "string" || !name || values.length !== 1 || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(max_concurrency)) {
    throw new Error("Repository DAG requires queue and one positive integer dagu-feature-queue-concurrency label; re-run the bootstrap and adopt its renders");
  }
  return { name, max_concurrency };
}

export function currentQueueConcurrency(paths: string[]): number {
  const values = paths.filter(existsSync).flatMap(path => {
    const contents = readFileSync(path, "utf8");
    const labels = document(contents).get("labels");
    if (!isSeq(labels) || !labels.toJSON().some((label: unknown) => typeof label === "string" && label.startsWith(prefix))) return [];
    return [stampedQueue(contents).max_concurrency];
  });
  if (new Set(values).size > 1) throw new Error("Current renders disagree on queue concurrency; restore matching repo stamps before bootstrap");
  return values[0] ?? 1;
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

export function queueCompatibility(contents: string, queue: RepoQueue): string {
  try {
    const derived = deriveQueue(contents, queue);
    if (!derived.changed) return `queue=${queue.name} max_concurrency=${queue.max_concurrency} compat=ok`;
  } catch (error) {
    return `queue=${queue.name} max_concurrency=${queue.max_concurrency} compat=incompatible cause=${JSON.stringify(String(error))} action=re-run-bootstrap`;
  }
  return `queue=${queue.name} max_concurrency=${queue.max_concurrency} compat=incompatible action=re-run-bootstrap`;
}

export type ServiceCommand = (command: string, args: string[]) => string;
const execute: ServiceCommand = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function schedulerRestart(home: string, run: ServiceCommand = execute): { description: string; restart: () => void } {
  const target = `gui/${process.getuid!()}/local.dagu.server`;
  try {
    const service = run("launchctl", ["print", target]);
    const path = /^\s*path = (.+)$/m.exec(service)?.[1];
    if (!path || !/^\s*state = running$/m.test(service) || !/^\s*pid = [1-9][0-9]*$/m.test(service)) throw new Error("service is not running");
    const plist = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", path])) as { ProgramArguments?: string[]; EnvironmentVariables?: { DAGU_HOME?: string } };
    const args = plist.ProgramArguments;
    const configuredHome = plist.EnvironmentVariables?.DAGU_HOME || join(homedir(), ".dagu");
    if (!args || args.length !== 2 || basename(args[0] ?? "") !== "dagu" || args[1] !== "start-all" || realpathSync(configuredHome) !== realpathSync(home)) throw new Error("service command/home does not match");
    return { description: `launchctl kickstart -k ${target}`, restart: () => { run("launchctl", ["kickstart", "-k", target]); } };
  } catch (error) {
    throw new Error(`Cannot determine scheduler restart for DAGU_HOME=${resolve(home)}: require a running launchd local.dagu.server using dagu start-all with this DAGU_HOME; install/load the matching service and re-run bootstrap. ${String(error)}`);
  }
}

export function reconcileQueue(home: string, queue: RepoQueue, run: ServiceCommand = execute): string {
  const path = join(home, "config.yaml");
  const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const result = deriveQueue(original ?? "", queue);
  const service = schedulerRestart(home, run);
  if (result.changed) {
    console.error(`scheduler_restart=${service.description}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(path, result.content);
    try { service.restart(); }
    catch (error) {
      if (original === undefined) rmSync(path);
      else writeFileSync(path, original);
      throw new Error(`Scheduler restart failed; restored config.yaml so bootstrap can be retried: ${String(error)}`);
    }
  }
  return `queue=${queue.name} max_concurrency=${queue.max_concurrency} changed=${result.changed ? "yes" : "no"}`;
}
