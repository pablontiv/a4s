import assert from "node:assert/strict";
import test from "node:test";

import type { InventorySnapshot, WorkerLink } from "../src/worker-witness.ts";
import {
  REAL_WORKER_UNIT_COUNT,
  RealWorkerObserver,
  parseWorkerInventoryJsonl,
  realWorkerTask,
} from "./support/real-worker-observer.ts";
import {
  parseCli,
  pionArgs,
  REAL_WORKER_EXTENSION,
} from "./support/work-gate-live.ts";

function dispatchRecord(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "tool_execution_start",
    toolCallId: `call-${index}`,
    toolName: "subagent_run",
    args: {
      agent: "reviewer",
      name: `unit-${String(index).padStart(2, "0")}`,
      task: realWorkerTask(index),
      mode: "task",
      ...overrides,
    },
  };
}

function updateRecord(index: number, status: string, workerId = `worker-${index}`): Record<string, unknown> {
  return {
    type: "tool_execution_update",
    toolCallId: `call-${index}`,
    toolName: "subagent_run",
    partialResult: { details: { tasks: [{ id: workerId, agent: "reviewer", status }] } },
  };
}

function completionRecord(index: number, options: { isError?: boolean; status?: string; workerId?: string } = {}): Record<string, unknown> {
  return {
    type: "tool_execution_end",
    toolCallId: `call-${index}`,
    toolName: "subagent_run",
    isError: options.isError ?? false,
    result: {
      details: {
        results: [{
          id: options.workerId ?? `worker-${index}`,
          agent: "reviewer",
          status: options.status ?? "completed",
        }],
      },
    },
  };
}

function workerLink(index: number): WorkerLink {
  return {
    correlationId: `worker-${index}`,
    worker: `worker-${index}`,
    pane: `%${10 + index}`,
    tab: `tab-${index}`,
    sessionHash: `session-${index}`,
    pid: 4100 + index,
    processStartTime: `${100 + index}.25`,
  };
}

function inventory(residualIndex?: number): InventorySnapshot[] {
  return [
    {
      observedAt: "147",
      complete: true,
      processes: Array.from({ length: REAL_WORKER_UNIT_COUNT }, (_, offset) => ({ link: workerLink(offset + 1) })),
    },
    {
      observedAt: "163",
      complete: true,
      processes: residualIndex === undefined ? [] : [{ link: workerLink(residualIndex) }],
    },
  ];
}

function completedObserver(): RealWorkerObserver {
  let tick = 100n;
  const observer = new RealWorkerObserver("run-structural-8", () => {
    const observed = tick;
    tick += 2n;
    return observed;
  });
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) observer.onRecord(dispatchRecord(index));
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) observer.onRecord(updateRecord(index, "queued"));
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) observer.onRecord(updateRecord(index, "running"));
  for (let index = REAL_WORKER_UNIT_COUNT; index >= 1; index -= 1) observer.onRecord(completionRecord(index));
  return observer;
}

test("live Worker verdict requires eight simultaneously running Workers and external inventory", () => {
  const observer = completedObserver();
  assert.equal(observer.runningWorkerCount, 0);
  assert.deepEqual(observer.onRecord({ type: "agent_settled" }), { closeInput: true });
  const validation = observer.validate({
    expectedUnits: REAL_WORKER_UNIT_COUNT,
    minimumRunning: REAL_WORKER_UNIT_COUNT,
    inventorySnapshots: inventory(),
  });
  assert.equal(validation.unitCount, 8);
  assert.equal(validation.workerCount, 8);
  assert.equal(validation.failedDispatches, 0);
  assert.equal(validation.maxRunning, 8);
  assert.equal(validation.witness.verdict, "pass");
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) {
    const states = observer.events
      .filter((event) => event.unitId === `unit-${String(index).padStart(2, "0")}`)
      .map((event) => event.state);
    assert.deepEqual(states, ["dispatch", "queued", "running", "terminal"]);
  }
});

test("pending calls do not count as running Workers and serial execution fails", () => {
  let tick = 200n;
  const observer = new RealWorkerObserver("run-serial", () => tick++);
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) observer.onRecord(dispatchRecord(index));
  assert.equal(observer.pendingDispatchCount, 8);
  assert.equal(observer.runningWorkerCount, 0);
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) {
    observer.onRecord(updateRecord(index, "running"));
    observer.onRecord(completionRecord(index));
  }
  assert.throws(
    () => observer.validate({ expectedUnits: 8, minimumRunning: 8, inventorySnapshots: [] }),
    /simultaneously running Workers|external inventory|worker witness/,
  );
});

test("observer preserves regressive time and rejects the trace", () => {
  const times = [100n, 99n];
  const observer = new RealWorkerObserver("run-time", () => times.shift()!);
  observer.onRecord(dispatchRecord(1));
  observer.onRecord(dispatchRecord(2));
  assert.equal(observer.events[1]!.observedAt, "99");
  assert.throws(() => observer.validate({ requireComplete: false, inventorySnapshots: [] }), /time regressed or repeated/);
});

test("observer rejects altered name, role, mode, or task", () => {
  const alterations = [
    { name: "unit-09" },
    { agent: "implementer" },
    { mode: "session" },
    { task: "unexpected task" },
  ];
  for (const [index, alteration] of alterations.entries()) {
    let tick = 1n;
    const observer = new RealWorkerObserver(`run-contract-${index}`, () => tick++);
    observer.onRecord(dispatchRecord(1, alteration));
    assert.throws(
      () => observer.validate({ expectedUnits: 1, requireComplete: false, inventorySnapshots: [] }),
      /exact Worker dispatch contract/,
    );
  }
});

test("live validation rejects missing inventory and a residual process", () => {
  const missing = completedObserver();
  assert.throws(
    () => missing.validate({ expectedUnits: 8, minimumRunning: 8, inventorySnapshots: [] }),
    /external inventory|worker witness/,
  );
  const residual = completedObserver();
  assert.throws(
    () => residual.validate({ expectedUnits: 8, minimumRunning: 8, inventorySnapshots: inventory(1) }),
    /remains after terminal state/,
  );
});

test("persisted Worker events sanitize and limit untrusted identifiers", () => {
  let tick = 1n;
  const observer = new RealWorkerObserver("run-persistence", () => tick++);
  const secret = `credential=${"x".repeat(200)}`;
  observer.onRecord(dispatchRecord(1));
  observer.onRecord(updateRecord(1, "running", secret));
  const persisted = observer.toJsonl();
  assert.equal(persisted.includes(secret), false);
  const rows = persisted.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["observedAt", "role", "runId", "state", "unitId", "workerId"].sort());
  assert.match(String(rows[1]!.workerId), /^sha256:[0-9a-f]{32}$/);
});

test("external inventory parser rejects unconsumed fields", () => {
  assert.throws(
    () => parseWorkerInventoryJsonl(`${JSON.stringify({ observedAt: "1", complete: true, processes: [], extra: "x" })}\n`),
    /invalid snapshot schema/,
  );
});

test("real Worker mode uses the pinned extension and requires external inventory", () => {
  const prepared = { sessionDir: "/tmp/session", copiedSkill: "/tmp/SKILL.md", copiedProbe: "/tmp/probe.ts" };
  const simulated = pionArgs(prepared, "session", "provider/model");
  const real = pionArgs(prepared, "session", "provider/model", "real");
  assert.equal(REAL_WORKER_EXTENSION, "npm:pi-subagents-j0k3r@1.6.1");
  assert.equal(simulated.includes(REAL_WORKER_EXTENSION), false);
  assert.equal(real.includes(REAL_WORKER_EXTENSION), true);
  assert.equal(parseCli(["--tier", "smoke", "--runs", "1", "--model", "provider/model"]).workerMode, "simulated");
  assert.throws(
    () => parseCli(["--tier", "smoke", "--runs", "1", "--model", "provider/model", "--real-workers"]),
    /requires --worker-inventory-dir/,
  );
  assert.equal(parseCli([
    "--tier", "smoke", "--runs", "1", "--model", "provider/model", "--real-workers",
    "--worker-inventory-dir", "/tmp/inventory",
  ]).workerMode, "real");
});
