import assert from "node:assert/strict";
import test from "node:test";

import { reconcileWorkerWitness, type WorkerTaskEvidence, type WorkerWitnessInput } from "../src/worker-witness.ts";

const nonce = "nonce-a";
const cwd = "/tmp/work";
const parentSessionId = "parent-a";

function task(index: number, status: WorkerTaskEvidence["status"], overrides: Partial<WorkerTaskEvidence> = {}): WorkerTaskEvidence {
  return {
    taskId: `task-${index}`,
    attempt: 1,
    cwd,
    parentSessionId,
    nestedSessionPath: `/tmp/session-${index}.jsonl`,
    task: `[a4s-worker-nonce:${nonce}] unit ${index}`,
    status,
    startedAt: `2026-01-01T00:00:0${index}.000Z`,
    endedAt: status === "running" ? null : "2026-01-01T00:00:20.000Z",
    ...overrides,
  };
}

function validInput(overrides: Partial<WorkerWitnessInput> = {}): WorkerWitnessInput {
  const running = Array.from({ length: 8 }, (_, index) => task(index + 1, "running"));
  const terminal = Array.from({ length: 8 }, (_, index) => task(index + 1, "completed"));
  return {
    nonce, cwd, parentSessionId,
    snapshots: [
      { observedAt: "1", complete: true, tasks: running },
      { observedAt: "2", complete: true, tasks: terminal },
    ],
    startedEvents: terminal.map((item) => ({
      taskId: item.taskId, attempt: 1, cwd, createdAt: item.startedAt!, status: "running", activity: "started",
    })),
    ...overrides,
  };
}

test("SQLite evidence proves eight tasks, one running view, terminal states, and overlap", () => {
  const result = reconcileWorkerWitness(validInput());
  assert.equal(result.verdict, "pass");
  assert.equal(result.taskIds.length, 8);
});

test("missing or incomplete SQLite persistence is unknown and blocking", () => {
  const absent = reconcileWorkerWitness(validInput({ snapshots: [], startedEvents: [] }));
  assert.equal(absent.verdict, "unknown");
  const incomplete = validInput();
  incomplete.snapshots = [{ observedAt: "1", complete: false, tasks: [] }];
  assert.equal(reconcileWorkerWitness(incomplete).verdict, "unknown");
});

test("at most five running Workers cannot prove concurrency", () => {
  const input = validInput();
  input.snapshots = [
    { observedAt: "1", complete: true, tasks: Array.from({ length: 5 }, (_, index) => task(index + 1, "running")) },
    input.snapshots[1]!,
  ];
  const result = reconcileWorkerWitness(input);
  assert.equal(result.verdict, "unknown");
  assert.equal(result.checks.concurrency.verdict, "unknown");
});

test("duplicate nested sessions and incompatible attempts fail", () => {
  const input = validInput();
  const terminal = [...input.snapshots[1]!.tasks];
  terminal[1] = { ...terminal[1]!, nestedSessionPath: terminal[0]!.nestedSessionPath, attempt: 2 };
  input.snapshots = [input.snapshots[0]!, { observedAt: "2", complete: true, tasks: terminal }];
  assert.equal(reconcileWorkerWitness(input).verdict, "fail");
});

test("nonce, cwd, and parent session filters reject mixed evidence", () => {
  const input = validInput();
  const terminal = [...input.snapshots[1]!.tasks];
  terminal[0] = { ...terminal[0]!, parentSessionId: "other-parent" };
  input.snapshots = [input.snapshots[0]!, { observedAt: "2", complete: true, tasks: terminal }];
  const result = reconcileWorkerWitness(input);
  assert.equal(result.verdict, "unknown");
  assert.match(result.reasons.join("\n"), /only 7 of 8/);
});
