import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import extension from "../src/status/index.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { statusRepository } from "./fixtures/status-repository.ts";

interface Tool {
  name: string;
  loadMode: string;
  execute(
    toolCallId: string,
    params: Record<string, never>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: {
      agent: { kind: "main" | "sub" };
      sessionManager: { getSessionId(): string };
    },
  ): Promise<{ content: { type: "text"; text: string }[] }>;
}

test("dagu_session_id returns the caller main session id and rejects subagents", async () => {
  let registered: Tool | undefined;
  extension({
    registerTool(tool: Tool) { registered = tool; },
    registerCommand() {},
    on() {},
    sendMessage() {},
  } as never);
  assert.equal(registered?.name, "dagu_session_id");
  assert.equal(registered?.loadMode, "essential");
  assert.ok(registered);
  const main = {
    agent: { kind: "main" as const },
    sessionManager: { getSessionId: () => "session-main" },
  };
  const result = await registered.execute("call", {}, undefined, undefined, main);
  assert.equal(result.content[0]?.text, "session-main");

  const sub = {
    agent: { kind: "sub" as const },
    sessionManager: { getSessionId: () => "session-sub" },
  };
  await assert.rejects(
    registered.execute("call", {}, undefined, undefined, sub),
    /dagu_session_id rejected: agent.kind=sub/,
  );
});

test("validation wait is displayed to the operator with current approval commands", { timeout: 10_000 }, async () => {
  let ready = false;
  let sweeps = 0;
  const sha = "b".repeat(40);
  const run = {
    name: "feature", dagRunId: "validation-visible", statusLabel: "waiting",
    labels: ["workspace=a4s", `dagu-feature-bundle=${BUNDLE_VERSION}`], params: `ISSUE=276 OMP_SESSION_ID=owner PRIMARY=${statusRepository}`,
    nodes: [{ step: { id: "validation", name: "validation", humanTask: {
      prompt: `Repository: /repo\nTested SHA: ${sha}\nRepository procedure:\nIsolated smoke`,
    } }, statusLabel: "waiting", approvalIteration: 2 }],
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/dag-runs") {
      sweeps++;
      response.end(JSON.stringify({ dagRuns: ready ? [run] : [] }));
    } else if (url.pathname === "/api/v1/event-logs") {
      response.end(JSON.stringify({ entries: [{
        id: "validation-open", type: "dag.run.waiting", recordedAt: "2026-10-16T00:00:00Z",
        data: { dag_run_status: { nodes: [{ step_id: "validation", step_name: "validation", status: 7, approval_iteration: 2 }] } },
      }] }));
    } else if (url.pathname.startsWith("/api/v1/dag-runs/")) {
      response.end(JSON.stringify({ dagRunDetails: run }));
    } else { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": ready\n\n"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.DAGU_URL;
  process.env.DAGU_URL = `http://127.0.0.1:${address.port}`;
  const messages: Array<{ display?: boolean; content?: string }> = [];
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  const ctx = {
    cwd: statusRepository, hasUI: false, isIdle: () => false, agent: { kind: "main" as const },
    abort() { assert.fail("current validation notice must keep the owner session active"); },
    sessionManager: { getSessionId: () => "owner" },
    ui: { theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "", last: "" } }, setWidget() {}, notify() {} },
  };
  extension({
    registerTool() {}, registerCommand() {},
    on(event, handler) { handlers[event] = handler; },
    sendMessage(message) { messages.push(message); },
  });
  try {
    handlers.session_start!(null, ctx);
    const deadline = Date.now() + 7000;
    while (sweeps < 2) { assert.ok(Date.now() < deadline); await delay(20); }
    await delay(100);
    ready = true;
    while (!messages.length) { assert.ok(Date.now() < deadline); await delay(20); }
    assert.equal(messages[0]!.display, true);
    assert.match(messages[0]!.content!, /repo=a4s/);
    assert.ok(messages[0]!.content!.includes(`TESTED_SHA='${sha}'`));
    assert.match(messages[0]!.content!, /--expected-iteration 2 --input REASON=/);
    assert.match(messages[0]!.content!, /Isolated smoke/);
  } finally {
    handlers.session_shutdown!(null, ctx);
    if (previous === undefined) delete process.env.DAGU_URL; else process.env.DAGU_URL = previous;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
