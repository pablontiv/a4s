import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Official Dagu scheduler text for a stale local-process repair. */
export const STALE_PROCESS_ERROR = "process terminated unexpectedly - stale local process detected";

/** One automatic retry for a run attempt. A repeated observation is reported, not retried. */
export const STALE_RECOVERY_BUDGET = 1;

/**
 * Preceding command for a Failed human-task checkpoint. This is the feature
 * column of the manual table in skills/issue-execution/SKILL.md.
 */
export const FEATURE_CHECKPOINT_RETRY: Readonly<Record<string, string>> = {
  // Immutable pre-role-job snapshots still have these human-task checkpoints.
  triage: "admit",
  implement: "start_gate",
  quality_review: "quality_prepare",
  start_primary_unavailable: "detect_start_primary",
  recover_start_gate: "start_gate",
  dependency_review: "checkpoint_push",
  conflict_review: "rebase",
  recover_gate: "gate",
  validation: "gate",
  recover_push: "push",
  await_ci: "auto_merge",
  await_merge: "auto_merge",
  close_primary_unavailable: "detect_close_primary",
};

const COMPLETED = new Set(["succeeded", "skipped", "partially_succeeded"]);
const STATUS_EVENTS = new Set([
  "dag.run.queued", "dag.run.running", "dag.run.waiting", "dag.run.succeeded",
  "dag.run.partially_succeeded", "dag.run.failed", "dag.run.aborted", "dag.run.rejected",
]);
// The historical scheduler race overwrote a wait/resume in less than a second.
// Do not treat a later, unrelated stale-process failure as that race.
const STALE_REPAIR_WINDOW_MS = 5_000;
const NODE_STATUS = ["not_started", "running", "failed", "aborted", "succeeded", "skipped", "partially_succeeded", "waiting", "rejected", "retrying"] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STEP = /^[A-Za-z0-9_]+$/;

const FEATURE_TEMPLATE = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");

export const FEATURE_STEP_ORDER: readonly string[] = [...FEATURE_TEMPLATE.matchAll(/^  - id: ([A-Za-z0-9_]+)$/gm)].map(match => match[1]!);

export const FEATURE_HUMAN_TASKS: ReadonlySet<string> = new Set(
  FEATURE_TEMPLATE.split(/\n(?=  - id: )/).flatMap(block => {
    const id = /^  - id: ([A-Za-z0-9_]+)/m.exec(block)?.[1];
    return id && block.includes("\n    action: human.task\n") ? [id] : [];
  }),
);

export interface DagNodeSnapshot {
  step_id?: string;
  step_name?: string;
  status?: number | string;
  error?: string;
}

/** One JSON object from `$DAGU_HOME/logs/admin/events/*.jsonl`. */
export interface AdminEvent {
  type?: string;
  occurred_at?: string;
  recorded_at?: string;
  source_service?: string;
  source_instance?: string;
  dag_name?: string;
  dag_run_id?: string;
  attempt_id?: string;
  data?: { dag_run_status?: { error?: string; nodes?: DagNodeSnapshot[] } };
}

export interface RecoveryRecord {
  run: string;
  attempt: string;
  step: string;
  command: string;
  at: string;
}

export interface RecoveryLedger {
  schemaVersion: 1;
  recoveries: RecoveryRecord[];
}

export type RecoveryDecision =
  | { action: "retry" | "budget"; run: string; attempt: string; checkpoint: string; step: string; command: string }
  | { action: "manual"; run: string; attempt: string; checkpoint: string };

export function emptyLedger(): RecoveryLedger {
  return { schemaVersion: 1, recoveries: [] };
}

export function staleRetryCommand(run: string, step: string): string {
  return `dagu retry --run-id ${run} --step ${step} --downstream feature`;
}

export function recoveryLog(decision: RecoveryDecision): string {
  if (decision.action === "manual") {
    return `stale-process recovery: run=${decision.run} attempt=${decision.attempt} checkpoint=${decision.checkpoint}; no SKILL retry step; manual recovery required`;
  }
  if (decision.action === "budget") {
    return `stale-process recovery budget: run=${decision.run} attempt=${decision.attempt} step=${decision.step} command=${decision.command}; not retried`;
  }
  return `stale-process recovery: run=${decision.run} attempt=${decision.attempt} checkpoint=${decision.checkpoint} step=${decision.step} command=${decision.command}`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Read admin JSONL without a check-then-read race. A missing directory or a vanished file is no signal. */
export function readAdminEvents(directory: string): AdminEvent[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const events: AdminEvent[] = [];
  for (const name of names.filter(entry => entry.endsWith(".jsonl")).sort()) {
    let text: string;
    try {
      text = readFileSync(join(directory, name), "utf8");
    } catch (error) {
      const code = errorCode(error);
      // ENOENT: the file disappeared. EISDIR/ENOTDIR: the name is not a readable file.
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") continue;
      throw error;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed as AdminEvent);
      } catch { /* A torn admin line is not a recovery signal. */ }
    }
  }
  return events;
}

export function decideStaleRecoveries(events: readonly AdminEvent[], ledger: RecoveryLedger): RecoveryDecision[] {
  const grouped = new Map<string, AdminEvent[]>();
  for (const event of events) {
    if (event.dag_name !== "feature" || !event.dag_run_id || !IDENTIFIER.test(event.dag_run_id)) continue;
    const list = grouped.get(event.dag_run_id) ?? [];
    list.push(event);
    grouped.set(event.dag_run_id, list);
  }
  const decisions: RecoveryDecision[] = [];
  for (const [run, runEvents] of grouped) {
    const decision = decideRun(run, runEvents, ledger);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

function decideRun(run: string, events: readonly AdminEvent[], ledger: RecoveryLedger): RecoveryDecision | undefined {
  const ordered = chronological(events);
  const attempt = latestAttempt(ordered);
  if (!attempt || !IDENTIFIER.test(attempt)) return undefined;
  const status = ordered.filter(event => event.attempt_id === attempt && STATUS_EVENTS.has(event.type ?? ""));
  const failed = status.at(-1);
  const previous = status.at(-2);
  if (!failed || failed.type !== "dag.run.failed" || runError(failed) !== STALE_PROCESS_ERROR) return undefined;
  if (!previous || (previous.type !== "dag.run.waiting" && previous.type !== "dag.run.queued")) return undefined;
  if (failed.source_service !== "scheduler" || !failed.source_instance || !previous.source_instance || failed.source_instance === previous.source_instance) return undefined;
  const elapsed = Date.parse(stamp(failed)) - Date.parse(stamp(previous));
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > STALE_REPAIR_WINDOW_MS) return undefined;
  const plan = previous.type === "dag.run.waiting" ? planWaiting(nodesOf(previous)) : planQueued(nodesOf(previous));
  if (!plan) return undefined;
  if (plan.action === "manual") return { action: "manual", run, attempt, checkpoint: plan.checkpoint };
  const used = ledger.recoveries.filter(record => record.run === run && record.attempt === attempt).length;
  const command = staleRetryCommand(run, plan.step);
  if (used >= STALE_RECOVERY_BUDGET) return { action: "budget", run, attempt, checkpoint: plan.checkpoint, step: plan.step, command };
  return { action: "retry", run, attempt, checkpoint: plan.checkpoint, step: plan.step, command };
}

function planWaiting(nodes: readonly DagNodeSnapshot[]): { action: "retry"; checkpoint: string; step: string } | { action: "manual"; checkpoint: string } | undefined {
  const waiting = nodes.flatMap(node => {
    const id = stepId(node);
    return id && nodeStatus(node.status) === "waiting" ? [id] : [];
  });
  if (!waiting.length) return undefined;
  const checkpoint = orderSteps(waiting).join(",");
  const steps = new Set<string>();
  for (const id of waiting) {
    const step = retryStep(id);
    if (!step) return { action: "manual", checkpoint };
    steps.add(step);
  }
  if (steps.size !== 1) return { action: "manual", checkpoint };
  const step = [...steps][0]!;
  if (!knownStep(step)) return { action: "manual", checkpoint };
  return { action: "retry", checkpoint, step };
}

function planQueued(nodes: readonly DagNodeSnapshot[]): { action: "retry"; checkpoint: string; step: string } | { action: "manual"; checkpoint: string } | undefined {
  const pending = firstPending(nodes);
  if (!pending) return undefined;
  if (FEATURE_HUMAN_TASKS.has(pending) || pending === "quality_review" ||
      nodes.some(node => stepId(node) === pending && nodeStatus(node.status) === "waiting")) {
    const step = retryStep(pending);
    return step && knownStep(step) ? { action: "retry", checkpoint: pending, step } : { action: "manual", checkpoint: pending };
  }
  return knownStep(pending) ? { action: "retry", checkpoint: pending, step: pending } : { action: "manual", checkpoint: pending };
}

function firstPending(nodes: readonly DagNodeSnapshot[]): string | undefined {
  // The event carries the immutable snapshot's declaration order. Never add
  // steps from the currently installed template: older snapshots may not have
  // those steps, and completed checkpoint outputs must remain preserved.
  for (const node of nodes) {
    if (!COMPLETED.has(nodeStatus(node.status))) return stepId(node) || undefined;
  }
  return undefined;
}

function retryStep(id: string): string | undefined {
  if (Object.hasOwn(FEATURE_CHECKPOINT_RETRY, id)) return FEATURE_CHECKPOINT_RETRY[id];
  return undefined;
}

function knownStep(step: string): boolean {
  return STEP.test(step) && (FEATURE_STEP_ORDER.includes(step) || Object.values(FEATURE_CHECKPOINT_RETRY).includes(step));
}

function orderSteps(ids: readonly string[]): string[] {
  const rank = new Map(FEATURE_STEP_ORDER.map((id, index) => [id, index]));
  return [...ids].sort((left, right) => (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
}

function chronological(events: readonly AdminEvent[]): AdminEvent[] {
  return events.map((event, index) => ({ event, index }))
    .sort((left, right) => stamp(left.event).localeCompare(stamp(right.event)) || left.index - right.index)
    .map(entry => entry.event);
}

function latestAttempt(events: readonly AdminEvent[]): string | undefined {
  let best: { id: string; stamp: string; index: number } | undefined;
  events.forEach((event, index) => {
    const id = event.attempt_id;
    if (!id) return;
    const value = stamp(event);
    if (!best || value > best.stamp || (value === best.stamp && index > best.index)) best = { id, stamp: value, index };
  });
  return best?.id;
}

function stamp(event: AdminEvent): string {
  const value = event.occurred_at || event.recorded_at || "";
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return "";
  // Dagu writes RFC3339Nano: fractions may be absent or have varying widths.
  // Normalize before comparing, retaining sub-millisecond event ordering.
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  return new Date(millis).toISOString().replace(/\.\d{3}Z$/, `.${fraction.padEnd(9, "0")}Z`);
}

function runError(event: AdminEvent): string {
  const error = event.data?.dag_run_status?.error;
  return typeof error === "string" ? error : "";
}

function nodesOf(event: AdminEvent): DagNodeSnapshot[] {
  const nodes = event.data?.dag_run_status?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap(node => node && typeof node === "object" ? [node] : []);
}

function stepId(node: DagNodeSnapshot): string {
  return node.step_id || node.step_name || "";
}

function nodeStatus(value: unknown): string {
  if (typeof value === "number" && NODE_STATUS[value]) return NODE_STATUS[value];
  if (typeof value === "string" && (NODE_STATUS as readonly string[]).includes(value)) return value;
  return "unknown";
}
