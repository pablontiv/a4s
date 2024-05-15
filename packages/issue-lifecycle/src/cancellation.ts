import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import { readServiceEnvironment } from "@a4s/launcher/service-environment";
import { executingRunArtifact, invokeRun, runArtifactContext } from "./run-artifact.ts";
import { isRecord } from "@a4s/launcher/type-guard";
import { releaseProtection } from "./integration-protection.ts";
import { cancellationReceipt } from "@a4s/launcher/select";
import { writeAtomicJson } from "@a4s/launcher/runtime";

export interface Cancellation {
  schemaVersion: 1; run: string; dag: string; checkpoint: string; iteration: number;
  requester: string; requestedAt: string; outcome: "cancelled" | "pending";
  nativeExpected: string; nativeObserved?: string; unexecutedEffects: string[];
  retained: Array<{ location: string; owner: string; kind: string }>;
  cleanup?: { completedAt: string; disposed: string[]; admissionReleased: boolean; receiptRetained: true };
  disposables?: Array<{ location: string; head: string; kind: "snapshot" }>;
}
const git = (primary: string, ...args: string[]) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
export function cancellationState(primary: string, run: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run)) throw new Error("Invalid cancellation run ID");
  return git(primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`);
}
export function readCancellation(state: string): Cancellation | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(state, "cancellation.json"), "utf8"));
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.run !== "string" || typeof value.dag !== "string" ||
        typeof value.checkpoint !== "string" || typeof value.iteration !== "number" || typeof value.requester !== "string" ||
        typeof value.requestedAt !== "string" || !["cancelled", "pending"].includes(String(value.outcome)) ||
        typeof value.nativeExpected !== "string" || !Array.isArray(value.unexecutedEffects) || !value.unexecutedEffects.every(item => typeof item === "string") ||
        !Array.isArray(value.retained) || !value.retained.every(item => isRecord(item) && typeof item.location === "string" && typeof item.owner === "string" && typeof item.kind === "string")) throw new Error("Invalid cancellation record");
    return { schemaVersion: 1, run: value.run, dag: value.dag, checkpoint: value.checkpoint, iteration: value.iteration,
      requester: value.requester, requestedAt: value.requestedAt, outcome: value.outcome === "cancelled" ? "cancelled" : "pending",
      nativeExpected: value.nativeExpected, ...(typeof value.nativeObserved === "string" ? { nativeObserved: value.nativeObserved } : {}),
      unexecutedEffects: value.unexecutedEffects, retained: value.retained.map(item => ({ location: String(item.location), owner: String(item.owner), kind: String(item.kind) })),
      ...(Array.isArray(value.disposables) && value.disposables.every(item => isRecord(item) && item.kind === "snapshot" && typeof item.location === "string" && typeof item.head === "string")
        ? { disposables: value.disposables.map(item => ({ location: String(item.location), head: String(item.head), kind: "snapshot" as const })) } : {}),
      ...(isRecord(value.cleanup) && typeof value.cleanup.completedAt === "string" && Array.isArray(value.cleanup.disposed) && value.cleanup.disposed.every(item => typeof item === "string") && value.cleanup.admissionReleased === true && value.cleanup.receiptRetained === true
        ? { cleanup: { completedAt: value.cleanup.completedAt, disposed: value.cleanup.disposed, admissionReleased: true, receiptRetained: true } } : {}) };
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
export function saveCancellation(state: string, record: Cancellation): void {
  writeAtomicJson(join(state, "cancellation.json"), record);
}
export function assertNotCancelled(state: string): void {
  const record = readCancellation(state);
  if (record?.outcome === "cancelled" || record?.nativeExpected === "not_found") throw new Error("Logical run is cancelled or dequeue cancellation is pending; restarting or re-admitting it is not supported");
}
type Node = { step: { name: string; id?: string }; statusLabel: string; approvalIteration?: number };
export interface CancelDetails { statusLabel: string; nodes: Node[]; queueName?: string; queuedAt?: string; startedAt?: string; }
type Step = Record<string, unknown>;
export function cancellationRoute(details: CancelDetails, snapshot: string): { route: "queued" | "waiting" | "running"; step: string; iteration: number; queue?: string } {
  const parsed: unknown = parse(snapshot);
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) throw new Error("Malformed immutable snapshot");
  if (!parsed.steps.every(isRecord)) throw new Error("Malformed immutable snapshot steps");
  const dag = { steps: parsed.steps as Step[], queue: parsed.queue };
  if (details.statusLabel === "queued") {
    if (details.startedAt && !details.startedAt.startsWith("0001-") || details.nodes.some(node => !["not_started", "none", ""].includes(node.statusLabel))) throw new Error("Queued run has previously started; refusing unsafe dequeue");
    const queue = details.queueName || (typeof dag.queue === "string" ? dag.queue : isRecord(dag.queue) && typeof dag.queue.name === "string" ? dag.queue.name : undefined);
    if (!queue) throw new Error("Queued run has no positively identified queue");
    return { route: "queued", step: "queue", iteration: 0, queue };
  }
  if (details.statusLabel === "running") return { route: "running", step: details.nodes.find(node => node.statusLabel === "running")?.step.name || "running", iteration: details.nodes.reduce((iteration, node) => Math.max(iteration, node.approvalIteration || 0), 0) };
  if (details.statusLabel !== "waiting") throw new Error(`Run is ${details.statusLabel}; no cancellation mutation is supported`);
  const waiting = details.nodes.filter(node => node.statusLabel === "waiting");
  for (const node of waiting) {
    const id = node.step.id || node.step.name, step = dag.steps.find(step => (step.id || step.name) === id);
    const gate = dag.steps.find(step => (step.id || step.name) === `${id}_cancellation`);
    const dependencies = typeof gate?.depends === "string" ? [gate.depends] : Array.isArray(gate?.depends) ? gate.depends : [];
    const form = isRecord(step?.with) && isRecord(step.with.form) ? step.with.form : undefined;
    const cancel = isRecord(form?.properties) && isRecord(form.properties.CANCEL) ? form.properties.CANCEL : undefined;
    const choices = Array.isArray(cancel?.enum) ? cancel.enum : [];
    if (step?.action === "human.task" && choices.includes("yes") && choices.includes("no") && dependencies.includes(id)) return { route: "waiting", step: id, iteration: node.approvalIteration || 0 };
  }
  throw new Error("This immutable snapshot does not declare a supported CANCEL=yes cancellation gate for its current wait; no mutation performed");
}
function ownedSnapshots(primary: string, run: string, out: string | undefined): NonNullable<Cancellation["disposables"]> {
  if (!out || out.startsWith("${") || !existsSync(join(out, "snapshot-resource.json"))) return [];
  const resource: unknown = JSON.parse(readFileSync(join(out, "snapshot-resource.json"), "utf8"));
  if (!isRecord(resource) || resource.run !== run || resource.primary !== primary || typeof resource.snapshot !== "string" || typeof resource.sha !== "string") throw new Error("Snapshot cancellation ownership mismatch");
  return [{ location: resource.snapshot, head: resource.sha, kind: "snapshot" }];
}

/** Both normal and cancellation exits use the same ownership and preservation checks. */
function disposeSnapshots(primary: string, record: Pick<Cancellation, "run" | "retained" | "disposables">): { retained: Cancellation["retained"]; disposed: string[] } {
  const retained = [...record.retained], disposed: string[] = [];
  for (const resource of record.disposables || []) {
    const location = resolve(resource.location);
    if (!record.retained.some(item => item.kind === "evidence" && location === join(resolve(item.location), "snapshot"))) throw new Error("Disposable snapshot is outside owned evidence");
    if (!existsSync(location)) { disposed.push(location); continue; }
    if (git(location, "rev-parse", "--show-toplevel") !== location ||
        git(location, "rev-parse", "--path-format=absolute", "--git-common-dir") !== git(primary, "rev-parse", "--path-format=absolute", "--git-common-dir")) throw new Error("Disposable snapshot ownership mismatch");
    if (git(location, "rev-parse", "HEAD") !== resource.head || git(location, "branch", "--show-current") || git(location, "status", "--porcelain", "--untracked-files=all")) {
      retained.push({ location, owner: record.run, kind: "recoverable snapshot" });
      continue;
    }
    const writable = (path: string): void => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return;
      chmodSync(path, stat.mode | 0o200);
      if (stat.isDirectory()) for (const entry of readdirSync(path)) writable(join(path, entry));
    };
    writable(location);
    git(primary, "worktree", "remove", location);
    if (existsSync(location) || git(primary, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${location}`)) throw new Error("Disposable snapshot removal was not verified");
    disposed.push(location);
  }
  return { retained, disposed };
}

/** Shared cancellation exit path. Never fetches, publishes, switches branches, resets, or removes candidate work. */
export function finalizeCancellation(primary: string, state: string, record: Cancellation): Cancellation {
  if (record.outcome !== "cancelled") throw new Error("Pending requests cannot run terminal cleanup");
  if (record.cleanup) return record;
  const retained = [...record.retained], resourcePath = join(state, "resource.json");
  if (existsSync(resourcePath)) {
    const resource: unknown = JSON.parse(readFileSync(resourcePath, "utf8"));
    if (!isRecord(resource) || resource.run !== record.run || resource.primary !== primary) throw new Error("Cancellation cleanup resource ownership mismatch");
    if (typeof resource.worktree === "string" && existsSync(resource.worktree) && !retained.some(item => item.location === resource.worktree)) retained.push({ location: resource.worktree, owner: record.run, kind: "candidate" });
  }
  // Cleanliness cannot establish that candidate commits have been published.
  const cleanup = disposeSnapshots(primary, { ...record, retained });
  releaseProtection(primary, { reason: "terminal", run: record.run });
  const result: Cancellation = { ...record, retained: cleanup.retained, cleanup: { completedAt: new Date().toISOString(), disposed: cleanup.disposed, admissionReleased: true, receiptRetained: true } };
  saveCancellation(state, result);
  return result;
}
async function get(base: string, path: string): Promise<{ status: number; value: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/v1/${path}`, { signal: AbortSignal.timeout(15_000) });
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("Malformed native response");
  return { status: response.status, value };
}
export function parseCancelDetails(value: unknown): CancelDetails {
  if (!isRecord(value) || typeof value.statusLabel !== "string" || !Array.isArray(value.nodes)) throw new Error("Malformed native run details");
  const nodes = value.nodes.map(node => {
    if (!isRecord(node) || !isRecord(node.step) || typeof node.step.name !== "string" || typeof node.statusLabel !== "string") throw new Error("Malformed native node");
    return { step: { name: node.step.name, ...(typeof node.step.id === "string" ? { id: node.step.id } : {}) }, statusLabel: node.statusLabel, ...(typeof node.approvalIteration === "number" ? { approvalIteration: node.approvalIteration } : {}) };
  });
  return { statusLabel: value.statusLabel, nodes, ...(typeof value.queueName === "string" ? { queueName: value.queueName } : {}), ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}) };
}
export async function main(args: string[]): Promise<void> {
  if (args[0] === "record" || args[0] === "finalize") {
    const primary = process.env.PRIMARY, run = process.env.RUN || process.env.DAG_RUN_ID;
    if (!primary || !run) throw new Error("Cancellation requires PRIMARY and RUN");
    const state = cancellationState(primary, run);
    if (args[0] === "finalize") {
      const record = readCancellation(state);
      if (record?.outcome === "cancelled") finalizeCancellation(primary, state, record);
      else {
        const out = process.env.OUT_DIR, disposables = ownedSnapshots(primary, run, out);
        if (out && disposables.length) writeAtomicJson(join(out, "snapshot-cleanup.json"), disposeSnapshots(primary, { run, retained: [{ location: out, owner: run, kind: "evidence" }], disposables }));
      }
      return;
    }
    const [, dag, checkpoint, nativeExpected = "failed"] = args;
    if (!dag || !checkpoint) throw new Error("Usage: cancellation record <dag> <checkpoint> <native-outcome>");
    const prior = readCancellation(state);
    const { DAGU_URL } = readServiceEnvironment();
    const observed = await get(DAGU_URL, `dag-runs/${encodeURIComponent(dag)}/${encodeURIComponent(run)}`);
    if (observed.status !== 200) throw new Error("Cancellation gate cannot observe its native run");
    const details = parseCancelDetails(observed.value.dagRunDetails);
    const iteration = details.nodes.find(node => node.step.name === checkpoint)?.approvalIteration || 0;
    const retained = [...(prior?.retained || []), ...[process.env.WORKTREE, process.env.OUT_DIR].filter((location): location is string => !!location && !location.startsWith("${")).map(location => ({ location, owner: run, kind: location === process.env.OUT_DIR ? "evidence" : "candidate" }))];
    const record: Cancellation = { schemaVersion: 1, run, dag, checkpoint, iteration: prior?.checkpoint === checkpoint ? prior.iteration : iteration, requester: prior?.requester || process.env.OMP_SESSION_ID || process.env.USER || "operator", requestedAt: prior?.requestedAt || new Date().toISOString(), outcome: "cancelled", nativeExpected, unexecutedEffects: prior?.unexecutedEffects || details.nodes.filter(node => node.statusLabel === "not_started").map(node => node.step.name), retained };
    record.disposables = ownedSnapshots(primary, run, process.env.OUT_DIR);
    saveCancellation(state, record);
    // Keep existing per-DAG evidence locations as copies, never as authority.
    const legacy = dag === "poc" ? git(primary, "rev-parse", "--path-format=absolute", "--git-path", `poc/runs/${run}`) : process.env.OUT_DIR;
    if (legacy && !legacy.startsWith("${") && legacy !== state) saveCancellation(legacy, record);
    return;
  }
  if (args.length !== 2 || args[0] !== "--run" || !args[1]) throw new Error("Usage: a4s cancel --run <run>");
  if (!executingRunArtifact()) { process.exitCode = (await invokeRun(cancellationReceipt(process.env.PRIMARY || process.cwd(), args[1]).primary, args[1], ["cancel", ...args])).status; return; }
  const context = runArtifactContext();
  if (context.receipt.runReceipt.run !== args[1]) throw new Error("Cancellation receipt/run mismatch");
  const prior = readCancellation(context.state);
  if (prior && (prior.run !== args[1] || prior.dag !== context.receipt.runReceipt.dag)) throw new Error("Cancellation record/receipt identity mismatch");
  if (prior?.outcome === "cancelled") { console.log(JSON.stringify(finalizeCancellation(context.primary, context.state, prior))); return; }
  const { DAGU_URL } = readServiceEnvironment(), dag = context.receipt.runReceipt.dag, run = args[1];
  const routePath = `dag-runs/${encodeURIComponent(dag)}/${encodeURIComponent(run)}`;
  const observation = await get(DAGU_URL, routePath);
  if (observation.status === 404 && observation.value.code === "not_found" && prior?.outcome === "pending" && prior.nativeExpected === "not_found") {
    await verifyNativeAbsence(DAGU_URL, dag, run);
    console.log(JSON.stringify(finalizeCancellation(context.primary, context.state, { ...prior, outcome: "cancelled", nativeObserved: "not_found" })));
    return;
  }
  if (observation.status !== 200) throw new Error(`Native observation failed: HTTP ${observation.status}; no mutation performed`);
  const details = parseCancelDetails(observation.value.dagRunDetails);
  const spec = await get(DAGU_URL, `${routePath}/spec`);
  if (spec.status !== 200 || typeof spec.value.spec !== "string") throw new Error("Native immutable snapshot is unavailable; no mutation performed");
  const selected = cancellationRoute(details, spec.value.spec);
  const record: Cancellation = { schemaVersion: 1, run, dag, checkpoint: selected.step, iteration: selected.iteration, requester: process.env.OMP_SESSION_ID || process.env.USER || "operator", requestedAt: new Date().toISOString(), outcome: selected.route === "running" ? "pending" : "cancelled", nativeExpected: selected.route === "queued" ? "not_found" : selected.route === "running" ? details.statusLabel : "gate-defined", unexecutedEffects: details.nodes.filter(node => node.statusLabel === "not_started").map(node => node.step.name), retained: [{ location: context.state, owner: run, kind: "receipt and cancellation evidence" }] };
  const resourcePath = join(context.state, "resource.json");
  const resource: unknown = existsSync(resourcePath) ? JSON.parse(readFileSync(resourcePath, "utf8")) : null;
  if (resource !== null) {
    if (!isRecord(resource) || resource.run !== run || resource.primary !== context.primary) throw new Error("Cancellation resource ownership mismatch; no mutation performed");
    if (typeof resource.worktree === "string") record.retained.push({ location: resource.worktree, owner: run, kind: "candidate" });
  }
  if (selected.route === "running") { saveCancellation(context.state, record); console.log(JSON.stringify(record)); return; }
  if (selected.route === "waiting") {
    saveCancellation(context.state, { ...record, outcome: "pending" });
    const result = spawnSync("dagu", ["human-task", "complete", dag, "--run-id", run, "--step", selected.step, "--input", "CANCEL=yes"], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw result.error || new Error("Native cancellation completion failed");
    const snapshot: unknown = parse(spec.value.spec);
    const declaresExit = isRecord(snapshot) && isRecord(snapshot.handler_on) && snapshot.handler_on.exit !== undefined;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const terminal = await get(DAGU_URL, routePath), native = terminal.value.dagRunDetails;
      // Native resume hides the waiting attempt before publishing its successor.
      // This is not queued-route absence and cannot authorize finalization.
      if (terminal.status === 404 && terminal.value.code === "not_found") { await delay(250); continue; }
      if (terminal.status !== 200 || !isRecord(native)) throw new Error(`Native cancellation observation became unavailable (HTTP ${terminal.status}); request remains durable`);
      const gate = parseCancelDetails(native).nodes.find(node => node.step.name === `${selected.step}_cancellation`);
      if (["failed", "aborted"].includes(String(native.statusLabel)) && gate && ["failed", "aborted"].includes(gate.statusLabel)) {
        const exit = isRecord(native.onExit) ? native.onExit.statusLabel : undefined;
        if (declaresExit && ["failed", "aborted"].includes(String(exit))) throw new Error("Cancellation gate terminated but native onExit failed; retained resources require cleanup");
        if (!declaresExit || exit === "succeeded") {
          const written: unknown = JSON.parse(readFileSync(join(context.state, "cancellation.json"), "utf8"));
          // Historical declared gates may write the old minimal record. Native
          // gate/terminal evidence authorizes its receipt-bound canonical upgrade.
          if (!isRecord(written) || written.run !== run || written.checkpoint !== selected.step || !["pending", "cancelled"].includes(String(written.outcome))) throw new Error("Cancellation gate record identity mismatch");
          const current = written.schemaVersion === 1 ? readCancellation(context.state)! : record;
          const completed: Cancellation = { ...current, outcome: "cancelled", nativeExpected: String(native.statusLabel), nativeObserved: String(native.statusLabel) };
          saveCancellation(context.state, completed);
          console.log(JSON.stringify(finalizeCancellation(context.primary, context.state, completed))); return;
        }
      }
      await delay(250);
    }
    throw new Error("Cancellation is durably requested; native gate/onExit completion is still pending");
  }
  // Persist captured identity and cleanup inputs before native dequeue hides them.
  writeAtomicJson(join(context.state, "cancellation-native.json"), { details, snapshot: spec.value.spec, receipt: context.receipt, cleanupInputs: { resource } });
  saveCancellation(context.state, { ...record, outcome: "pending" });
  const result = spawnSync("dagu", ["dequeue", selected.queue!, "--dag-run", `${dag}:${run}`], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || "Native dequeue failed");
  const absent = await get(DAGU_URL, routePath);
  if (absent.status !== 404 || absent.value.code !== "not_found") throw new Error("Dequeue did not produce expected native not_found; cleanup withheld");
  await verifyNativeAbsence(DAGU_URL, dag, run);
  record.nativeObserved = "not_found";
  saveCancellation(context.state, record);
  console.log(JSON.stringify(finalizeCancellation(context.primary, context.state, record)));
}

async function verifyNativeAbsence(base: string, dag: string, run: string): Promise<void> {
  for (const status of [1, 5, 7]) {
    const listing = await get(base, `dag-runs?status=${status}`);
    if (listing.status !== 200 || !Array.isArray(listing.value.dagRuns)) throw new Error("Unable to verify cancellation removal from queue/active work");
    if (listing.value.dagRuns.some(item => isRecord(item) && item.name === dag && item.dagRunId === run)) throw new Error("Cancelled run remains in queue/active work");
  }
}
