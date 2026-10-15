import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../src/index.ts";
import { TriageGuard } from "../src/guard.ts";
import type { CallDecision, Event } from "../src/guard.ts";
const command = (run = "run-136", extra = "") => `dagu human-task complete feature --run-id ${run} --step triage --input POC=no ${extra}`;
const call = (text = command()): Event => ({ toolName: "bash", toolCallId: "complete", input: { command: text } });
const output = (poc = "no") => JSON.stringify({ poc, behavior: "proven", question: "Does runtime support it?", reason: "rename" });
function blocked(decision: CallDecision) { assert.ok(decision && "block" in decision); return decision.reason; }
function reviewer(guard: TriageGuard, async = false, poc = "no") {
  const request = blocked(guard.toolCall(call()));
  guard.toolCall({ toolName: "task", toolCallId: "review", input: { agent: "reviewer", name: "Review136", task: request } });
  guard.toolResult({ toolName: "task", toolCallId: "review", input: {}, content: [{ type: "text", text: "Spawned agent `Review136` (job `job-1`)." }], details: async ? {
    results: [], progress: [{ index: 0, id: "Review136", agent: "reviewer" }], async: { state: "running", jobId: "job-1", type: "task" },
  } : { results: [{ index: 0, id: "Review136", agent: "reviewer", exitCode: 0, output: output(poc) }] } });
}
const approved = () => call(command("run-136", "--input REVIEW=Review136"));
const envelope = `<task-result id="Review136" agent="reviewer" status="completed"><output>${output()}</output></task-result>`;
test("sync review requires explicit correlated REVIEW and isolates runs", () => {
  const guard = new TriageGuard(); reviewer(guard);
  assert.match(blocked(guard.toolCall(call())), /--input REVIEW=Review136/);
  blocked(guard.toolCall(call(command("other", "--input REVIEW=Review136"))));
  blocked(guard.toolCall(call(command("run-136", "--input REVIEW=wrong"))));
  assert.equal(guard.toolCall(approved()), undefined);
});
test("ordinary shell quoting is guarded", () => {
  for (const spelling of ['POC="no"', "POC='no'", '"POC=no"']) blocked(new TriageGuard().toolCall(call(command().replace('POC=no', spelling))));
});
test("only explicitly bound triage reviewer is changed, ordinary reviews stay untouched", () => {
  const guard = new TriageGuard(); const request = blocked(guard.toolCall(call()));
  const foreign = { toolName: "task", toolCallId: "foreign", input: { agent: "reviewer", name: "Foreign", task: "Review implementation", outputSchema: { type: "string" } } };
  assert.equal(guard.toolCall(foreign), undefined);
  guard.toolResult({ ...foreign, details: { results: [{ id: "Foreign", agent: "reviewer", exitCode: 0, output: output() }] } });
  blocked(guard.toolCall(approved()));
  const triage = guard.toolCall({ ...foreign, toolCallId: "triage", input: { ...foreign.input, task: request } });
  assert.ok(triage && "input" in triage); assert.deepEqual(triage.input.outputSchema.required, ["poc", "behavior", "question", "reason"]);
  assert.equal(guard.toolCall(foreign), undefined);
});
test("poc yes keeps no blocked and POC=yes passes", () => {
  const guard = new TriageGuard(); reviewer(guard, false, "yes");
  assert.match(blocked(guard.toolCall(approved())), /Does runtime support it/);
  assert.equal(guard.toolCall(call(command().replace("POC=no", "POC=yes"))), undefined);
});
test("a batched call cannot hide an unreviewed POC=no behind a POC=yes completion", () => {
  const guard = new TriageGuard(); reviewer(guard);
  const yes = command("run-a").replace("POC=no", "POC=yes");
  const no = command("run-b", "--input REVIEW=Review136");
  assert.match(blocked(guard.toolCall(call(`${yes} && ${no}`))), /TRIAGE_SINGLE_COMPLETION/);
});
test("async message_end and wait require completed correlated job and agent", () => {
  for (const route of ["message", "wait"]) {
    const guard = new TriageGuard(); reviewer(guard, true); blocked(guard.toolCall(approved()));
    guard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "job-1", agentId: "foreign", status: "completed", type: "task" }] } });
    blocked(guard.toolCall(approved()));
    if (route === "message") guard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "job-1", agentId: "Review136", status: "completed", type: "task" }] } });
    else guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "job-1", agentUrlId: "Review136", status: "completed", type: "task", resultText: envelope }] } });
    assert.equal(guard.toolCall(approved()), undefined);
  }
});
test("successful completion expires approval, failed completion retains it, late results stay retired", () => {
  const guard = new TriageGuard(); reviewer(guard);
  guard.toolCall(approved()); guard.toolResult({ ...approved(), isError: true });
  assert.equal(guard.toolCall(approved()), undefined);
  guard.toolResult({ ...approved(), isError: false, details: { exitCode: 0 } });
  blocked(guard.toolCall(approved()));
  const asyncGuard = new TriageGuard(); reviewer(asyncGuard, true);
  const yes = call(command().replace("POC=no", "POC=yes")); asyncGuard.toolCall(yes); asyncGuard.toolResult(yes);
  asyncGuard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "job-1", agentId: "Review136", status: "completed", type: "task" }] } });
  blocked(asyncGuard.toolCall(approved()));
});
test("eval argv and nested shell strings are guarded and run unchanged with explicit REVIEW", () => {
  for (const code of [
    "subprocess.run(['dagu','human-task','complete','feature','--run-id','run-136','--step','triage','--input','POC=no'])",
    `subprocess.run('${command()}', shell=True)`, `!${command()}`, `await Bun.$\`${command()}\``,
  ]) {
    const guard = new TriageGuard(); const event = { toolName: "eval", toolCallId: "eval", input: { code } };
    blocked(guard.toolCall(event)); reviewer(guard);
    assert.match(blocked(guard.toolCall(event)), /--input REVIEW=Review136/);
    const explicit = code.includes("['dagu'") ? code.replace("'POC=no'", "'POC=no','--input','REVIEW=Review136'") : code.replace("POC=no", "POC=no --input REVIEW=Review136");
    assert.equal(guard.toolCall({ ...event, input: { code: explicit } }), undefined);
  }
  const guard = new TriageGuard(); reviewer(guard);
  assert.equal(guard.toolCall(call(`sh -c '${command("run-136", "--input REVIEW=Review136")}'`)), undefined);
});
test("session_start and native new/resume session_switch reset all state", () => {
  const handlers: Record<string, Function> = {};
  extension({ on(name: string, handler: Function) { handlers[name] = handler; } });
  for (const event of [{ name: "session_start", data: {} }, { name: "session_switch", data: { reason: "new" } }, { name: "session_switch", data: { reason: "resume" } }]) {
    const request = blocked(handlers.tool_call!(call()));
    handlers.tool_call!({ toolName: "task", toolCallId: "review", input: { agent: "reviewer", name: "Review136", task: request } });
    handlers.tool_result!({ toolName: "task", toolCallId: "review", input: {}, details: { results: [{ index: 0, id: "Review136", agent: "reviewer", exitCode: 0, output: output() }] } });
    assert.equal(handlers.tool_call!(approved()), undefined);
    handlers[event.name]!(event.data); blocked(handlers.tool_call!(approved()));
  }
});

test("raw completion detection guards substitutions, separators and escaped newlines", () => {
  for (const text of [
    `result=$(${command()})`,
    `${command()}; dagu status feature`,
    command().replace("human-task complete", "human-task \\\ncomplete").replace("POC=no", "POC=n\\\no"),
  ]) {
    for (const toolName of ["bash", "eval"]) {
      const guard = new TriageGuard();
      blocked(guard.toolCall({ toolName, toolCallId: "raw", input: toolName === "bash" ? { command: text } : { code: text } }));
      reviewer(guard);
      assert.equal(guard.toolCall({ toolName, toolCallId: "raw", input: toolName === "bash" ? { command: text.replace("POC=", "REVIEW=Review136 --input POC=") } : { code: text.replace("POC=", "REVIEW=Review136 --input POC=") } }), undefined);
    }
  }
});

test("allocated collision ids correlate by bound spawn index in sync, message and wait", () => {
  for (const route of ["sync", "message", "wait"]) {
    const guard = new TriageGuard();
    const request = blocked(guard.toolCall(call()));
    guard.toolCall({ toolName: "task", toolCallId: "collision", input: { name: "Review136", agent: "reviewer", task: request } });
    const id = "Review136-2";
    guard.toolResult({ toolName: "task", toolCallId: "collision", input: {}, content: [{ type: "text", text: `Spawned agent \`${id}\` (job \`allocated-job\`).` }], details: route === "sync"
      ? { results: [{ index: 0, id, agent: "reviewer", exitCode: 0, output: output() }] }
      : { results: [], progress: [{ index: 0, id, agent: "reviewer", status: "pending" }], async: { jobId: "allocated-job", type: "task", state: "running" } } });
    const resultText = `<task-result id="${id}" agent="reviewer" status="completed"><output>${output()}</output></task-result>`;
    if (route === "message") guard.messageEnd({ role: "custom", customType: "async-result", content: resultText, details: { jobs: [{ jobId: "allocated-job", agentId: id, status: "completed", type: "task" }] } });
    if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "allocated-job", agentUrlId: id, status: "completed", type: "task", resultText }] } });
    blocked(guard.toolCall(approved()));
    assert.equal(guard.toolCall(call(command("run-136", `--input REVIEW=${id}`))), undefined);
  }
});
