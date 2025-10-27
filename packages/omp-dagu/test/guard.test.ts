import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import extension from "../src/triage/index.ts";
import { TriageGuard } from "../src/triage/guard.ts";
import { REVIEW_SCHEMA } from "../src/triage/schema.ts";
import type { CallDecision, Event } from "../src/triage/guard.ts";
const command = (run = "run-136", extra = "") => `dagu human-task complete feature --run-id ${run} --step triage --input POC=no ${extra}`;
const call = (text = command()): Event => ({ toolName: "bash", toolCallId: "complete", input: { command: text } });
const output = (poc = "no") => JSON.stringify({ poc, behavior: "proven", question: "Does runtime support it?", reason: "rename" });
function blocked(decision: CallDecision) { assert.ok(decision && "block" in decision); return decision.reason; }
function reviewer(guard: TriageGuard, async = false, poc = "no") {
  const request = blocked(guard.toolCall(call()));
  guard.toolCall({ toolName: "task", toolCallId: "review", input: { agent: "task", name: "Review136", task: request } });
  guard.toolResult({ toolName: "task", toolCallId: "review", input: {}, content: [{ type: "text", text: "Spawned agent `Review136` (job `job-1`)." }], details: async ? {
    results: [], progress: [{ index: 0, id: "Review136", agent: "task" }], async: { state: "running", jobId: "job-1", type: "task" },
  } : { results: [{ index: 0, id: "Review136", agent: "task", exitCode: 0, output: output(poc) }] } });
}
const approved = () => call(command("run-136", "--input REVIEW=Review136"));
const envelope = `<task-result id="Review136" agent="task" status="completed"><output>${output()}</output></task-result>`;
test("distributed triage-reviewer frontmatter schema equals the canonical triage schema", () => {
  const definition = readFileSync(new URL("../agents/triage-reviewer.md", import.meta.url), "utf8");
  const schema = JSON.parse(/^output: (.+)$/m.exec(definition)![1]!);
  assert.deepEqual(schema, REVIEW_SCHEMA);
});
test("generic task binding injects the schema using only the exact marker in its assignment", () => {
  const guard = new TriageGuard();
  const request = blocked(guard.toolCall(call()));
  const marker = /TRIAGE_REVIEW DAG=feature RUN=run-136 GENERATION=0 REQUEST=1/.exec(request)![0];
  const bound = guard.toolCall({ toolName: "task", toolCallId: "schema", input: { agent: "worker", task: `Review scope ${marker} using existing evidence.`, outputSchema: { type: "string" } } });
  assert.ok(bound && "input" in bound);
  assert.deepEqual(bound.input.outputSchema, REVIEW_SCHEMA);
  guard.toolResult({ toolName: "task", toolCallId: "schema", input: {}, details: { results: [{ index: 0, id: "Generic349", agent: "worker", exitCode: 0, output: output() }] } });
  assert.equal(guard.toolCall(call(command("run-136", "--input REVIEW=Generic349"))), undefined);
});
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
test("only explicitly bound tasks receive the schema, ordinary reviews stay untouched", () => {
  const guard = new TriageGuard(); blocked(guard.toolCall(call()));
  const foreign = { toolName: "task", toolCallId: "foreign", input: { agent: "reviewer", name: "Foreign", task: "Review implementation", outputSchema: { type: "string" } } };
  assert.equal(guard.toolCall(foreign), undefined);
  guard.toolResult({ ...foreign, details: { results: [{ id: "Foreign", agent: "reviewer", exitCode: 0, output: output() }] } });
  const retry = blocked(guard.toolCall(approved()));
  const triage = guard.toolCall({ ...foreign, toolCallId: "triage", input: { ...foreign.input, task: retry } });
  assert.ok(triage && "input" in triage); assert.deepEqual(triage.input.outputSchema.required, ["poc", "behavior", "question", "reason"]);
  assert.equal(guard.toolCall(foreign), undefined);
});
test("poc yes keeps no blocked and POC=yes passes", () => {
  const guard = new TriageGuard(); reviewer(guard, false, "yes");
  assert.match(blocked(guard.toolCall(approved())), /Does runtime support it/);
  assert.equal(guard.toolCall(call(command().replace("POC=no", "POC=yes"))), undefined);
});
test("a fresh request binds a replacement review within the same generation", () => {
  for (const route of ["task", "message", "wait"]) {
    const guard = new TriageGuard();
    reviewer(guard, false, "yes");
    const request = blocked(guard.toolCall(approved()));
    assert.match(request, /GENERATION=0 REQUEST=2/);
    const launch = { toolName: "task", toolCallId: "replacement", input: { agent: "triage-reviewer", name: "Review136v2", task: request } };
    const bound = guard.toolCall(launch);
    assert.ok(bound && "input" in bound);
    guard.toolResult({ ...launch, content: [{ type: "text", text: "Spawned agent `Review136v2` (job `job-2`)." }], details: route === "task"
      ? { results: [{ index: 0, id: "Review136v2", agent: "triage-reviewer", exitCode: 0, output: output() }] }
      : { results: [], progress: [{ index: 0, id: "Review136v2", agent: "triage-reviewer" }] } });
    const resultText = `<task-result id="Review136v2" agent="triage-reviewer" status="completed"><output>${output()}</output></task-result>`;
    if (route === "message") guard.messageEnd({ role: "custom", customType: "async-result", content: resultText, details: { jobs: [{ jobId: "job-2", agentId: "Review136v2", status: "completed", type: "task" }] } });
    if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "job-2", agentUrlId: "Review136v2", status: "completed", type: "task", resultText }] } });
    assert.match(blocked(guard.toolCall(approved())), /--input REVIEW=Review136v2/);
    assert.equal(guard.toolCall(call(command("run-136", "--input REVIEW=Review136v2"))), undefined);
  }
});

test("the latest valid bound review wins over late earlier results", () => {
  const guard = new TriageGuard();
  reviewer(guard, true, "yes");
  reviewer(guard, false, "yes");
  const request = blocked(guard.toolCall(approved()));
  guard.toolCall({ toolName: "task", toolCallId: "new", input: { agent: "triage-reviewer", task: request } });
  guard.toolResult({ toolName: "task", toolCallId: "new", input: {}, details: { results: [{ index: 0, id: "Review136v2", agent: "triage-reviewer", exitCode: 0, output: output() }] } });
  const earlier = `<task-result id="Review136" agent="triage-reviewer" status="completed"><output>${output("yes")}</output></task-result>`;
  guard.messageEnd({ role: "custom", customType: "async-result", content: earlier, details: { jobs: [{ jobId: "job-1", agentId: "Review136", status: "completed", type: "task" }] } });
  assert.match(blocked(guard.toolCall(approved())), /--input REVIEW=Review136v2/);
  assert.equal(guard.toolCall(call(command("run-136", "--input REVIEW=Review136v2"))), undefined);
});

test("each request marker binds its next reviewer and leaves older markers unbound", () => {
  const guard = new TriageGuard();
  const first = blocked(guard.toolCall(call()));
  const latest = blocked(guard.toolCall(call()));
  assert.notEqual(first, latest);
  assert.equal(guard.toolCall({ toolName: "task", toolCallId: "stale", input: { agent: "triage-reviewer", task: first } }), undefined);
  const batch = guard.toolCall({ toolName: "task", toolCallId: "next", input: { tasks: [
    { agent: "triage-reviewer", task: latest },
    { agent: "triage-reviewer", task: latest },
  ] } });
  assert.ok(batch && "input" in batch);
  assert.ok(batch.input.tasks[0].outputSchema);
  assert.equal(batch.input.tasks[1].outputSchema, undefined);
});

test("a malformed replacement reports its missing field instead of authorizing triage", () => {
  const guard = new TriageGuard();
  reviewer(guard, false, "yes");
  const request = blocked(guard.toolCall(approved()));
  guard.toolCall({ toolName: "task", toolCallId: "malformed", input: { agent: "triage-reviewer", task: request } });
  guard.toolResult({ toolName: "task", toolCallId: "malformed", input: {}, details: { results: [{ index: 0, id: "Review136v2", agent: "triage-reviewer", exitCode: 0, output: "{}" }] } });
  assert.match(blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Review136v2")))), /TRIAGE_REVIEW_INVALID: field=poc expected=string observed=<missing>/);
});

test("a batched call cannot hide an unreviewed POC=no behind a POC=yes completion", () => {
  const guard = new TriageGuard(); reviewer(guard);
  const yes = command("run-a").replace("POC=no", "POC=yes");
  const no = command("run-b", "--input REVIEW=Review136");
  assert.match(blocked(guard.toolCall(call(`${yes} && ${no}`))), /TRIAGE_SINGLE_COMPLETION/);
});
test("async message_end and wait reject an uncorrelated job before issuing a fresh request", () => {
  for (const route of ["message", "wait"]) {
    const guard = new TriageGuard(); reviewer(guard, true);
    if (route === "message") guard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "job-1", agentId: "foreign", status: "completed", type: "task" }] } });
    else guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "foreign-job", agentUrlId: "Review136", status: "completed", type: "task", resultText: envelope }] } });
    assert.match(blocked(guard.toolCall(approved())), /GENERATION=0 REQUEST=2/);
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
test("session_start and native new/resume session_switch reset all state", async () => {
  const handlers: Record<string, Function> = {};
  extension({ on(name: string, handler: Function) { handlers[name] = handler; } });
  for (const event of [{ name: "session_start", data: {} }, { name: "session_switch", data: { reason: "new" } }, { name: "session_switch", data: { reason: "resume" } }]) {
    const request = blocked(await handlers.tool_call!(call()));
    await handlers.tool_call!({ toolName: "task", toolCallId: "review", input: { agent: "triage-reviewer", name: "Review136", task: request } });
    handlers.tool_result!({ toolName: "task", toolCallId: "review", input: {}, details: { results: [{ index: 0, id: "Review136", agent: "triage-reviewer", exitCode: 0, output: output() }] } });
    assert.equal(await handlers.tool_call!(approved()), undefined);
    handlers[event.name]!(event.data); blocked(await handlers.tool_call!(approved()));
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
    guard.toolCall({ toolName: "task", toolCallId: "collision", input: { name: "Review136", agent: "triage-reviewer", task: request } });
    const id = "Review136-2";
    guard.toolResult({ toolName: "task", toolCallId: "collision", input: {}, content: [{ type: "text", text: `Spawned agent \`${id}\` (job \`allocated-job\`).` }], details: route === "sync"
      ? { results: [{ index: 0, id, agent: "triage-reviewer", exitCode: 0, output: output() }] }
      : { results: [], progress: [{ index: 0, id, agent: "triage-reviewer", status: "pending" }], async: { jobId: "allocated-job", type: "task", state: "running" } } });
    const resultText = `<task-result id="${id}" agent="triage-reviewer" status="completed"><output>${output()}</output></task-result>`;
    if (route === "message") guard.messageEnd({ role: "custom", customType: "async-result", content: resultText, details: { jobs: [{ jobId: "allocated-job", agentId: id, status: "completed", type: "task" }] } });
    if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "allocated-job", agentUrlId: id, status: "completed", type: "task", resultText }] } });
    blocked(guard.toolCall(approved()));
    assert.equal(guard.toolCall(call(command("run-136", `--input REVIEW=${id}`))), undefined);
  }
});

test("each native result route binds and expires the triage generation", () => {
  for (const route of ["task", "wait", "async-result"]) {
    const guard = new TriageGuard();
    reviewer(guard, route !== "task");
    const deliver = () => {
      if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "job-1", agentUrlId: "Review136", status: "completed", type: "task", resultText: envelope }] } });
      if (route === "async-result") guard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "job-1", agentId: "Review136", status: "completed", type: "task" }] } });
      if (route === "task") guard.toolResult({ toolName: "task", toolCallId: "review", input: {}, details: { results: [{ index: 0, id: "Review136", agent: "triage-reviewer", exitCode: 0, output: output() }] } });
    };
    deliver();
    assert.equal(guard.toolCall(approved()), undefined);
    guard.toolResult({ ...approved(), details: { exitCode: 0 } });
    deliver();
    assert.match(blocked(guard.toolCall(approved())), /GENERATION=1/);
  }
});

test("an executor-rejected launch preserves the request for a valid retry", () => {
  for (const route of ["task", "wait", "async-result"]) {
    const guard = new TriageGuard();
    const request = blocked(guard.toolCall(call()));
    const launch = { toolName: "task", toolCallId: "rejected", input: { context: "", tasks: [{ agent: "triage-reviewer", name: "Review136", task: request }] } };
    assert.ok(guard.toolCall(launch));
    guard.toolResult({ ...launch, isError: true, details: { results: [], progress: [] }, content: [{ type: "text", text: "Missing `context`." }] });
    const retry = { ...launch, toolCallId: "retry", input: { ...launch.input, context: "Review the supplied triage scope." } };
    const binding = guard.toolCall(retry);
    assert.ok(binding && "input" in binding);
    guard.toolResult({ ...retry, content: [{ type: "text", text: "Spawned agent `Review136` (job `job-1`)." }], details: route === "task"
      ? { results: [{ index: 0, id: "Review136", agent: "triage-reviewer", exitCode: 0, output: output() }] }
      : { results: [], progress: [{ index: 0, id: "Review136", agent: "triage-reviewer" }] } });
    if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "job-1", agentUrlId: "Review136", status: "completed", type: "task", resultText: envelope }] } });
    if (route === "async-result") guard.messageEnd({ role: "custom", customType: "async-result", content: envelope, details: { jobs: [{ jobId: "job-1", agentId: "Review136", status: "completed", type: "task" }] } });
    assert.equal(guard.toolCall(approved()), undefined);
  }
});

test("a synchronous batch binds mixed agent types to their own runs", () => {
  const guard = new TriageGuard();
  const first = blocked(guard.toolCall({ ...call(command("run-a")), toolCallId: "request-a" }));
  const second = blocked(guard.toolCall({ ...call(command("run-b")), toolCallId: "request-b" }));
  const batch = guard.toolCall({ toolName: "task", toolCallId: "batch", input: { tasks: [
    { name: "ReviewA", agent: "task", task: first },
    { name: "Worker", agent: "worker", task: "Work without a review schema" },
    { name: "ReviewB", agent: "reviewer", task: second },
  ] } });
  assert.ok(batch && "input" in batch);
  assert.ok(batch.input.tasks[0].outputSchema);
  assert.equal(batch.input.tasks[1].outputSchema, undefined);
  assert.ok(batch.input.tasks[2].outputSchema);
  guard.toolResult({ toolName: "task", toolCallId: "batch", input: {}, details: { results: [
    { index: 0, id: "ReviewA", agent: "task", exitCode: 0, output: output() },
    { index: 1, id: "Worker", agent: "worker", exitCode: 0, output: "done" },
    { index: 2, id: "ReviewB", agent: "reviewer", exitCode: 0, output: output() },
  ] } });
  assert.match(blocked(guard.toolCall({ ...call(command("run-a", "--input REVIEW=ReviewB")), toolCallId: "wrong" })), /--input REVIEW=ReviewA/);
  assert.equal(guard.toolCall({ ...call(command("run-a", "--input REVIEW=ReviewA")), toolCallId: "complete-a" }), undefined);
  assert.equal(guard.toolCall({ ...call(command("run-b", "--input REVIEW=ReviewB")), toolCallId: "complete-b" }), undefined);
});

test("bound invalid outputs report field, expected and observed through every native result route", () => {
  const decision = JSON.parse(output());
  for (const route of ["task", "wait", "message"]) {
    for (const [value, diagnostic] of [
      [{ ...decision, extra: "surprise" }, "field=extra expected=additionalProperties=false observed=\"surprise\""],
      [{ ...decision, question: "" }, "field=question expected=nonempty string observed=\"\""],
      [{ ...decision, behavior: " " }, "field=behavior expected=nonempty string observed=\" \""],
      [{ ...decision, reason: 42 }, "field=reason expected=string observed=42"],
      [{ ...decision, poc: "maybe" }, "field=poc expected=[\"yes\",\"no\"] observed=\"maybe\""],
      [{ poc: "no", behavior: "proven", question: "Resolved?" }, "field=reason expected=string observed=<missing>"],
      [null, "field=$ expected=object observed=null"],
      [[], "field=$ expected=object observed=[]"],
    ] as const) {
      const guard = new TriageGuard();
      const request = blocked(guard.toolCall(call()));
      guard.toolCall({ toolName: "task", toolCallId: "invalid", input: { agent: "worker", task: request } });
      const text = JSON.stringify(value);
      guard.toolResult({ toolName: "task", toolCallId: "invalid", input: {}, content: [{ type: "text", text: "Spawned agent `Invalid349` (job `invalid-job`)." }], details: route === "task"
        ? { results: [{ index: 0, id: "Invalid349", agent: "worker", exitCode: 0, output: text }] }
        : { results: [], progress: [{ index: 0, id: "Invalid349", agent: "worker" }] } });
      const resultText = `<task-result id="Invalid349" agent="worker" status="completed"><output>${text}</output></task-result>`;
      if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: "invalid-job", agentUrlId: "Invalid349", status: "completed", type: "task", resultText }] } });
      if (route === "message") guard.messageEnd({ role: "custom", customType: "async-result", content: resultText, details: { jobs: [{ jobId: "invalid-job", agentId: "Invalid349", status: "completed", type: "task" }] } });
      const rejection = blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Invalid349"))));
      assert.ok(rejection.includes(`TRIAGE_REVIEW_INVALID: ${diagnostic}`), `${route}: ${rejection}`);
      assert.match(rejection, /GENERATION=0 REQUEST=2/);
    }
  }
});

test("marker binding requires the exact DAG, run, generation and request", () => {
  const guard = new TriageGuard();
  blocked(guard.toolCall(call()));
  for (const marker of [
    "TRIAGE_REVIEW DAG=poc RUN=run-136 GENERATION=0 REQUEST=1",
    "TRIAGE_REVIEW DAG=feature RUN=other GENERATION=0 REQUEST=1",
    "TRIAGE_REVIEW DAG=feature RUN=run-136 GENERATION=1 REQUEST=1",
    "TRIAGE_REVIEW DAG=feature RUN=run-136 GENERATION=0 REQUEST=10",
    "XTRIAGE_REVIEW DAG=feature RUN=run-136 GENERATION=0 REQUEST=1",
    "TRIAGE_REVIEW DAG=feature RUN=run-136 GENERATION=0 REQUEST=1x",
  ]) {
    const launch = { toolName: "task", toolCallId: "unbound", input: { agent: "task", task: marker } };
    assert.equal(guard.toolCall(launch), undefined);
    guard.toolResult({ ...launch, details: { results: [{ index: 0, id: "Unbound", exitCode: 0, output: output() }] } });
  }
  assert.match(blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Unbound")))), /TRIAGE_REVIEW_REQUIRED: Run a task/);
});

test("only the current request result can authorize triage across native result routes", () => {
  for (const route of ["task", "wait", "message"]) {
    for (const staleOutput of [output(), "{}"]) {
      for (const probePending of [true, false]) {
        const guard = new TriageGuard();
        const launch = (id: string, request: string) => {
          const event = { toolName: "task", toolCallId: id, input: { agent: "task", task: request } };
          const bound = guard.toolCall(event);
          assert.ok(bound && "input" in bound);
          if (route !== "task") guard.toolResult({ ...event, content: [{ type: "text", text: `Spawned agent \`${id}\` (job \`job-${id}\`).` }], details: { results: [], progress: [{ index: 0, id, agent: "task" }] } });
          return event;
        };
        const deliver = (event: Event, text: string) => {
          const id = event.toolCallId;
          const resultText = `<task-result id="${id}" agent="task" status="completed"><output>${text}</output></task-result>`;
          if (route === "task") guard.toolResult({ ...event, details: { results: [{ index: 0, id, agent: "task", exitCode: 0, output: text }] } });
          if (route === "wait") guard.toolResult({ toolName: "wait", toolCallId: "wait", input: {}, details: { jobs: [{ id: `job-${id}`, agentUrlId: id, status: "completed", type: "task", resultText }] } });
          if (route === "message") guard.messageEnd({ role: "custom", customType: "async-result", content: resultText, details: { jobs: [{ jobId: `job-${id}`, agentId: id, status: "completed", type: "task" }] } });
        };
        const first = launch("Request1", blocked(guard.toolCall(call())));
        const second = launch("Request2", blocked(guard.toolCall(call())));
        deliver(first, staleOutput);
        if (probePending) {
          const third = blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Request1"))));
          assert.ok(third.startsWith("TRIAGE_REVIEW_REQUIRED:"), third);
          assert.match(third, /GENERATION=0 REQUEST=3/);
          deliver(second, output());
          const currentRequest = blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Request2"))));
          assert.ok(currentRequest.startsWith("TRIAGE_REVIEW_REQUIRED:"), currentRequest);
          assert.match(currentRequest, /GENERATION=0 REQUEST=4/);
          const current = launch("Request4", currentRequest);
          deliver(current, output());
          assert.match(blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Request1")))), /--input REVIEW=Request4/);
          assert.match(blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Request2")))), /--input REVIEW=Request4/);
          assert.equal(guard.toolCall(call(command("run-136", "--input REVIEW=Request4"))), undefined);
        } else {
          deliver(second, output());
          assert.match(blocked(guard.toolCall(call(command("run-136", "--input REVIEW=Request1")))), /--input REVIEW=Request2/);
          assert.equal(guard.toolCall(call(command("run-136", "--input REVIEW=Request2"))), undefined);
        }
      }
    }
  }
});
