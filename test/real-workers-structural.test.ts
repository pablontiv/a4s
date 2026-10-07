import assert from "node:assert/strict";
import test from "node:test";

import { RealWorkerObserver } from "./support/real-worker-observer.ts";
import {
  parseCli,
  pionArgs,
  REAL_WORKER_EXTENSION,
  REAL_WORKER_UNIT_COUNT,
} from "./support/work-gate-live.ts";

function dispatchRecord(index: number): Record<string, unknown> {
  return {
    type: "tool_execution_start",
    toolCallId: `call-${index}`,
    toolName: "subagent_run",
    args: {
      agent: "reviewer",
      name: `unit-${String(index).padStart(2, "0")}`,
      task: `review unit ${index}`,
      mode: "task",
    },
  };
}

function updateRecord(index: number, workerId = `worker-${index}`): Record<string, unknown> {
  return {
    type: "tool_execution_update",
    toolCallId: `call-${index}`,
    toolName: "subagent_run",
    partialResult: {
      details: {
        tasks: [{ id: workerId, agent: "reviewer", status: "running" }],
      },
    },
  };
}

function completionRecord(index: number, options: { isError?: boolean; status?: string } = {}): Record<string, unknown> {
  const status = options.status ?? "completed";
  return {
    type: "tool_execution_end",
    toolCallId: `call-${index}`,
    toolName: "subagent_run",
    isError: options.isError ?? false,
    result: {
      details: {
        results: [{ id: `worker-${index}`, agent: "reviewer", status }],
      },
    },
  };
}

test("real Worker trace proves eight-unit cardinality, uniqueness, association, order, and fan-out", () => {
  let tick = 100n;
  const observer = new RealWorkerObserver("run-structural-8", () => tick++);

  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) {
    observer.onRecord(dispatchRecord(index));
  }
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) {
    observer.onRecord(updateRecord(index));
  }

  assert.deepEqual(observer.onRecord({ type: "agent_settled" }), { closeInput: false });
  assert.equal(observer.activeWorkerCount, REAL_WORKER_UNIT_COUNT);

  for (let index = REAL_WORKER_UNIT_COUNT; index >= 1; index -= 1) {
    observer.onRecord(completionRecord(index));
  }

  assert.deepEqual(observer.onRecord({ type: "agent_settled" }), { closeInput: true });
  const validation = observer.validate({
    expectedUnits: REAL_WORKER_UNIT_COUNT,
    minimumFanOut: REAL_WORKER_UNIT_COUNT,
  });
  assert.deepEqual(validation, {
    runId: "run-structural-8",
    unitCount: 8,
    workerCount: 8,
    failedDispatches: 0,
    maxFanOut: 8,
  });

  const workers = new Set(observer.events.map((event) => event.workerId));
  const units = new Set(observer.events.map((event) => event.unitId));
  assert.equal(workers.size, 8);
  assert.equal(units.size, 8);
  for (let index = 1; index <= REAL_WORKER_UNIT_COUNT; index += 1) {
    const unitId = `unit-${String(index).padStart(2, "0")}`;
    const events = observer.events.filter((event) => event.unitId === unitId);
    assert.deepEqual(events.map((event) => event.event), ["dispatch", "start", "complete"]);
    assert.deepEqual(new Set(events.map((event) => event.workerId)), new Set([`worker-${index}`]));
    assert.deepEqual(new Set(events.map((event) => event.role)), new Set(["reviewer"]));
    assert.deepEqual(new Set(events.map((event) => event.runId)), new Set(["run-structural-8"]));
  }
  assert.equal(observer.events.every((event, index, events) =>
    index === 0 || BigInt(event.monotonicNs) > BigInt(events[index - 1]!.monotonicNs)
  ), true);
});

test("real Worker trace rejects invalid association and failed dispatch events", () => {
  const duplicateWorker = new RealWorkerObserver("run-duplicate", () => 1n);
  duplicateWorker.onRecord(dispatchRecord(1));
  duplicateWorker.onRecord(dispatchRecord(2));
  duplicateWorker.onRecord(updateRecord(1, "worker-shared"));
  duplicateWorker.onRecord(updateRecord(2, "worker-shared"));
  assert.throws(
    () => duplicateWorker.validate({ expectedUnits: 2, requireComplete: false }),
    /associated with multiple units|unique workerId/,
  );

  const failedDispatch = new RealWorkerObserver("run-failed", () => 1n);
  failedDispatch.onRecord(dispatchRecord(1));
  failedDispatch.onRecord(updateRecord(1));
  failedDispatch.onRecord(completionRecord(1, { isError: true, status: "failed" }));
  assert.throws(
    () => failedDispatch.validate({ expectedUnits: 1, minimumFanOut: 1 }),
    /Worker dispatches failed/,
  );
});

test("real Worker mode is explicit and simulated mode remains the default", () => {
  const prepared = {
    sessionDir: "/tmp/session",
    copiedSkill: "/tmp/SKILL.md",
    copiedProbe: "/tmp/probe.ts",
  };
  const simulated = pionArgs(prepared, "session", "provider/model");
  const real = pionArgs(prepared, "session", "provider/model", "real");

  assert.equal(simulated.includes(REAL_WORKER_EXTENSION), false);
  assert.equal(simulated.filter((value) => value === "--extension").length, 1);
  assert.equal(real.includes(REAL_WORKER_EXTENSION), true);
  assert.equal(real.filter((value) => value === "--extension").length, 2);
  assert.equal(parseCli(["--tier", "smoke", "--runs", "1", "--model", "provider/model"]).workerMode, "simulated");
  assert.equal(parseCli([
    "--tier", "smoke", "--runs", "1", "--model", "provider/model", "--real-workers",
  ]).workerMode, "real");
});
