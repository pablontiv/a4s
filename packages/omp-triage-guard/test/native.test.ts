import assert from "node:assert/strict";
import { test } from "node:test";
import { TriageGuard } from "../src/guard.ts";

test("native [worker, reviewer] batch correlates reviewer job from spawn feedback, not primary job", () => {
  for (const route of ["wait", "message"]) {
    const guard = new TriageGuard();
    const completion = { toolName: "bash", toolCallId: "complete", input: { command: "dagu human-task complete feature --run-id native --step triage --input POC=no" } };
    const request = guard.toolCall(completion); assert.ok(request && "reason" in request);
    const revised = guard.toolCall({ toolName: "task", toolCallId: "batch", input: { tasks: [{ name: "Worker", agent: "worker", task: "Work" }, { name: "NativeReview", agent: "reviewer", task: request.reason }] } });
    assert.ok(revised && "input" in revised); assert.equal(revised.input.tasks[0].outputSchema, undefined);
    // task/index.ts buildAsyncDetails exposes the first job only. The
    // task-spawn-feedback template emits every started agent/job pair.
    guard.toolResult({ toolName: "task", toolCallId: "batch", input: {}, content: [{ type: "text", text: "Spawned 2 background agents using worker, reviewer.\n- `Worker` (job `worker-job`)\n- `NativeReview` (job `reviewer-job`)" }], details: {
      results: [], progress: [{ index: 0, id: "Worker", agent: "worker", status: "pending" }, { index: 1, id: "NativeReview", agent: "reviewer", status: "pending" }], async: { state: "running", type: "task", jobId: "worker-job" },
    } });
    const envelope = `<task-result id="NativeReview" agent="reviewer" status="completed"><output>${JSON.stringify({ poc: "no", behavior: "proven", question: "", reason: "rename" }, null, 2)}</output></task-result>`;
    if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "reviewer-job", agentUrlId: "NativeReview", status: "completed", type: "task", resultText: envelope }] } });
    else guard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "reviewer-job", agentId: "NativeReview", status: "completed", type: "task" }] } });
    assert.equal(guard.toolCall({ ...completion, input: { command: completion.input.command + " --input REVIEW=NativeReview" } }), undefined);
  }
});
