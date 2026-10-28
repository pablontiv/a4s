import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { receiptPath } from "../admission.ts";
import { receiptArtifact } from "../artifact-receipt.ts";
import { HOST_PRIMARY_REFERENCE, resolveHostPrimary, workspaceLabel } from "../primary.ts";
import { isRecord } from "../type-guard.ts";

interface Run { name: string; dagRunId: string; statusLabel: string; params?: string }
interface Captured { run: Run; spec: string; args: string[]; snapshot: string }
interface PrioritizeDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  spawnSync?: typeof spawnSync;
  receiptArtifact?: typeof receiptArtifact;
  log?: (message: string) => void;
  error?: (message: string) => void;
}
function createCommand(deps: PrioritizeDependencies) {
const env = deps.env ?? process.env;
const fetch = deps.fetch ?? globalThis.fetch;
const execute = deps.spawnSync ?? spawnSync;
const verifyReceipt = deps.receiptArtifact ?? receiptArtifact;
const log = deps.log ?? console.log;
const reportError = deps.error ?? console.error;
const base = (env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const home = resolve(env.DAGU_HOME || join(homedir(), ".dagu"));

async function get(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/api/v1/${path}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Dagu ${path} HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error(`Invalid Dagu response: ${path}`);
  return value;
}
function run(value: unknown): Run {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.dagRunId !== "string" || typeof value.statusLabel !== "string" || (value.params !== undefined && typeof value.params !== "string")) throw new Error("Invalid Dagu run");
  return { name: value.name, dagRunId: value.dagRunId, statusLabel: value.statusLabel, ...(typeof value.params === "string" ? { params: value.params } : {}) };
}
const pathFor = (entry: Run) => `dag-runs/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.dagRunId)}`;
async function details(entry: Run): Promise<Run> { return run((await get(pathFor(entry))).dagRunDetails); }
async function spec(entry: Run): Promise<string> {
  const value = (await get(`${pathFor(entry)}/spec`)).spec;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing retained spec: ${entry.name} ${entry.dagRunId}`);
  return value;
}
async function items(queue: string): Promise<Run[]> {
  const result: Run[] = [];
  const cursors = new Set<string>();
  let cursor = "";
  do {
    const page = await get(`queues/${encodeURIComponent(queue)}/items?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!Array.isArray(page.items)) throw new Error("Missing native queue order");
    result.push(...page.items.map(run));
    if (page.nextCursor !== undefined && typeof page.nextCursor !== "string") throw new Error("Invalid native queue cursor");
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : "";
    if (cursor && cursors.has(cursor)) throw new Error("Repeated native queue cursor");
    cursors.add(cursor);
  } while (cursor);
  if (new Set(result.map(key)).size !== result.length) throw new Error("Duplicate native queue entry");
  if (result.some(entry => entry.statusLabel !== "queued")) throw new Error("Queue contains a nonqueued entry; inspect native queue before prioritizing");
  return result;
}
const key = (entry: Run) => JSON.stringify([entry.name, entry.dagRunId]);
const order = (entries: Run[]) => JSON.stringify(entries.map(key));
function native(args: string[]): void {
  const result = execute("dagu", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`dagu ${args[0]}: ${result.error?.message || result.stderr.trim() || `exit=${result.status} signal=${result.signal}`}`);
}
async function originalParams(entry: Run, source: string): Promise<string[]> {
  const definition: unknown = parse(source);
  if (!isRecord(definition)) throw new Error("Invalid retained definition");
  const schema = isRecord(definition.params) && definition.params.type === "object" ? definition.params : undefined;
  const properties = schema && isRecord(schema.properties) ? schema.properties : {};
  const defaults = new Map<string, string>();
  if (schema) {
    for (const [name, value] of Object.entries(properties)) {
      if (isRecord(value) && "default" in value) {
        if (typeof value.default !== "string") throw new Error(`Cannot recover non-string retained default: ${name}; nothing dequeued`);
        defaults.set(name, value.default);
      }
    }
  } else if (Array.isArray(definition.params)) {
    for (const value of definition.params) {
      if (!isRecord(value) || Object.values(value).some(value => typeof value !== "string")) throw new Error("Cannot recover retained parameter defaults; nothing dequeued");
      for (const [name, parameter] of Object.entries(value)) defaults.set(name, parameter as string);
    }
  }
  const policy = Array.isArray(definition.env) ? definition.env.filter(value => isRecord(value) && "PRIMARY" in value) : [];
  if (policy.length > 1) throw new Error("Ambiguous retained PRIMARY; nothing dequeued");
  let primary = policy.length ? policy[0]!.PRIMARY : defaults.get("PRIMARY");
  if (primary === HOST_PRIMARY_REFERENCE) primary = resolveHostPrimary({ workspace: workspaceLabel(source) });
  if (primary !== undefined && (typeof primary !== "string" || !primary.startsWith("/") || primary.includes("$"))) throw new Error("Retained PRIMARY must be a literal absolute path; nothing dequeued");
  if (typeof primary === "string") {
    const path = receiptPath(primary, entry.dagRunId);
    if (existsSync(path)) {
      // Continue the admitted snapshot, including its original argv and sourced
      // defaults. Current deployment identity is deliberately not recalculated.
      const { receipt } = await verifyReceipt(home, path);
      if (!isRecord(receipt.runReceipt) || receipt.runReceipt.dag !== entry.name || receipt.runReceipt.run !== entry.dagRunId || !isRecord(receipt.initial) || !isRecord(receipt.initial.execution)) throw new Error(`Invalid original admission receipt: ${path}; nothing dequeued`);
      const execution = receipt.initial.execution;
      if (execution.primary !== realpathSync(primary) || execution.dagSnapshot !== source) throw new Error(`Original admission snapshot/PRIMARY mismatch: ${path}; nothing dequeued`);
      if (!Array.isArray(execution.parameters) || !execution.parameters.every(value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value))) throw new Error(`Invalid original admission parameters: ${path}; nothing dequeued`);
      const parameters = execution.parameters as string[];
      const effective = new Map(defaults);
      const supplied = new Set<string>();
      for (const parameter of parameters) {
        const separator = parameter.indexOf("=");
        const name = parameter.slice(0, separator);
        if (supplied.has(name)) throw new Error(`Duplicate original admission parameter: ${path}; nothing dequeued`);
        supplied.add(name);
        effective.set(name, parameter.slice(separator + 1));
      }
      // Native JSON-schema params include defaults in lexical key order, while
      // the receipt retains only the operator's explicit argv, in original order.
      const values = schema ? [...effective].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0) : [...effective];
      if (values.map(([name, value]) => `${name}=${value}`).join(" ") !== (entry.params ?? "")) throw new Error(`Original admission/native parameters mismatch: ${path}; nothing dequeued`);
      return ["--", ...parameters];
    }
  }
  throw new Error(`Missing artifact-bound admission receipt for ${entry.name} ${entry.dagRunId}; nothing dequeued`);
}

async function present(entry: Run): Promise<boolean> {
  const response = await fetch(`${base}/api/v1/${pathFor(entry)}`, { signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Cannot observe ${entry.name} ${entry.dagRunId}: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value) || key(run(value.dagRunDetails)) !== key(entry)) throw new Error("Unexpected recovery run identity");
  return true;
}
function lost(entry: Captured, recovery: string, state: string): void {
  reportError(`LOST ${entry.run.name} ${entry.run.dagRunId} state=${state} params=${JSON.stringify(entry.run.params ?? "")} spec=${JSON.stringify(entry.snapshot)} recovery=${JSON.stringify(join(recovery, "recovery.json"))} argv=${JSON.stringify(["dagu", ...entry.args])}`);
}

return async function main(argv: string[]): Promise<void> {
  const [dag, id, extra] = argv;
  if ((dag !== "feature" && dag !== "poc") || !id || extra) throw new Error("Usage: dagu-feature-prioritize <feature|poc> <run-id>");
  const target = await details({ name: dag, dagRunId: id, statusLabel: "" });
  if (target.statusLabel !== "queued") throw new Error(`NOT_QUEUED ${dag} ${id} status=${target.statusLabel}`);
  const source = await spec(target);
  const definition: unknown = parse(source);
  if (!isRecord(definition) || typeof definition.queue !== "string" || !definition.queue) throw new Error("Retained run requires an explicit repository queue");
  const queue = definition.queue;
  const info = await get(`queues/${encodeURIComponent(queue)}`);
  if (info.name !== queue || info.maxConcurrency !== 1) throw new Error(`Queue ${queue} requires maxConcurrency=1; observed=${info.maxConcurrency}`);
  const before = await items(queue);
  const index = before.findIndex(entry => key(entry) === key(target));
  if (index < 0) throw new Error(`NOT_QUEUED ${dag} ${id} status=not-in-repository-queue`);
  if (index === 0) { log(`PRIORITIZED ${dag} ${id} queue=${queue} moved=0`); return; }
  // Validate every receipt before creating recovery state or mutating the queue.
  const prepared: { run: Run; spec: string; params: string[] }[] = [];
  for (const entry of before) {
    const current = await details(entry);
    if (current.statusLabel !== "queued" || key(current) !== key(entry)) throw new Error("QUEUE_CHANGED while capturing; nothing dequeued");
    const retained = key(entry) === key(target) ? source : await spec(entry);
    prepared.push({ run: current, spec: retained, params: await originalParams(current, retained) });
  }
  const parent = join(home, "data", "prioritize");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const recovery = mkdtempSync(join(parent, "operation-"));
  const captured: Captured[] = prepared.map(({ run, spec, params }, position) => {
    const snapshot = join(recovery, `${position}.yaml`);
    writeFileSync(snapshot, spec, { mode: 0o600, flag: "wx", flush: true });
    const args = ["enqueue", "--dagu-home", home, "--queue", queue, "--name", run.name, "--run-id", run.dagRunId, snapshot, ...params];
    return { run, spec, snapshot, args };
  });
  writeFileSync(join(recovery, "recovery.json"), `${JSON.stringify({ queue, endpoint: base, home, target, order: before, entries: captured }, null, 2)}\n`, { mode: 0o600, flag: "wx", flush: true });
  reportError(`RECOVERY ${join(recovery, "recovery.json")}`);
  // Capture every queued snapshot before the first dequeue. Both sides of the
  // target move: leaving successors in place would rotate A,B,U,C to U,C,A,B.
  if (order(await items(queue)) !== order(before) || (await details(target)).statusLabel !== "queued") throw new Error(`QUEUE_CHANGED; nothing dequeued recovery=${recovery}`);
  const removed: Captured[] = [];
  let failure: unknown;
  for (const entry of captured.filter(entry => key(entry.run) !== key(target))) {
    try {
      native(["dequeue", queue, `--dag-run=${entry.run.name}:${entry.run.dagRunId}`]);
      removed.push(entry);
    } catch (error) {
      failure = error;
      // A command can fail after its side effect. Observe the attempted run too,
      // rather than silently omitting it from recovery.
      try { if (!await present(entry.run)) removed.push(entry); }
      catch {
        lost(entry, recovery, "unconfirmed-dequeue");
      }
      break;
    }
  }
  let requeueFailed = false;
  for (const entry of removed) {
    try {
      native(entry.args);
      log(`REQUEUED ${entry.run.name} ${entry.run.dagRunId}`);
    } catch (error) {
      requeueFailed = true;
      try {
        if (await present(entry.run)) reportError(`PRESENT ${entry.run.name} ${entry.run.dagRunId}; enqueue returned an error; inspect native state`);
        else lost(entry, recovery, "missing");
      } catch { lost(entry, recovery, "unconfirmed-enqueue"); }
      reportError(error instanceof Error ? error.message : String(error));
    }
  }
  if (failure || requeueFailed) {
    let observed: string;
    try { observed = order(await items(queue)); } catch { observed = "unavailable"; }
    throw new Error(`INCOMPLETE ${dag} ${id} queue=${queue} removed=${removed.length} observed=${observed} recovery=${recovery}; ${failure instanceof Error ? failure.message : "re-enqueue failed"}; recovered entries appended in original relative order; inspect native queue before recovery`);
  }
  const after = await items(queue);
  const expected = [target, ...before.filter(entry => key(entry) !== key(target))];
  if (order(after) !== order(expected)) throw new Error(`INCOMPLETE ${dag} ${id} queue=${queue} observed=${order(after)} expected=${order(expected)} recovery=${recovery}; scheduler or another operator changed the queue`);
  log(`PRIORITIZED ${dag} ${id} queue=${queue} moved=${removed.length}`);
};
}
export async function main(argv: string[], deps: PrioritizeDependencies = {}): Promise<void> {
  await createCommand(deps)(argv);
}
