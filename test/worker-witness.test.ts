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
    { kind: "started", observedAt: 10, link: { ...alpha } },
    { kind: "started", observedAt: 12, link: { ...beta } },
    { kind: "terminated", observedAt: 30, link: { ...alpha } },
    { kind: "terminated", observedAt: 32, link: { ...beta } },
  ];
}

function validSnapshots(): InventorySnapshot[] {
  return [
    {
      observedAt: 20,
      complete: true,
      processes: [{ link: { ...alpha } }, { link: { ...beta } }],
    },
    { observedAt: 40, complete: true, processes: [] },
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

test("two correlated concurrent workers that terminate pass", () => {
  const result = reconcileWorkerWitness(validInput());

  assert.equal(result.verdict, "pass");
  assert.equal(result.checks.identity.verdict, "pass");
  assert.equal(result.checks.concurrency.verdict, "pass");
  assert.equal(result.checks.termination.verdict, "pass");
});

test("a reused PID after termination is not a residual worker", () => {
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
  snapshots[1] = {
    observedAt: 40,
    complete: true,
    processes: [{ link: reusedPid }],
  };

  const result = reconcileWorkerWitness(validInput({ inventorySnapshots: snapshots }));

  assert.equal(result.verdict, "pass");
  assert.equal(result.checks.termination.verdict, "pass");
});

test("a reused PID during the worker lifecycle fails identity validation", () => {
  const wrongProcess = {
    ...alpha,
    processStartTime: "500.00",
  };
  const snapshots: InventorySnapshot[] = [
    {
      observedAt: 20,
      complete: true,
      processes: [{ link: wrongProcess }, { link: { ...beta } }],
    },
    { observedAt: 40, complete: true, processes: [] },
  ];

  const result = reconcileWorkerWitness(validInput({ inventorySnapshots: snapshots }));

  assert.equal(result.verdict, "fail");
  assert.equal(result.checks.identity.verdict, "fail");
  assert.match(result.checks.identity.reasons.join("\n"), /processStartTime/);
});

test("missing identity evidence returns unknown", () => {
  const { sessionHash: _omitted, ...alphaWithoutSessionHash } = alpha;
  const snapshots: InventorySnapshot[] = [
    {
      observedAt: 20,
      complete: true,
      processes: [
        { link: alphaWithoutSessionHash },
        { link: { ...beta } },
      ],
    },
    { observedAt: 40, complete: true, processes: [] },
  ];

  const result = reconcileWorkerWitness(validInput({ inventorySnapshots: snapshots }));

  assert.equal(result.verdict, "unknown");
  assert.equal(result.checks.identity.verdict, "unknown");
  assert.match(result.checks.identity.reasons.join("\n"), /sessionHash/);
});

test("a residual process after a termination event fails", () => {
  const snapshots = validSnapshots();
  snapshots[1] = {
    observedAt: 40,
    complete: true,
    processes: [{ link: { ...alpha } }],
  };

  const result = reconcileWorkerWitness(validInput({ inventorySnapshots: snapshots }));

  assert.equal(result.verdict, "fail");
  assert.equal(result.checks.termination.verdict, "fail");
  assert.match(result.checks.termination.reasons.join("\n"), /remains after termination/);
});

test("missing post-termination evidence returns unknown", () => {
  const result = reconcileWorkerWitness(
    validInput({ inventorySnapshots: [validSnapshots()[0]!] }),
  );

  assert.equal(result.verdict, "unknown");
  assert.equal(result.checks.termination.verdict, "unknown");
});
