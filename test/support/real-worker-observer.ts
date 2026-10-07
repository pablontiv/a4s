import { createHash } from "node:crypto";

import {
  reconcileWorkerWitness,
  type InventorySnapshot,
  type RuntimeWorkerEvent,
  type WorkerLink,
  type WorkerWitnessResult,
} from "../../src/worker-witness.ts";

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

interface WorkerProjection {
  id: string;
  agent?: string;
  status?: string;
}

export interface RealWorkerRecordDisposition {
  closeInput: boolean;
}

export interface RealWorkerValidationOptions {
  expectedUnits?: number;
  minimumRunning?: number;
  requireComplete?: boolean;
  inventorySnapshots?: readonly InventorySnapshot[];
}

export const REAL_WORKER_ROLE = "reviewer";
export const REAL_WORKER_MODE = "task";
export const REAL_WORKER_UNIT_COUNT = 8;

export function realWorkerTask(index: number): string {
  return `Review Worker unit ${String(index).padStart(2, "0")}. Inspect the current state and gate condition. Return a brief result.`;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const FAILURE_STATUSES = new Set(["failed", "cancelled", "interrupted"]);
const LINK_FIELDS = ["correlationId", "worker", "pane", "tab", "sessionHash", "pid", "processStartTime"] as const;
const MAX_INVENTORY_BYTES = 1_000_000;
const MAX_INVENTORY_SNAPSHOTS = 1_024;
const MAX_INVENTORY_PROCESSES = 256;
const MAX_IDENTIFIER_LENGTH = 128;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function taskProjections(value: unknown): WorkerProjection[] {
  const root = objectRecord(value);
  if (!root) return [];
  const details = objectRecord(root.details) ?? root;
  const candidates: unknown[] = [];
  if (Array.isArray(details.tasks)) candidates.push(...details.tasks);
  if (Array.isArray(details.results)) candidates.push(...details.results);
  if (details.task !== undefined) candidates.push(details.task);
  const projections: WorkerProjection[] = [];
  for (const candidate of candidates) {
    const task = objectRecord(candidate);
    const id = nonemptyString(task?.id ?? task?.task_id);
    if (!id) continue;
    const agent = nonemptyString(task?.agent);
    const status = nonemptyString(task?.status);
    projections.push({ id, ...(agent ? { agent } : {}), ...(status ? { status } : {}) });
  }
  return projections;
}

function messageProjections(record: Record<string, unknown>): WorkerProjection[] {
  const message = objectRecord(record.message);
  if (!message || message.customType !== "subagent-completion") return [];
  return taskProjections(message);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function parseWorkerLink(value: unknown, label: string): WorkerLink {
  const link = objectRecord(value);
  if (!link || !hasExactFields(link, LINK_FIELDS)) throw new Error(`${label} has an invalid Worker identity schema`);
  for (const field of LINK_FIELDS) {
    if (field === "pid") continue;
    const candidate = link[field];
    if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 256) {
      throw new Error(`${label} has an invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(link.pid) || (link.pid as number) < 1) throw new Error(`${label} has an invalid pid`);
  return link as unknown as WorkerLink;
}

export function parseWorkerInventoryJsonl(content: string): InventorySnapshot[] {
  if (Buffer.byteLength(content, "utf8") > MAX_INVENTORY_BYTES) throw new Error("Worker inventory exceeds the size limit");
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (lines.length > MAX_INVENTORY_SNAPSHOTS) throw new Error("Worker inventory has too many snapshots");
  return lines.map((line, lineIndex) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Worker inventory line ${lineIndex + 1} has invalid JSON`);
    }
    const snapshot = objectRecord(parsed);
    if (!snapshot || !hasExactFields(snapshot, ["observedAt", "complete", "processes"]) ||
      typeof snapshot.observedAt !== "string" || !/^(0|[1-9][0-9]*)$/.test(snapshot.observedAt) ||
      typeof snapshot.complete !== "boolean" || !Array.isArray(snapshot.processes) ||
      snapshot.processes.length > MAX_INVENTORY_PROCESSES) {
      throw new Error(`Worker inventory line ${lineIndex + 1} has an invalid snapshot schema`);
    }
    return {
      observedAt: snapshot.observedAt,
      complete: snapshot.complete,
      processes: snapshot.processes.map((value, processIndex) => {
        const process = objectRecord(value);
        if (!process || !hasExactFields(process, ["link"])) {
          throw new Error(`Worker inventory line ${lineIndex + 1} process ${processIndex + 1} has an invalid schema`);
        }
        return { link: parseWorkerLink(process.link, `Worker inventory line ${lineIndex + 1} process ${processIndex + 1}`) };
      }),
    };
  });
}

function persistentIdentifier(value: string): string {
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function persistentWorkerId(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function uniqueFullLinks(snapshots: readonly InventorySnapshot[], workerId: string): WorkerLink[] {
  const unique = new Map<string, WorkerLink>();
  for (const snapshot of snapshots) {
    for (const process of snapshot.processes) {
      if (process.link.correlationId !== workerId) continue;
      if (LINK_FIELDS.some((field) => process.link[field] === undefined)) continue;
      const link = process.link as WorkerLink;
      unique.set(JSON.stringify(link), link);
    }
  }
  return [...unique.values()];
}

/** Consumes runtime records. It does not start a Worker or collect external inventory. */
export class RealWorkerObserver {
  readonly events: RealWorkerEvent[] = [];
  readonly runId: string;

  #clock: () => bigint;
  #lastObservedAt: bigint | undefined;
  #dispatchByToolCall = new Map<string, DispatchState>();
  #dispatchByUnit = new Map<string, DispatchState>();
  #dispatchByWorker = new Map<string, DispatchState>();
  #runningWorkers = new Set<string>();
  #violations: string[] = [];
  #maxRunning = 0;

  constructor(runId: string, clock: () => bigint = process.hrtime.bigint) {
    if (!runId.trim()) throw new Error("real Worker runId is required");
    this.runId = runId;
    this.#clock = clock;
  }

  get runningWorkerCount(): number {
    return this.#runningWorkers.size;
  }

  get pendingDispatchCount(): number {
    return [...this.#dispatchByToolCall.values()].filter((dispatch) => !dispatch.terminal).length;
  }

  onRecord(record: Record<string, unknown>): RealWorkerRecordDisposition {
    if (record.type === "tool_execution_start" && record.toolName === "subagent_run") {
      this.#onDispatch(record);
    } else if (record.type === "tool_execution_update" && record.toolName === "subagent_run") {
      this.#onToolProjection(record, record.partialResult);
    } else if (record.type === "tool_execution_end" && record.toolName === "subagent_run") {
      this.#onToolEnd(record);
    } else {
      for (const projection of messageProjections(record)) this.#onUnscopedProjection(projection);
    }
    const hasPendingWorkers = this.pendingDispatchCount > 0;
    return { closeInput: record.type !== "agent_settled" || !hasPendingWorkers };
  }

  validate(options: RealWorkerValidationOptions = {}): RealWorkerValidation {
    const requireComplete = options.requireComplete ?? true;
    const inventorySnapshots = options.inventorySnapshots ?? [];
    const dispatches = [...this.#dispatchByToolCall.values()];
    const failedDispatches = dispatches.filter((dispatch) => dispatch.failed).length;
    const violations = [...this.#violations];

    if (options.expectedUnits !== undefined && dispatches.length !== options.expectedUnits) {
      violations.push(`expected ${options.expectedUnits} Worker units, observed ${dispatches.length}`);
    }
    if (this.#dispatchByUnit.size !== dispatches.length) violations.push("Worker unit identifiers are not unique");
    if (this.#dispatchByWorker.size !== dispatches.length) violations.push("each Worker unit must have one unique workerId");
    if (failedDispatches > 0) violations.push(`${failedDispatches} Worker dispatches failed`);
    if (requireComplete) {
      const incomplete = dispatches.filter((dispatch) => !dispatch.terminal);
      if (incomplete.length > 0) violations.push(`${incomplete.length} Worker dispatches are incomplete`);
    }
    const minimumRunning = options.minimumRunning;
    if (minimumRunning !== undefined && this.#maxRunning < minimumRunning) {
      violations.push(`expected ${minimumRunning} simultaneously running Workers, observed ${this.#maxRunning}`);
    }

    for (const dispatch of dispatches) {
      const order = this.events.filter((event) => event.unitId === dispatch.unitId).map((event) => event.state);
      const runningCount = order.filter((state) => state === "running").length;
      const terminalCount = order.filter((state) => state === "terminal").length;
      if (order[0] !== "dispatch" || runningCount !== 1 || (dispatch.terminal && terminalCount !== 1) ||
        order.indexOf("running") < order.lastIndexOf("queued") ||
        (dispatch.terminal && order.indexOf("terminal") < order.indexOf("running"))) {
        violations.push(`invalid Worker state order for unit ${dispatch.unitId}`);
      }
    }

    const expectedWorkers: WorkerLink[] = [];
    for (const dispatch of dispatches) {
      if (!dispatch.workerId) continue;
      const links = uniqueFullLinks(inventorySnapshots, dispatch.workerId);
      if (links.length !== 1) {
        violations.push(`external inventory must provide one stable identity for unit ${dispatch.unitId}`);
        continue;
      }
      if (links[0]!.worker !== dispatch.workerId) {
        violations.push(`external inventory worker identity does not match unit ${dispatch.unitId}`);
        continue;
      }
      expectedWorkers.push(links[0]!);
    }
    const runtimeEvents: RuntimeWorkerEvent[] = this.events.flatMap((event) => {
      if (event.workerId === null || event.state === "dispatch") return [];
      return [{
        state: event.state,
        observedAt: event.observedAt,
        link: { correlationId: event.workerId, worker: event.workerId },
      }];
    });
    const witness = reconcileWorkerWitness({
      expectedWorkers,
      runtimeEvents,
      inventorySnapshots,
      minimumConcurrentWorkers: minimumRunning ?? 2,
    });
    if (witness.verdict !== "pass") violations.push(...witness.reasons.map((reason) => `worker witness: ${reason}`));

    if (violations.length > 0) throw new Error(`Invalid real Worker trace: ${[...new Set(violations)].join("; ")}`);
    return {
      runId: persistentIdentifier(this.runId),
      unitCount: dispatches.length,
      workerCount: this.#dispatchByWorker.size,
      failedDispatches,
      maxRunning: this.#maxRunning,
      witness,
    };
  }

  toJsonl(): string {
    if (this.events.length > REAL_WORKER_UNIT_COUNT * 4) throw new Error("Worker event trace exceeds the event limit");
    return this.events.map((event) => JSON.stringify({
      runId: persistentIdentifier(event.runId),
      unitId: persistentIdentifier(event.unitId),
      workerId: event.workerId === null ? null : persistentWorkerId(event.workerId),
      role: event.role,
      state: event.state,
      observedAt: event.observedAt,
      ...(event.outcome ? { outcome: event.outcome } : {}),
    })).join("\n") + (this.events.length > 0 ? "\n" : "");
  }

  #onDispatch(record: Record<string, unknown>): void {
    const toolCallId = nonemptyString(record.toolCallId);
    const args = objectRecord(record.args);
    const unitId = nonemptyString(args?.name);
    const role = nonemptyString(args?.agent);
    const mode = nonemptyString(args?.mode);
    const task = nonemptyString(args?.task);
    if (!toolCallId || !unitId || !role || !mode || !task) {
      this.#violations.push("subagent_run dispatch requires toolCallId, name, agent, mode, and task");
      return;
    }
    if (this.#dispatchByToolCall.has(toolCallId)) {
      this.#violations.push(`duplicate subagent_run toolCallId ${persistentIdentifier(toolCallId)}`);
      return;
    }
    const match = /^unit-(0[1-8])$/.exec(unitId);
    const unitIndex = match ? Number(match[1]) : undefined;
    if (!unitIndex || role !== REAL_WORKER_ROLE || mode !== REAL_WORKER_MODE || task !== realWorkerTask(unitIndex)) {
      this.#violations.push(`unit ${persistentIdentifier(unitId)} does not match the exact Worker dispatch contract`);
    }
    if (this.#dispatchByUnit.has(unitId)) this.#violations.push(`duplicate Worker unitId ${persistentIdentifier(unitId)}`);
    const dispatch: DispatchState = {
      toolCallId,
      unitId,
      role,
      queued: false,
      running: false,
      terminal: false,
      failed: false,
    };
    this.#dispatchByToolCall.set(toolCallId, dispatch);
    this.#dispatchByUnit.set(unitId, dispatch);
    this.#emit(dispatch, "dispatch");
  }

  #onToolProjection(record: Record<string, unknown>, result: unknown): void {
    const toolCallId = nonemptyString(record.toolCallId);
    const dispatch = toolCallId ? this.#dispatchByToolCall.get(toolCallId) : undefined;
    if (!dispatch) {
      this.#violations.push(`Worker update has no matching dispatch: ${persistentIdentifier(toolCallId ?? "missing")}`);
      return;
    }
    const projections = taskProjections(result);
    if (projections.length === 0) return;
    if (projections.length !== 1) {
      this.#violations.push(`Worker update for unit ${dispatch.unitId} must contain exactly one task`);
      return;
    }
    this.#applyProjection(dispatch, projections[0]!);
  }

  #onToolEnd(record: Record<string, unknown>): void {
    const toolCallId = nonemptyString(record.toolCallId);
    const dispatch = toolCallId ? this.#dispatchByToolCall.get(toolCallId) : undefined;
    if (!dispatch) {
      this.#violations.push(`Worker terminal event has no matching dispatch: ${persistentIdentifier(toolCallId ?? "missing")}`);
      return;
    }
    const projections = taskProjections(record.result);
    if (projections.length !== 1) {
      dispatch.failed = true;
      this.#violations.push(`Worker terminal event for unit ${dispatch.unitId} must contain exactly one task`);
      return;
    }
    if (record.isError === true) dispatch.failed = true;
    this.#applyProjection(dispatch, projections[0]!);
    if (record.isError === true && !dispatch.terminal) this.#finish(dispatch, true);
  }

  #onUnscopedProjection(projection: WorkerProjection): void {
    const dispatch = this.#dispatchByWorker.get(projection.id);
    if (!dispatch) {
      this.#violations.push(`Worker completion has unknown workerId ${persistentIdentifier(projection.id)}`);
      return;
    }
    this.#applyProjection(dispatch, projection);
  }

  #applyProjection(dispatch: DispatchState, projection: WorkerProjection): void {
    if (projection.id.length > MAX_IDENTIFIER_LENGTH) this.#violations.push(`unit ${dispatch.unitId} has an oversized workerId`);
    if (dispatch.workerId && dispatch.workerId !== projection.id) {
      this.#violations.push(`unit ${dispatch.unitId} changed workerId`);
      return;
    }
    const existing = this.#dispatchByWorker.get(projection.id);
    if (existing && existing !== dispatch) {
      this.#violations.push(`workerId ${persistentIdentifier(projection.id)} is associated with multiple units`);
      return;
    }
    if (projection.agent && projection.agent !== dispatch.role) {
      this.#violations.push(`unit ${dispatch.unitId} changed Worker role`);
      return;
    }
    if (!dispatch.workerId) {
      dispatch.workerId = projection.id;
      this.#dispatchByWorker.set(projection.id, dispatch);
    }
    if (!projection.status) {
      this.#violations.push(`unit ${dispatch.unitId} projection has no status`);
      return;
    }
    if (projection.status === "queued") {
      if (dispatch.running || dispatch.terminal || dispatch.queued) this.#violations.push(`unit ${dispatch.unitId} has an invalid queued transition`);
      else {
        dispatch.queued = true;
        this.#emit(dispatch, "queued");
      }
      return;
    }
    if (projection.status === "running") {
      if (dispatch.running || dispatch.terminal) this.#violations.push(`unit ${dispatch.unitId} has an invalid running transition`);
      else {
        dispatch.running = true;
        this.#runningWorkers.add(projection.id);
        this.#emit(dispatch, "running");
        this.#maxRunning = Math.max(this.#maxRunning, this.#runningWorkers.size);
      }
      return;
    }
    if (TERMINAL_STATUSES.has(projection.status)) {
      this.#finish(dispatch, FAILURE_STATUSES.has(projection.status));
      return;
    }
    this.#violations.push(`unit ${dispatch.unitId} has unknown Worker status`);
  }

  #finish(dispatch: DispatchState, failed: boolean): void {
    if (!dispatch.running) this.#violations.push(`unit ${dispatch.unitId} reached terminal before running`);
    if (dispatch.terminal) {
      if (failed && !dispatch.failed) this.#violations.push(`unit ${dispatch.unitId} changed from completed to failed`);
      return;
    }
    dispatch.terminal = true;
    dispatch.failed = dispatch.failed || failed;
    if (dispatch.workerId) this.#runningWorkers.delete(dispatch.workerId);
    this.#emit(dispatch, "terminal", dispatch.failed ? "failed" : "completed");
  }

  #emit(dispatch: DispatchState, state: RealWorkerEventState, outcome?: "completed" | "failed"): void {
    const now = this.#clock();
    if (this.#lastObservedAt !== undefined && now <= this.#lastObservedAt) {
      this.#violations.push("Worker event time regressed or repeated");
    }
    this.#lastObservedAt = now;
    this.events.push({
      runId: this.runId,
      unitId: dispatch.unitId,
      workerId: dispatch.workerId ?? null,
      role: dispatch.role,
      state,
      observedAt: now.toString(),
      ...(outcome ? { outcome } : {}),
    });
  }
}
