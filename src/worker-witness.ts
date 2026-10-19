export type WitnessVerdict = "pass" | "fail" | "unknown";
export type WorkerTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface WorkerTaskEvidence {
  taskId: string;
  attempt: number;
  cwd: string;
  parentSessionId: string;
  nestedSessionPath: string | null;
  task: string;
  status: WorkerTaskStatus;
  startedAt: string | null;
  endedAt: string | null;
}

export interface WorkerStartedEvent {
  taskId: string;
  attempt: number;
  cwd: string;
  createdAt: string;
  status: string;
  activity: string;
}

export interface WorkerSqliteSnapshot {
  observedAt: string;
  complete: boolean;
  tasks: readonly WorkerTaskEvidence[];
}

export interface WorkerWitnessInput {
  nonce: string;
  cwd: string;
  parentSessionId: string;
  snapshots: readonly WorkerSqliteSnapshot[];
  startedEvents: readonly WorkerStartedEvent[];
  expectedWorkers?: number;
}

export interface WitnessCheck {
  verdict: WitnessVerdict;
  reasons: string[];
}

export interface WorkerWitnessResult {
  verdict: WitnessVerdict;
  checks: {
    identity: WitnessCheck;
    concurrency: WitnessCheck;
    termination: WitnessCheck;
  };
  taskIds: string[];
  reasons: string[];
}

const TERMINAL = new Set<WorkerTaskStatus>(["completed", "failed", "cancelled", "interrupted"]);

function check(verdict: WitnessVerdict, reasons: string[]): WitnessCheck {
  return { verdict, reasons: [...new Set(reasons)] };
}

function validIso(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function matchingTasks(input: WorkerWitnessInput, snapshot: WorkerSqliteSnapshot): WorkerTaskEvidence[] {
  const marker = `[a4s-worker-nonce:${input.nonce}]`;
  return snapshot.tasks.filter((task) =>
    task.cwd === input.cwd && task.parentSessionId === input.parentSessionId && task.task.includes(marker)
  );
}

function latestComplete(input: WorkerWitnessInput): WorkerSqliteSnapshot | undefined {
  return [...input.snapshots].reverse().find((snapshot) => snapshot.complete);
}

function overall(checks: readonly WitnessCheck[]): WitnessVerdict {
  if (checks.some((item) => item.verdict === "fail")) return "fail";
  if (checks.some((item) => item.verdict === "unknown")) return "unknown";
  return "pass";
}

export function reconcileWorkerWitness(input: WorkerWitnessInput): WorkerWitnessResult {
  const expected = input.expectedWorkers ?? 8;
  const identityFailures: string[] = [];
  const identityUnknowns: string[] = [];
  if (!input.nonce || !input.cwd || !input.parentSessionId) identityFailures.push("witness filter identity is incomplete");
  if (!Number.isSafeInteger(expected) || expected < 1) identityFailures.push("expectedWorkers is invalid");
  if (input.snapshots.length === 0 || input.snapshots.every((snapshot) => !snapshot.complete)) {
    identityUnknowns.push("SQLite evidence is absent or incomplete");
  }

  const terminalSnapshot = latestComplete(input);
  const terminalTasks = terminalSnapshot ? matchingTasks(input, terminalSnapshot) : [];
  if (terminalTasks.length > expected) identityFailures.push(`SQLite contains more than ${expected} matching tasks`);
  if (terminalTasks.length < expected) identityUnknowns.push(`SQLite contains only ${terminalTasks.length} of ${expected} matching tasks`);
  const ids = new Set(terminalTasks.map((task) => task.taskId));
  if (ids.size !== terminalTasks.length) identityFailures.push("task IDs are not unique");
  if (terminalTasks.some((task) => task.attempt !== 1)) identityFailures.push("each Worker must have exactly attempt 1");
  const nested = terminalTasks.map((task) => task.nestedSessionPath).filter((value): value is string => Boolean(value));
  if (nested.length < terminalTasks.length) identityUnknowns.push("a nested session is missing");
  if (new Set(nested).size !== nested.length) identityFailures.push("nested sessions are not unique");

  const identity = identityFailures.length > 0
    ? check("fail", identityFailures)
    : identityUnknowns.length > 0
      ? check("unknown", identityUnknowns)
      : check("pass", [`SQLite proves ${expected} unique task IDs, attempts, and nested sessions`]);

  const runningSnapshot = input.snapshots.find((snapshot) => {
    if (!snapshot.complete) return false;
    const tasks = matchingTasks(input, snapshot);
    return tasks.length === expected && tasks.every((task) => task.status === "running");
  });
  const concurrency = runningSnapshot
    ? check("pass", [`one complete SQLite view contains ${expected} running Workers`])
    : check("unknown", [`no complete SQLite view contains ${expected} running Workers`]);

  const terminationFailures: string[] = [];
  const terminationUnknowns: string[] = [];
  for (const task of terminalTasks) {
    const starts = input.startedEvents.filter((event) =>
      event.taskId === task.taskId && event.attempt === task.attempt && event.cwd === input.cwd &&
      event.status === "running" && event.activity === "started"
    );
    if (starts.length === 0) terminationUnknowns.push(`${task.taskId} has no persisted started event`);
    if (!validIso(task.startedAt) || !validIso(task.endedAt)) {
      terminationUnknowns.push(`${task.taskId} has incomplete persisted times`);
    } else if (Date.parse(task.endedAt) <= Date.parse(task.startedAt)) {
      terminationFailures.push(`${task.taskId} has an invalid terminal time`);
    }
    if (!TERMINAL.has(task.status)) terminationUnknowns.push(`${task.taskId} has no persisted terminal state`);
  }
  if (terminalTasks.length === expected && terminalTasks.every((task) => validIso(task.startedAt) && validIso(task.endedAt))) {
    const latestStart = Math.max(...terminalTasks.map((task) => Date.parse(task.startedAt!)));
    const earliestEnd = Math.min(...terminalTasks.map((task) => Date.parse(task.endedAt!)));
    if (latestStart >= earliestEnd) terminationFailures.push("persisted Worker intervals do not overlap");
  } else {
    terminationUnknowns.push("persisted Worker intervals are incomplete");
  }
  const termination = terminationFailures.length > 0
    ? check("fail", terminationFailures)
    : terminationUnknowns.length > 0
      ? check("unknown", terminationUnknowns)
      : check("pass", ["SQLite proves started events, later terminal states, and temporal overlap"]);

  const checks = { identity, concurrency, termination };
  const verdict = overall(Object.values(checks));
  return {
    verdict,
    checks,
    taskIds: [...ids].sort(),
    reasons: Object.entries(checks).flatMap(([name, item]) =>
      item.verdict === "pass" ? [] : item.reasons.map((reason) => `${name}: ${reason}`)
    ),
  };
}
