import { createHash } from "node:crypto";

import type { WorkerWitnessResult } from "../../src/worker-witness.ts";

export type RealWorkerEventState = "dispatch" | "queued" | "running" | "terminal";

export interface RealWorkerEvent {
  runId: string;
  unitId: string;
  workerId: string | null;
  role: string;
  state: RealWorkerEventState;
  observedAt: string;
  outcome?: "completed" | "failed";
}

export interface RealWorkerValidation {
  runId: string;
  unitCount: number;
  workerCount: number;
  failedDispatches: number;
  maxRunning: number;
  witness: WorkerWitnessResult;
}

interface DispatchState {
  toolCallId: string;
  unitId: string;
  role: string;
  workerId?: string;
  queued: boolean;
  running: boolean;
  terminal: boolean;
  failed: boolean;
}

interface WorkerProjection { id: string; agent?: string; status?: string }
export interface RealWorkerRecordDisposition { closeInput: boolean }
export interface RealWorkerValidationOptions {
  expectedUnits?: number;
  minimumRunning?: number;
  requireComplete?: boolean;
  witness: WorkerWitnessResult;
}

export const REAL_WORKER_ROLE = "reviewer";
export const REAL_WORKER_MODE = "task";
export const REAL_WORKER_UNIT_COUNT = 8;

export function realWorkerTask(index: number, nonce = "test-nonce"): string {
  return `[a4s-worker-nonce:${nonce}] Review Worker unit ${String(index).padStart(2, "0")}. Inspect the current state and gate condition. Return a brief result.`;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const FAILURE = new Set(["failed", "cancelled", "interrupted"]);

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function persistent(value: string): string {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
function projections(value: unknown): WorkerProjection[] {
  const root = objectRecord(value);
  if (!root) return [];
  const details = objectRecord(root.details) ?? root;
  const candidates = [
    ...(Array.isArray(details.tasks) ? details.tasks : []),
    ...(Array.isArray(details.results) ? details.results : []),
    ...(details.task === undefined ? [] : [details.task]),
  ];
  return candidates.flatMap((candidate) => {
    const row = objectRecord(candidate);
    const id = text(row?.id ?? row?.task_id);
    if (!id) return [];
    const agent = text(row?.agent);
    const status = text(row?.status);
    return [{ id, ...(agent ? { agent } : {}), ...(status ? { status } : {}) }];
  });
}
function messageToolCalls(record: Record<string, unknown>): { id: string; name: string }[] | undefined {
  if (record.type !== "message_end") return undefined;
  const message = objectRecord(record.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  return message.content.flatMap((item) => {
    const block = objectRecord(item);
    const id = text(block?.id ?? block?.toolCallId);
    const name = text(block?.name ?? block?.toolName);
    if (block?.type !== "toolCall") return [];
    return [{ id: id ?? "", name: name ?? "" }];
  });
}

export class RealWorkerObserver {
  readonly events: RealWorkerEvent[] = [];
  readonly runId: string;
  readonly nonce: string;
  #clock: () => bigint;
  #last: bigint | undefined;
  #byCall = new Map<string, DispatchState>();
  #byUnit = new Map<string, DispatchState>();
  #byWorker = new Map<string, DispatchState>();
  #running = new Set<string>();
  #violations: string[] = [];
  #assistantResponses: string[][] = [];
  #maxRunning = 0;

  constructor(runId: string, nonce = "test-nonce", clock: () => bigint = process.hrtime.bigint) {
    if (!runId.trim() || !nonce.trim()) throw new Error("real Worker runId and nonce are required");
    this.runId = runId;
    this.nonce = nonce;
    this.#clock = clock;
  }
  get runningWorkerCount(): number { return this.#running.size; }
  get pendingDispatchCount(): number { return [...this.#byCall.values()].filter((item) => !item.terminal).length; }

  onRecord(record: Record<string, unknown>): RealWorkerRecordDisposition {
    const calls = messageToolCalls(record);
    if (calls && calls.length > 0) {
      const workerCalls = calls.filter((call) => call.name === "subagent_run");
      if (workerCalls.length > 0) {
        if (workerCalls.length !== calls.length) this.#violations.push("Worker assistant response must contain only subagent_run tool calls");
        this.#assistantResponses.push(workerCalls.map((call) => call.id));
      }
    }
    if (record.type === "tool_execution_start" && record.toolName === "subagent_run") this.#dispatch(record);
    else if (record.type === "tool_execution_update" && record.toolName === "subagent_run") this.#project(record, record.partialResult);
    else if (record.type === "tool_execution_end" && record.toolName === "subagent_run") this.#end(record);
    const pending = this.pendingDispatchCount > 0;
    return { closeInput: record.type !== "agent_settled" || !pending };
  }

  validate(options: RealWorkerValidationOptions): RealWorkerValidation {
    const expected = options.expectedUnits ?? REAL_WORKER_UNIT_COUNT;
    const minimum = options.minimumRunning ?? REAL_WORKER_UNIT_COUNT;
    const dispatches = [...this.#byCall.values()];
    const violations = [...this.#violations];
    const failed = dispatches.filter((item) => item.failed).length;
    if (dispatches.length !== expected) violations.push(`expected ${expected} Worker units, observed ${dispatches.length}`);
    if (this.#byUnit.size !== dispatches.length) violations.push("Worker unit identifiers are not unique");
    if (this.#byWorker.size !== dispatches.length) violations.push("each Worker unit must have one unique workerId");
    if (failed > 0) violations.push(`${failed} Worker dispatches failed`);
    if ((options.requireComplete ?? true) && dispatches.some((item) => !item.terminal)) violations.push("Worker dispatches are incomplete");
    if (this.#maxRunning < minimum) violations.push(`expected ${minimum} simultaneously running Workers, observed ${this.#maxRunning}`);
    if (this.#assistantResponses.length !== 1 || this.#assistantResponses[0]!.length !== expected) {
      violations.push(`exactly ${expected} subagent_run tool calls must occur in one assistant response`);
    } else {
      const responseIds = new Set(this.#assistantResponses[0]);
      if (responseIds.size !== expected || dispatches.some((item) => !responseIds.has(item.toolCallId))) {
        violations.push("assistant response tool calls do not match Worker dispatches");
      }
    }
    for (const dispatch of dispatches) {
      const states = this.events.filter((event) => event.unitId === dispatch.unitId).map((event) => event.state);
      if (states.filter((state) => state === "running").length !== 1 ||
          ((options.requireComplete ?? true) && states.filter((state) => state === "terminal").length !== 1)) {
        violations.push(`invalid Worker state order for unit ${dispatch.unitId}`);
      }
    }
    if (options.witness.verdict !== "pass") violations.push(...options.witness.reasons.map((reason) => `worker witness: ${reason}`));
    if (violations.length) throw new Error(`Invalid real Worker trace: ${[...new Set(violations)].join("; ")}`);
    return {
      runId: persistent(this.runId), unitCount: dispatches.length, workerCount: this.#byWorker.size,
      failedDispatches: failed, maxRunning: this.#maxRunning, witness: options.witness,
    };
  }

  toJsonl(): string {
    if (this.events.length > REAL_WORKER_UNIT_COUNT * 4) throw new Error("Worker event trace exceeds the event limit");
    return this.events.map((event) => JSON.stringify({
      ...event,
      runId: persistent(event.runId),
      unitId: persistent(event.unitId),
      workerId: event.workerId === null ? null : `sha256:${createHash("sha256").update(event.workerId).digest("hex").slice(0, 32)}`,
    })).join("\n") + (this.events.length ? "\n" : "");
  }

  #dispatch(record: Record<string, unknown>): void {
    const toolCallId = text(record.toolCallId);
    const args = objectRecord(record.args);
    const unitId = text(args?.name);
    const role = text(args?.agent);
    const mode = text(args?.mode);
    const task = text(args?.task);
    if (!toolCallId || !unitId || !role || !mode || !task) { this.#violations.push("subagent_run dispatch is incomplete"); return; }
    const match = /^unit-(0[1-8])$/.exec(unitId);
    const index = match ? Number(match[1]) : 0;
    if (!index || role !== REAL_WORKER_ROLE || mode !== REAL_WORKER_MODE || task !== realWorkerTask(index, this.nonce)) {
      this.#violations.push(`unit ${persistent(unitId)} does not match the exact Worker dispatch contract`);
    }
    if (this.#byCall.has(toolCallId)) this.#violations.push(`duplicate toolCallId ${persistent(toolCallId)}`);
    if (this.#byUnit.has(unitId)) this.#violations.push(`duplicate unitId ${persistent(unitId)}`);
    const state = { toolCallId, unitId, role, queued: false, running: false, terminal: false, failed: false };
    this.#byCall.set(toolCallId, state);
    this.#byUnit.set(unitId, state);
    this.#emit(state, "dispatch");
  }
  #project(record: Record<string, unknown>, value: unknown): void {
    const dispatch = this.#byCall.get(text(record.toolCallId) ?? "");
    if (!dispatch) { this.#violations.push("Worker update has no matching dispatch"); return; }
    const rows = projections(value);
    if (rows.length === 1) this.#apply(dispatch, rows[0]!);
    else if (rows.length > 1) this.#violations.push(`Worker update for unit ${dispatch.unitId} must contain exactly one task`);
  }
  #end(record: Record<string, unknown>): void {
    const dispatch = this.#byCall.get(text(record.toolCallId) ?? "");
    if (!dispatch) { this.#violations.push("Worker terminal event has no matching dispatch"); return; }
    const rows = projections(record.result);
    if (rows.length !== 1) { dispatch.failed = true; this.#violations.push(`Worker terminal event for unit ${dispatch.unitId} must contain exactly one task`); return; }
    if (record.isError === true) dispatch.failed = true;
    this.#apply(dispatch, rows[0]!);
  }
  #apply(dispatch: DispatchState, row: WorkerProjection): void {
    if (dispatch.workerId && dispatch.workerId !== row.id) { this.#violations.push(`unit ${dispatch.unitId} changed workerId`); return; }
    if (row.agent && row.agent !== dispatch.role) { this.#violations.push(`unit ${dispatch.unitId} changed Worker role`); return; }
    const existing = this.#byWorker.get(row.id);
    if (existing && existing !== dispatch) { this.#violations.push("workerId is associated with multiple units"); return; }
    if (!dispatch.workerId) { dispatch.workerId = row.id; this.#byWorker.set(row.id, dispatch); }
    if (row.status === "queued") { dispatch.queued = true; this.#emit(dispatch, "queued"); return; }
    if (row.status === "running") {
      if (dispatch.running || dispatch.terminal) this.#violations.push(`unit ${dispatch.unitId} has an invalid running transition`);
      else { dispatch.running = true; this.#running.add(row.id); this.#emit(dispatch, "running"); this.#maxRunning = Math.max(this.#maxRunning, this.#running.size); }
      return;
    }
    if (row.status && TERMINAL.has(row.status)) {
      if (!dispatch.running) this.#violations.push(`unit ${dispatch.unitId} reached terminal before running`);
      if (!dispatch.terminal) {
        dispatch.terminal = true; dispatch.failed ||= FAILURE.has(row.status); this.#running.delete(row.id);
        this.#emit(dispatch, "terminal", dispatch.failed ? "failed" : "completed");
      }
      return;
    }
    this.#violations.push(`unit ${dispatch.unitId} has unknown Worker status`);
  }
  #emit(dispatch: DispatchState, state: RealWorkerEventState, outcome?: "completed" | "failed"): void {
    const now = this.#clock();
    if (this.#last !== undefined && now <= this.#last) this.#violations.push("Worker event time regressed or repeated");
    this.#last = now;
    this.events.push({ runId: this.runId, unitId: dispatch.unitId, workerId: dispatch.workerId ?? null,
      role: dispatch.role, state, observedAt: now.toString(), ...(outcome ? { outcome } : {}) });
  }
}
