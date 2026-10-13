import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerWitnessResult } from "../src/worker-witness.ts";
import { REAL_WORKER_UNIT_COUNT, RealWorkerObserver, realWorkerTask } from "./support/real-worker-observer.ts";
import { parseCli, pionArgs } from "./support/work-gate-live.ts";

const nonce = "nonce-structural";
const passWitness: WorkerWitnessResult = {
  verdict: "pass",
  checks: {
    identity: { verdict: "pass", reasons: [] },
    concurrency: { verdict: "pass", reasons: [] },
    termination: { verdict: "pass", reasons: [] },
  },
  taskIds: Array.from({ length: 8 }, (_, index) => `worker-${index + 1}`),
  reasons: [],
};

function dispatch(index: number): Record<string, unknown> {
  return { type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "subagent_run", args: {
    agent: "reviewer", name: `unit-${String(index).padStart(2, "0")}`, task: realWorkerTask(index, nonce), mode: "task",
  } };
}
function update(index: number, status: string): Record<string, unknown> {
  return { type: "tool_execution_update", toolCallId: `call-${index}`, toolName: "subagent_run",
    partialResult: { details: { tasks: [{ id: `worker-${index}`, agent: "reviewer", status }] } } };
}
function end(index: number): Record<string, unknown> {
  return { type: "tool_execution_end", toolCallId: `call-${index}`, toolName: "subagent_run", isError: false,
    result: { details: { results: [{ id: `worker-${index}`, agent: "reviewer", status: "completed" }] } } };
}
function assistantResponse(indices: number[]): Record<string, unknown> {
  return { type: "message_end", message: { role: "assistant", content: indices.map((index) => ({
    type: "toolCall", id: `call-${index}`, name: "subagent_run", arguments: {},
  })) } };
}
function completed(responseGroups: number[][] = [[1, 2, 3, 4, 5, 6, 7, 8]]): RealWorkerObserver {
  let tick = 1n;
  const observer = new RealWorkerObserver("run", nonce, () => tick++);
  for (const group of responseGroups) observer.onRecord(assistantResponse(group));
  for (let index = 1; index <= 8; index++) observer.onRecord(dispatch(index));
  for (let index = 1; index <= 8; index++) observer.onRecord(update(index, "queued"));
  for (let index = 1; index <= 8; index++) observer.onRecord(update(index, "running"));
  for (let index = 8; index >= 1; index--) observer.onRecord(end(index));
  return observer;
}

test("real Worker trace requires eight tool calls in one assistant response", () => {
  const validation = completed().validate({ witness: passWitness });
  assert.equal(validation.unitCount, 8);
  assert.equal(validation.maxRunning, 8);
});

test("several assistant responses fail even when all eight Workers complete", () => {
  assert.throws(() => completed([[1, 2, 3, 4], [5, 6, 7, 8]]).validate({ witness: passWitness }), /one assistant response/);
});

test("five calls fail the exact eight-call contract", () => {
  let tick = 1n;
  const observer = new RealWorkerObserver("five", nonce, () => tick++);
  observer.onRecord(assistantResponse([1, 2, 3, 4, 5]));
  for (let index = 1; index <= 5; index++) {
    observer.onRecord(dispatch(index));
    observer.onRecord(update(index, "running"));
    observer.onRecord(end(index));
  }
  assert.throws(() => observer.validate({ expectedUnits: 8, minimumRunning: 8, witness: passWitness }), /expected 8|exactly 8/);
});

test("unknown witness blocks an otherwise valid runtime trace", () => {
  const unknown = structuredClone(passWitness);
  unknown.verdict = "unknown";
  unknown.reasons = ["identity: SQLite evidence is incomplete"];
  assert.throws(() => completed().validate({ witness: unknown }), /worker witness/);
});

test("compliance requires real mode and real mode loads only a local extension path", () => {
  assert.throws(() => parseCli(["--tier", "compliance", "--runs", "1", "--model", "provider/model"]), /requires --real-workers/);
  assert.equal(parseCli(["--tier", "compliance", "--runs", "1", "--model", "provider/model", "--real-workers"]).workerMode, "real");
  const prepared = { sessionDir: "/tmp/session", copiedSkill: "/tmp/SKILL.md", copiedProbe: "/tmp/probe.ts" };
  const args = pionArgs(prepared, "session", "provider/model", "real", "/tmp/local-package/index.ts");
  assert.equal(args.includes("npm:pi-subagents-j0k3r@1.6.1"), false);
  assert.equal(args.includes("/tmp/local-package/index.ts"), true);
});
