import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileWorkerWitness,
  type InventorySnapshot,
  type RuntimeWorkerEvent,
  type WorkerLink,
  type WorkerWitnessInput,
} from "../src/worker-witness.ts";

const alpha: WorkerLink = {
  correlationId: "corr-alpha",
  worker: "worker-alpha",
  pane: "%11",
  tab: "tab-a",
  sessionHash: "session-111",
  pid: 4101,
  processStartTime: "100.25",
};

const beta: WorkerLink = {
  correlationId: "corr-beta",
  worker: "worker-beta",
  pane: "%12",
  tab: "tab-b",
  sessionHash: "session-222",
  pid: 4102,
  processStartTime: "101.50",
};

function lifecycleEvents(): RuntimeWorkerEvent[] {
  return [
    { state: "running", observedAt: "10", link: { correlationId: alpha.correlationId, worker: alpha.worker } },
    { state: "running", observedAt: "12", link: { correlationId: beta.correlationId, worker: beta.worker } },
    { state: "terminal", observedAt: "30", link: { correlationId: alpha.correlationId, worker: alpha.worker } },
    { state: "terminal", observedAt: "32", link: { correlationId: beta.correlationId, worker: beta.worker } },
  ];
}

function validSnapshots(): InventorySnapshot[] {
  return [
    {
      observedAt: "20",
      complete: true,
      processes: [{ link: { ...alpha } }, { link: { ...beta } }],
    },
    { observedAt: "40", complete: true, processes: [] },
  ];
}

function validInput(overrides: Partial<WorkerWitnessInput> = {}): WorkerWitnessInput {
  return {
    expectedWorkers: [alpha, beta],
    runtimeEvents: lifecycleEvents(),
    inventorySnapshots: validSnapshots(),
    ...overrides,
  };
}

test("external inventory proves simultaneous running identity and termination", () => {
  const result = reconcileWorkerWitness(validInput());
  assert.equal(result.verdict, "pass");
  assert.equal(result.checks.identity.verdict, "pass");
  assert.equal(result.checks.concurrency.verdict, "pass");
  assert.equal(result.checks.termination.verdict, "pass");
});

test("serial Worker execution fails concurrency", () => {
  const runtimeEvents: RuntimeWorkerEvent[] = [
    { state: "running", observedAt: "10", link: { correlationId: alpha.correlationId, worker: alpha.worker } },
    { state: "terminal", observedAt: "20", link: { correlationId: alpha.correlationId, worker: alpha.worker } },
    { state: "running", observedAt: "21", link: { correlationId: beta.correlationId, worker: beta.worker } },
    { state: "terminal", observedAt: "30", link: { correlationId: beta.correlationId, worker: beta.worker } },
  ];
  const inventorySnapshots: InventorySnapshot[] = [
    { observedAt: "15", complete: true, processes: [{ link: alpha }] },
    { observedAt: "25", complete: true, processes: [{ link: beta }] },
    { observedAt: "40", complete: true, processes: [] },
  ];
  const result = reconcileWorkerWitness(validInput({ runtimeEvents, inventorySnapshots }));
  assert.equal(result.verdict, "fail");
  assert.match(result.checks.concurrency.reasons.join("\n"), /serially/);
});

test("regressive observed time fails without replacing the observed value", () => {
  const runtimeEvents = lifecycleEvents();
  runtimeEvents[1] = { ...runtimeEvents[1]!, observedAt: "9" };
  const result = reconcileWorkerWitness(validInput({ runtimeEvents }));
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons.join("\n"), /regressed or repeated/);
  assert.equal(runtimeEvents[1]!.observedAt, "9");
});

test("missing external inventory returns unknown", () => {
  const result = reconcileWorkerWitness(validInput({ inventorySnapshots: [] }));
  assert.equal(result.verdict, "unknown");
  assert.equal(result.checks.identity.verdict, "unknown");
  assert.equal(result.checks.termination.verdict, "unknown");
});

test("a residual process after terminal state fails", () => {
  const snapshots = validSnapshots();
  snapshots[1] = {
    observedAt: "40",
    complete: true,
    processes: [{ link: { ...alpha } }],
  };
  const result = reconcileWorkerWitness(validInput({ inventorySnapshots: snapshots }));
  assert.equal(result.verdict, "fail");
  assert.equal(result.checks.termination.verdict, "fail");
  assert.match(result.checks.termination.reasons.join("\n"), /remains after terminal/);
});

test("a reused PID with a new process start time is not a residual Worker", () => {
  const reusedPid: WorkerLink = {
    ...alpha,
    correlationId: "corr-unrelated",
    worker: "unrelated-process",
    pane: "%99",
    tab: "tab-z",
    sessionHash: "session-999",
    processStartTime: "500.00",
  };
  const snapshots = validSnapshots();
  snapshots[1] = { observedAt: "40", complete: true, processes: [{ link: reusedPid }] };
  const result = reconcileWorkerWitness(validInput({ inventorySnapshots: snapshots }));
  assert.equal(result.verdict, "pass");
});
