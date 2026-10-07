export type RealWorkerEventName = "dispatch" | "start" | "complete" | "fail";

export interface RealWorkerEvent {
  runId: string;
  unitId: string;
  workerId: string;
  role: string;
  event: RealWorkerEventName;
  monotonicNs: string;
}

export interface RealWorkerValidation {
  runId: string;
  unitCount: number;
  workerCount: number;
  failedDispatches: number;
  maxFanOut: number;
}

interface DispatchState {
  toolCallId: string;
  unitId: string;
  role: string;
  workerId?: string;
  started: boolean;
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
  minimumFanOut?: number;
  requireComplete?: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const FAILURE_STATUSES = new Set(["failed", "cancelled", "interrupted"]);

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
  const unique = new Map<string, WorkerProjection>();
  for (const candidate of candidates) {
    const task = objectRecord(candidate);
    const id = nonemptyString(task?.id ?? task?.task_id);
    if (!id) continue;
    const agent = nonemptyString(task?.agent);
    const status = nonemptyString(task?.status);
    unique.set(id, {
      id,
      ...(agent ? { agent } : {}),
      ...(status ? { status } : {}),
    });
  }
  return [...unique.values()];
}

function messageProjections(record: Record<string, unknown>): WorkerProjection[] {
  const message = objectRecord(record.message);
  if (!message || message.customType !== "subagent-completion") return [];
  return taskProjections(message);
}

/**
 * Converts Pion RPC records into a strict structural trace for real Workers.
 * The observer never starts a Worker. It only consumes records from runPion.
 */
export class RealWorkerObserver {
  readonly events: RealWorkerEvent[] = [];
  readonly runId: string;

  #clock: () => bigint;
  #lastMonotonicNs = -1n;
  #dispatchByToolCall = new Map<string, DispatchState>();
  #dispatchByUnit = new Map<string, DispatchState>();
  #dispatchByWorker = new Map<string, DispatchState>();
  #activeWorkers = new Set<string>();
  #violations: string[] = [];
  #maxFanOut = 0;

  constructor(runId: string, clock: () => bigint = process.hrtime.bigint) {
    if (!runId.trim()) throw new Error("real Worker runId is required");
    this.runId = runId;
    this.#clock = clock;
  }

  get activeWorkerCount(): number {
    return this.#activeWorkers.size;
  }

  get activeDispatchCount(): number {
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

    const hasActiveWorkers = this.activeDispatchCount > 0 || this.activeWorkerCount > 0;
    return { closeInput: record.type !== "agent_settled" || !hasActiveWorkers };
  }

  validate(options: RealWorkerValidationOptions = {}): RealWorkerValidation {
    const requireComplete = options.requireComplete ?? true;
    const dispatches = [...this.#dispatchByToolCall.values()];
    const failedDispatches = dispatches.filter((dispatch) => dispatch.failed).length;
    const violations = [...this.#violations];

    if (options.expectedUnits !== undefined && dispatches.length !== options.expectedUnits) {
      violations.push(`expected ${options.expectedUnits} Worker units, observed ${dispatches.length}`);
    }
    if (this.#dispatchByUnit.size !== dispatches.length) {
      violations.push("Worker unit identifiers are not unique");
    }
    if (this.#dispatchByWorker.size !== dispatches.length) {
      violations.push("each Worker unit must have one unique workerId");
    }
    if (failedDispatches > 0) violations.push(`${failedDispatches} Worker dispatches failed`);
    if (requireComplete) {
      const incomplete = dispatches.filter((dispatch) => !dispatch.terminal);
      if (incomplete.length > 0) violations.push(`${incomplete.length} Worker dispatches are incomplete`);
    }
    if (options.minimumFanOut !== undefined && this.#maxFanOut < options.minimumFanOut) {
      violations.push(`expected Worker fan-out ${options.minimumFanOut}, observed ${this.#maxFanOut}`);
    }
    for (let index = 1; index < this.events.length; index += 1) {
      if (BigInt(this.events[index]!.monotonicNs) <= BigInt(this.events[index - 1]!.monotonicNs)) {
        violations.push("Worker event time is not strictly monotonic");
        break;
      }
    }
    for (const dispatch of dispatches) {
      if (!dispatch.workerId) continue;
      const order = this.events
        .filter((event) => event.unitId === dispatch.unitId && event.workerId === dispatch.workerId)
        .map((event) => event.event);
      const terminalEvent = dispatch.failed ? "fail" : "complete";
      if (order[0] !== "dispatch" || order[1] !== "start" || (dispatch.terminal && order[2] !== terminalEvent)) {
        violations.push(`invalid Worker event order for unit ${dispatch.unitId}`);
      }
    }

    if (violations.length > 0) throw new Error(`Invalid real Worker trace: ${[...new Set(violations)].join("; ")}`);
    return {
      runId: this.runId,
      unitCount: dispatches.length,
      workerCount: this.#dispatchByWorker.size,
      failedDispatches,
      maxFanOut: this.#maxFanOut,
    };
  }

  toJsonl(): string {
    return this.events.map((event) => JSON.stringify(event)).join("\n") + (this.events.length > 0 ? "\n" : "");
  }

  #onDispatch(record: Record<string, unknown>): void {
    const toolCallId = nonemptyString(record.toolCallId);
    const args = objectRecord(record.args);
    const unitId = nonemptyString(args?.name ?? args?.display_name);
    const role = nonemptyString(args?.agent);
    if (!toolCallId || !unitId || !role) {
      this.#violations.push("subagent_run dispatch requires toolCallId, name, and agent");
      return;
    }
    if (this.#dispatchByToolCall.has(toolCallId)) {
      this.#violations.push(`duplicate subagent_run toolCallId ${toolCallId}`);
      return;
    }
    if (this.#dispatchByUnit.has(unitId)) {
      this.#violations.push(`duplicate Worker unitId ${unitId}`);
      return;
    }
    const dispatch: DispatchState = {
      toolCallId,
      unitId,
      role,
      started: false,
      terminal: false,
      failed: false,
    };
    this.#dispatchByToolCall.set(toolCallId, dispatch);
    this.#dispatchByUnit.set(unitId, dispatch);
    this.#updateFanOut();
  }

  #onToolProjection(record: Record<string, unknown>, result: unknown): void {
    const toolCallId = nonemptyString(record.toolCallId);
    const dispatch = toolCallId ? this.#dispatchByToolCall.get(toolCallId) : undefined;
    if (!dispatch) {
      this.#violations.push(`Worker update has no matching dispatch: ${toolCallId ?? "missing toolCallId"}`);
      return;
    }
    const projections = taskProjections(result);
    if (projections.length === 0) return;
    if (projections.length !== 1) {
      this.#violations.push(`Worker update for unit ${dispatch.unitId} must contain at most one task`);
      return;
    }
    this.#applyProjection(dispatch, projections[0]!);
  }

  #onToolEnd(record: Record<string, unknown>): void {
    const toolCallId = nonemptyString(record.toolCallId);
    const dispatch = toolCallId ? this.#dispatchByToolCall.get(toolCallId) : undefined;
    if (!dispatch) {
      this.#violations.push(`Worker terminal event has no matching dispatch: ${toolCallId ?? "missing toolCallId"}`);
      return;
    }
    if (record.isError === true) dispatch.failed = true;
    const projections = taskProjections(record.result);
    if (projections.length !== 1) {
      dispatch.failed = true;
      this.#violations.push(`Worker terminal event for unit ${dispatch.unitId} must contain exactly one task`);
      return;
    }
    this.#applyProjection(dispatch, projections[0]!);
    if (record.isError === true && !dispatch.terminal) this.#finish(dispatch, true);
  }

  #onUnscopedProjection(projection: WorkerProjection): void {
    const dispatch = this.#dispatchByWorker.get(projection.id);
    if (!dispatch) {
      this.#violations.push(`Worker completion has unknown workerId ${projection.id}`);
      return;
    }
    this.#applyProjection(dispatch, projection);
  }

  #applyProjection(dispatch: DispatchState, projection: WorkerProjection): void {
    if (dispatch.workerId && dispatch.workerId !== projection.id) {
      this.#violations.push(`unit ${dispatch.unitId} changed workerId`);
      return;
    }
    const existing = this.#dispatchByWorker.get(projection.id);
    if (existing && existing !== dispatch) {
      this.#violations.push(`workerId ${projection.id} is associated with multiple units`);
      return;
    }
    if (projection.agent && projection.agent !== dispatch.role) {
      this.#violations.push(`unit ${dispatch.unitId} changed Worker role`);
      return;
    }
    if (!dispatch.workerId) {
      dispatch.workerId = projection.id;
      this.#dispatchByWorker.set(projection.id, dispatch);
      this.#emit(dispatch, "dispatch");
    }
    if (!dispatch.started) {
      dispatch.started = true;
      this.#activeWorkers.add(projection.id);
      this.#emit(dispatch, "start");
      this.#updateFanOut();
    }
    if (projection.status && TERMINAL_STATUSES.has(projection.status)) {
      this.#finish(dispatch, FAILURE_STATUSES.has(projection.status));
    }
  }

  #finish(dispatch: DispatchState, failed: boolean): void {
    if (dispatch.terminal) {
      if (failed && !dispatch.failed) {
        dispatch.failed = true;
        this.#violations.push(`unit ${dispatch.unitId} changed from complete to failed`);
      }
      return;
    }
    dispatch.terminal = true;
    dispatch.failed = dispatch.failed || failed;
    if (dispatch.workerId) this.#activeWorkers.delete(dispatch.workerId);
    this.#emit(dispatch, dispatch.failed ? "fail" : "complete");
  }

  #emit(dispatch: DispatchState, event: RealWorkerEventName): void {
    if (!dispatch.workerId) {
      this.#violations.push(`unit ${dispatch.unitId} emitted ${event} without workerId`);
      return;
    }
    let now = this.#clock();
    if (now <= this.#lastMonotonicNs) now = this.#lastMonotonicNs + 1n;
    this.#lastMonotonicNs = now;
    this.events.push({
      runId: this.runId,
      unitId: dispatch.unitId,
      workerId: dispatch.workerId,
      role: dispatch.role,
      event,
      monotonicNs: now.toString(),
    });
  }

  #updateFanOut(): void {
    const active = [...this.#dispatchByToolCall.values()].filter((dispatch) => !dispatch.terminal).length;
    this.#maxFanOut = Math.max(this.#maxFanOut, active);
  }
}
