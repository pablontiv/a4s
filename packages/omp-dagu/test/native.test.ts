import assert from "node:assert/strict";
import { test } from "node:test";
import { TriageGuard } from "../src/triage/guard.ts";

test("native [worker, triage-reviewer] batch correlates reviewer job from spawn feedback, not primary job", () => {
  for (const route of ["wait", "message"]) {
    const guard = new TriageGuard();
    const completion = { toolName: "bash", toolCallId: "complete", input: { command: "dagu human-task complete feature --run-id native --step triage --input POC=no" } };
    const request = guard.toolCall(completion); assert.ok(request && "reason" in request);
    const revised = guard.toolCall({ toolName: "task", toolCallId: "batch", input: { tasks: [{ name: "Worker", agent: "worker", task: "Work" }, { name: "NativeReview", agent: "triage-reviewer", task: request.reason }] } });
    assert.ok(revised && "input" in revised); assert.equal(revised.input.tasks[0].outputSchema, undefined);
    // task/index.ts buildAsyncDetails exposes the first job only. The
    // task-spawn-feedback template emits every started agent/job pair.
    guard.toolResult({ toolName: "task", toolCallId: "batch", input: {}, content: [{ type: "text", text: "Spawned 2 background agents using worker, triage-reviewer.\n- `Worker` (job `worker-job`)\n- `NativeReview` (job `reviewer-job`)" }], details: {
      results: [], progress: [{ index: 0, id: "Worker", agent: "worker", status: "pending" }, { index: 1, id: "NativeReview", agent: "triage-reviewer", status: "pending" }], async: { state: "running", type: "task", jobId: "worker-job" },
    } });
    const envelope = `<task-result id="NativeReview" agent="triage-reviewer" status="completed"><output>${JSON.stringify({ poc: "no", behavior: "proven", question: "", reason: "rename" }, null, 2)}</output></task-result>`;
    if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "reviewer-job", agentUrlId: "NativeReview", status: "completed", type: "task", resultText: envelope }] } });
    else guard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "reviewer-job", agentId: "NativeReview", status: "completed", type: "task" }] } });
    assert.equal(guard.toolCall({ ...completion, input: { command: completion.input.command + " --input REVIEW=NativeReview" } }), undefined);
  }
});

test("native async batch binds every triage-reviewer job to its own run", () => {
  for (const route of ["wait", "message"]) {
    const guard = new TriageGuard();
    const completion = (run: string, id: string) => ({ toolName: "bash", toolCallId: id, input: { command: `dagu human-task complete feature --run-id ${run} --step triage --input POC=no` } });
    const requestA = guard.toolCall(completion("native-a", "request-a"));
    const requestB = guard.toolCall(completion("native-b", "request-b"));
    assert.ok(requestA && "reason" in requestA);
    assert.ok(requestB && "reason" in requestB);
    const revised = guard.toolCall({ toolName: "task", toolCallId: "batch", input: { tasks: [
      { name: "NativeReviewA", agent: "triage-reviewer", task: requestA.reason },
      { name: "NativeReviewB", agent: "triage-reviewer", task: requestB.reason },
    ] } });
    assert.ok(revised && "input" in revised);
    assert.ok(revised.input.tasks[0].outputSchema);
    assert.ok(revised.input.tasks[1].outputSchema);
    guard.toolResult({ toolName: "task", toolCallId: "batch", input: {}, content: [{ type: "text", text: "- `NativeReviewA` (job `reviewer-job-a`)\n- `NativeReviewB` (job `reviewer-job-b`)" }], details: {
      results: [],
      progress: [
        { index: 0, id: "NativeReviewA", agent: "triage-reviewer", status: "pending" },
        { index: 1, id: "NativeReviewB", agent: "triage-reviewer", status: "pending" },
      ],
    } });
    const output = JSON.stringify({ poc: "no", behavior: "proven", question: "", reason: "rename" });
    const envelope = (id: string) => `<task-result id="${id}" agent="triage-reviewer" status="completed"><output>${output}</output></task-result>`;
    if (route === "wait") {
      guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [
        { id: "reviewer-job-a", agentUrlId: "NativeReviewA", status: "completed", type: "task", resultText: envelope("NativeReviewA") },
        { id: "reviewer-job-b", agentUrlId: "NativeReviewB", status: "completed", type: "task", resultText: envelope("NativeReviewB") },
      ] } });
    } else {
      guard.messageEnd({ role: "custom", customType: "async-result", content: envelope("NativeReviewA"), details: { jobs: [{ jobId: "reviewer-job-a", agentId: "NativeReviewA", status: "completed", type: "task" }] } });
      guard.messageEnd({ role: "custom", customType: "async-result", content: envelope("NativeReviewB"), details: { jobs: [{ jobId: "reviewer-job-b", agentId: "NativeReviewB", status: "completed", type: "task" }] } });
    }
    assert.equal(guard.toolCall({ ...completion("native-a", "complete-a"), input: { command: completion("native-a", "").input.command + " --input REVIEW=NativeReviewA" } }), undefined);
    assert.equal(guard.toolCall({ ...completion("native-b", "complete-b"), input: { command: completion("native-b", "").input.command + " --input REVIEW=NativeReviewB" } }), undefined);
  }
});
