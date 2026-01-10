import { appendFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "./type-guard.ts";

const queueName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Adoption source seam: the current single lane uses the repository's adopted queue.
 * Lane adoption supplies mappingFromSnapshot(snapshot).queue here when integrated.
 */
export function adoptionQueue(repository: string): string {
  if (!queueName.test(repository)) throw new Error(`QUEUE_REJECTED queue=${repository} expected=a declared queue name; repeat bootstrap/adoption`);
  return repository;
}

/** Read one declaration, independently of workspace labels and run parameters. */
export function declaredQueue(snapshot: string): string {
  const declarations = [...snapshot.matchAll(/^queue\s*:(.*)$/gm)];
  if (declarations.length !== 1) throw new Error(`QUEUE_REJECTED queue=unknown expected=exactly-one-declaration observed=${declarations.length}; repeat bootstrap/adoption`);
  const literal = declarations[0]![1]!.trim();
  const queue: unknown = literal.startsWith('"') ? JSON.parse(literal) : literal;
  if (typeof queue !== "string" || !queueName.test(queue)) throw new Error(`QUEUE_REJECTED queue=${literal || "unknown"} expected=a declared queue name; repeat bootstrap/adoption`);
  // The command literal is part of the provenance-verified immutable snapshot.
  const gates = [...snapshot.matchAll(/^    run: dagu-feature-bundle queue-gate (.+)$/gm)];
  if (gates.length !== 1 || gates[0]![1] !== JSON.stringify(queue)) throw new Error(`QUEUE_REJECTED queue=${queue} expected=the sealed queue_gate declaration; repeat bootstrap/adoption`);
  return queue;
}

/** Dagu 2.20.1's local file store: identify this attempt by its log paths, never recency. */
export function queueGate(expected: string, env: NodeJS.ProcessEnv = process.env): void {
  let actual = "unknown";
  let attempt = "unknown";
  const dag = env.DAG_NAME || "unknown";
  const run = env.DAG_RUN_ID || "unknown";
  const primary = env.PRIMARY || "unknown";
  const diagnostic = () => `dag=${dag} run=${run} attempt=${attempt} lane=main queue=${actual} expected=${expected} primary=${primary}`;
  try {
    if (!queueName.test(expected)) throw new Error("missing or invalid sealed queue");
    const required = (key: string): string => {
      const value = env[key];
      if (!value) throw new Error(`missing ${key}; use the pinned Dagu local data/log layout`);
      return value;
    };
    if (!queueName.test(required("DAG_NAME")) || !queueName.test(required("DAG_RUN_ID"))) throw new Error("unsupported DAG/run path identity");
    const home = required("DAGU_HOME");
    const log = required("DAG_RUN_LOG_FILE");
    const stdout = required("DAG_RUN_STEP_STDOUT_FILE");
    const stderr = required("DAG_RUN_STEP_STDERR_FILE");
    if (![home, log, stdout, stderr].every(isAbsolute)) throw new Error("absolute home and log paths required");
    const runLog = dirname(log);
    const runDirectory = basename(runLog);
    const date = /^dag-run_(\d{4})(\d{2})(\d{2})_(\d{6})Z_(.+)$/.exec(runDirectory);
    if (!date || date[5] !== run) throw new Error("run log identity mismatch");
    const utc = new Date(`${date[1]}-${date[2]}-${date[3]}T${date[4]!.slice(0, 2)}:${date[4]!.slice(2, 4)}:${date[4]!.slice(4)}Z`);
    if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== `${date[1]}-${date[2]}-${date[3]}`) throw new Error("invalid UTC run directory date");
    const attemptLog = dirname(stdout);
    const identity = /^run_\d{8}_\d{6}Z_([A-Za-z0-9]+)$/.exec(basename(attemptLog));
    if (!identity || dirname(stderr) !== attemptLog || dirname(attemptLog) !== runLog) throw new Error("attempt log identity mismatch");
    attempt = identity[1]!;
    const runPath = join(realpathSync(home), "data", "dag-runs", dag, "dag-runs", date[1]!, date[2]!, date[3]!, runDirectory);
    const matches = readdirSync(runPath, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("a_") && entry.name.endsWith(`_${attempt}`));
    if (matches.length !== 1) throw new Error(`expected exactly one persisted matching attempt; observed=${matches.length}`);
    const directory = join(runPath, matches[0]!.name);
    if (realpathSync(directory) !== resolve(directory)) throw new Error("persisted attempt path is not canonical");
    const persisted: unknown = JSON.parse(readFileSync(join(directory, "dag.json"), "utf8"));
    const statuses: unknown[] = readFileSync(join(directory, "status.jsonl"), "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    if (!statuses.length || statuses.some(status => !isRecord(status) || status.dagRunId !== run || status.attemptId !== attempt)) throw new Error("persisted run/attempt identity mismatch");
    if (!isRecord(persisted) || persisted.name !== dag || typeof persisted.queue !== "string" || !persisted.queue) throw new Error("missing persisted DAG/queue identity");
    actual = persisted.queue;
    const status = statuses.at(-1);
    if (!isRecord(status) || status.procGroup !== actual) throw new Error("persisted procGroup does not corroborate actual queue");
    const parameters: unknown = JSON.parse(env.DAGU_PARAMS_JSON || "{}");
    if (!isRecord(parameters)) throw new Error("invalid run parameters");
    const replacements = Object.keys(parameters).filter(key => ["QUEUE", "ADOPTED_QUEUE", "LANE", "LANE_MAPPING"].includes(key));
    if (replacements.length) throw new Error(`adopted queue replacement via parameters: ${replacements.join(",")}`);
    if (actual !== expected) throw new Error("actual executing queue differs from adopted queue");
    if (env.DAGU_OUTPUT_FILE) appendFileSync(env.DAGU_OUTPUT_FILE, "QUEUE_VERIFIED=yes\n");
    console.log(`QUEUE_ACCEPTED ${diagnostic()} procGroup=${status.procGroup}`);
  } catch (error) {
    throw new Error(`QUEUE_REJECTED ${diagnostic()} cause=${error instanceof Error ? error.message : String(error)}; use the adopted queue and pinned Dagu local data/log layout, or repeat bootstrap/adoption`);
  }
}
