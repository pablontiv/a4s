import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import extension from "../src/status/index.ts";

for (const idle of [true, false]) test(`watcher delivers five owner notices exactly once with receiver idle=${idle}`, { timeout: 15_000 }, async () => {
  let ready = false;
  const runs = Array.from({ length: 5 }, (_, n) => ({
    name: "feature", dagRunId: `burst-${n}`, statusLabel: "waiting", labels: ["workspace=a4s"],
    params: "OMP_SESSION_ID=owner", nodes: [{ step: { id: "triage", name: "triage", humanTask: {} }, statusLabel: "waiting" }],
  }));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fake");
    requests.push(url.pathname);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/dag-runs") response.end(JSON.stringify({
      dagRuns: ready ? runs : url.searchParams.has("status") ? runs.map(run => ({
        ...run, statusLabel: "queued", nodes: [],
      })) : [],
    }));
    else if (url.pathname === "/api/v1/event-logs") response.end(JSON.stringify({ entries: [{
      id: url.searchParams.get("dagRunId"), type: "dag.run.waiting", recordedAt: "2026-10-16T00:00:00Z",
      data: { dag_run_status: { nodes: [{ step_id: "triage", step_name: "triage", status: 7 }] } },
    }] }));
    else if (url.pathname.startsWith("/api/v1/dag-runs/")) response.end(JSON.stringify({ dagRunDetails: runs.find(run => url.pathname.endsWith(run.dagRunId)) }));
    else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // SSE skips the first four openings. Durable notices still arrive in order.
      response.write(`event: message\ndata: ${JSON.stringify({
        topic: "dagrun:feature/burst-4", payload: { dagRunDetails: runs[4] },
      })}\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.DAGU_URL;
  process.env.DAGU_URL = `http://127.0.0.1:${address.port}`;
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  let busy = !idle;
  let autonomous = 0;
  const received: string[] = [];
  const ctx = {
    cwd: process.cwd(), hasUI: false, isIdle: () => !busy, agent: { kind: "main" as const },
    sessionManager: { getSessionId: () => "owner" }, ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
      setWidget() {}, notify() {},
    },
  };
  extension({
    registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; },
    sendMessage(message, options) {
      assert.equal(options?.deliverAs, "aside");
      assert.equal(message.display, false);
      assert.equal(message.customType, "dagu-state");
      if (!busy) { autonomous++; assert.equal(autonomous, 1, "receiver admits one autonomous turn"); busy = true; }
      received.push(message.content!);
    },
  });
  async function until(probe: () => boolean) {
    const deadline = Date.now() + 10_000;
    while (!probe()) { assert.ok(Date.now() < deadline, JSON.stringify({ received, requests })); await delay(20); }
  }
  try {
    handlers.session_start!(null, ctx);
    await until(() => requests.filter(path => path === "/api/v1/dag-runs").length >= 2);
    await delay(100);
    ready = true;
    if (idle) {
      for (let n = 1; n <= 5; n++) {
        await until(() => received.length >= n);
        assert.equal(received.length, n);
        autonomous = 0; busy = false;
        handlers.agent_end!(null, ctx);
      }
    } else await until(() => received.length === 5);
    await delay(1200); // A second head sweep replays the same ledger IDs.
    assert.deepEqual(received.map(message => message.match(/run=(\S+)/)?.[1]), runs.map(run => run.dagRunId));
  } finally {
    handlers.session_shutdown!(null, ctx);
    if (previous === undefined) delete process.env.DAGU_URL; else process.env.DAGU_URL = previous;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
