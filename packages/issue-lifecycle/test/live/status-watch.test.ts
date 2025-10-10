import { WidgetHost } from "../fixtures/widget-host.ts";
import { useStation } from "../fixtures/service-environment.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_VERSION } from "../../src/bundle.ts";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import extension from "../../src/status/index.ts";
import { statusRepository } from "../fixtures/status-repository.ts";

for (const drift of [undefined, "main", "bundle", "invalid JSON", "unreadable manifest"] as const) for (const idle of [true, false]) test(`watcher delivers five owner notices and keeps the turn running with receiver idle=${idle}, drift=${drift}`, { timeout: 15_000 }, async () => {
  const primary = mkdtempSync(join(tmpdir(), "omp-dagu-notice-"));
  mkdirSync(join(primary, "packages/issue-lifecycle"), { recursive: true });
  const manifest = join(primary, "packages/issue-lifecycle/package.json");
  if (drift === "unreadable manifest") mkdirSync(manifest);
  else writeFileSync(manifest, drift === "invalid JSON" ? "{" : JSON.stringify({ version: drift === "main" ? "0.3.8" : BUNDLE_VERSION }));
  const [major, minor, patch] = BUNDLE_VERSION.split(".").map(Number);
  const compatiblePatch = `${major}.${minor}.${patch! + 1}`;
  let aborts = 0;
  const instructions: { message: string; type: string }[] = [];
  let ready = false;
  const runs = Array.from({ length: 5 }, (_, n) => ({
    name: "feature", dagRunId: `burst-${n}`, statusLabel: "waiting", labels: ["workspace=a4s", `dagu-feature-bundle=${drift === "bundle" ? compatiblePatch : BUNDLE_VERSION}`],
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
    else if (url.pathname.endsWith("/spec")) response.end(JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(primary)}\n` }));
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
  const restoreStation = useStation(process.env.DAGU_HOME!, `http://127.0.0.1:${address.port}`);
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  let busy = !idle;
  let autonomous = 0;
  const received: string[] = [];
  const ctx = {
    cwd: statusRepository, hasUI: false, isIdle: () => !busy, agent: { kind: "main" as const },
    abort() { aborts++; },
    sessionManager: { getSessionId: () => "owner" }, ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
      setWidget() {}, notify(message: string, type: "info" | "warning" | "error") { instructions.push({ message, type }); },
    },
  };
  extension({
    registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; },
    sendMessage(message, options) {
      assert.equal(options?.deliverAs, "aside");
      assert.equal(message.display, false);
      assert.equal(message.customType, "dagu-state");
      // Idle receivers may stay idle until the host starts the reserved turn.
      if (!busy) { autonomous++; assert.equal(autonomous, 1, "receiver admits one autonomous turn"); }
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
      await until(() => received.length === 1);
      await delay(100);
      assert.equal(received.length, 1, "reserve one wake while host admission is pending");
      assert.equal(busy, false);
      busy = true; // The host starts the turn asynchronously after sendMessage returns.
      handlers.agent_start!(null, ctx);
    }
    await until(() => received.length === 5);
    assert.equal(autonomous, idle ? 1 : 0, "the batch shares one active turn");
    await delay(1200); // A second head sweep replays the same ledger IDs.
    assert.deepEqual(received.map(message => message.match(/run=(\S+)/)?.[1]), runs.map(run => run.dagRunId));
    assert.ok(requests.some(path => path.endsWith("/spec")));
    assert.equal(aborts, 0);
    assert.equal(instructions.length, 0, "main drift cannot establish that restarting loads newer modules");
    for (const message of received) {
      const mainVersion = drift === "main" ? "0.3.8"
        : drift === "invalid JSON" || drift === "unreadable manifest" ? "unknown" : BUNDLE_VERSION;
      assert.ok(message.includes(`main=${mainVersion} compat=ok installed=unknown`), message);
    }
  } finally {
    handlers.session_shutdown!(null, ctx);
    restoreStation();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(primary, { recursive: true, force: true });
  }
});

for (const switchSession of [false, true]) test(`idle wake delivers later ticket and terminal notices at active step boundaries, session switch=${switchSession}`, { timeout: 20_000 }, async () => {
  let visible = 0;
  let sweeps = 0;
  const runs = Array.from({ length: 3 }, (_, n) => ({
    name: "feature", dagRunId: `active-${n}`, statusLabel: "waiting",
    labels: ["workspace=a4s", `dagu-feature-bundle=${BUNDLE_VERSION}`],
    params: `ISSUE=${519 + n} OMP_SESSION_ID=owner`,
    nodes: [{ step: { id: "triage", name: "triage", humanTask: {} }, statusLabel: "waiting" }],
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fake");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/dag-runs") {
      sweeps++;
      response.end(JSON.stringify({ dagRuns: runs.slice(0, visible) }));
    } else if (url.pathname === "/api/v1/event-logs") response.end(JSON.stringify({ entries: [] }));
    else if (url.pathname.endsWith("/spec")) response.end(JSON.stringify({ spec: "env: []\n" }));
    else if (url.pathname.startsWith("/api/v1/dag-runs/")) {
      response.end(JSON.stringify({ dagRunDetails: runs.find(run => url.pathname.endsWith(run.dagRunId)) }));
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": ready\n\n");
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.DAGU_URL;
  const restoreStation = useStation(process.env.DAGU_HOME!, `http://127.0.0.1:${address.port}`);
  let busy = false;
  let autonomous = 0;
  const pending: string[] = [];
  const reserved: string[] = [];
  const delivered: string[] = [];
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  const ctx = {
    cwd: statusRepository, hasUI: false, isIdle: () => !busy, agent: { kind: "main" as const },
    sessionManager: { getSessionId: () => "owner" },
    ui: { theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "", last: "" } }, setWidget() {}, notify() {} },
  };
  extension({
    registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; },
    sendMessage(message, options) {
      assert.equal(options?.deliverAs, "aside");
      if (!busy) { autonomous++; reserved.push(message.content!); }
      else pending.push(message.content!); // The host consumes asides at its next step boundary.
    },
  });
  async function until(probe: () => boolean, outcome: string) {
    const deadline = Date.now() + 3500;
    while (!probe()) {
      assert.ok(Date.now() < deadline, `${outcome}: ${JSON.stringify({ autonomous, pending, delivered })}`);
      await delay(20);
    }
  }
  try {
    handlers.session_start!(null, ctx);
    await until(() => sweeps >= 2, "initial silent baseline");
    await delay(100);
    visible = 1;
    await until(() => autonomous === 1, "first idle wake reserved");
    assert.equal(busy, false, "sendMessage returns before host admission");
    assert.deepEqual<string[]>(delivered, []);
    busy = true;
    delivered.push(...reserved.splice(0));
    handlers.agent_start!(null, ctx);
    if (switchSession) {
      const other = { ...ctx, sessionManager: { getSessionId: () => "other-owner" } };
      let before = sweeps;
      handlers.session_switch!(null, other);
      await until(() => sweeps >= before + 2, "other session baseline");
      await delay(100);
      assert.deepEqual<string[]>(pending, []);
      assert.equal(delivered.length, 1, "owner notices stay in their owning session");
      before = sweeps;
      handlers.session_switch!(null, ctx);
      await until(() => sweeps >= before + 2, "owner session baseline");
      await delay(100);
    }
    visible = 2;
    await until(() => pending.length === 1, "second ticket reaches the claimed active turn before agent_end");
    assert.equal(autonomous, 1);
    delivered.push(...pending.splice(0));
    assert.deepEqual(delivered.map(message => message.match(/run=(\S+)/)?.[1]), ["active-0", "active-1"]);
    runs[1]!.statusLabel = "succeeded";
    runs[1]!.nodes = [];
    await until(() => pending.length === 1, "terminal notice reaches the same active turn");
    assert.match(pending[0]!, /run=active-1 status=succeeded/);
    delivered.push(...pending.splice(0));
    assert.equal(autonomous, 1);
    handlers.agent_end!(null, ctx);
    busy = false; // The host becomes idle after the handler returns.
    visible = 3;
    await until(() => autonomous === 2, "a later idle ticket gets its own wake");
    assert.equal(busy, false, "the later idle wake is asynchronous too");
    busy = true;
    delivered.push(...reserved.splice(0));
    handlers.agent_start!(null, ctx);
    assert.match(delivered[3]!, /run=active-2 status=waiting/);
    await delay(1200);
    assert.equal(delivered.length, 4);
    assert.deepEqual<string[]>(pending, []);
  } finally {
    handlers.session_shutdown!(null, ctx);
    restoreStation();
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

for (const scenario of [
  { terminal: "failed", retry: undefined },
  { terminal: "failed", retry: "unavailable" },
  { terminal: "failed", retry: "running" },
  { terminal: "aborted", retry: undefined },
  { terminal: "succeeded", retry: undefined },
  { terminal: "missing", retry: undefined },
] as const) test(`widget recovers absent ${scenario.terminal} run after outage, retry=${scenario.retry}`, { timeout: 20_000 }, async () => {
  let round = 0;
  const detailRounds: number[] = [];
  const run = {
    name: "feature", dagRunId: "outage-run", statusLabel: "running", labels: ["workspace=a4s"],
    params: "OMP_SESSION_ID=owner", nodes: [{ step: { name: "gate" }, statusLabel: "running" }],
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fake");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/dag-runs") {
      // The durable notice sweep is independent: exercise recovery in observe().
      if (!url.searchParams.has("status")) { response.end(JSON.stringify({ dagRuns: [] })); return; }
      round++;
      if (round === 2) { response.writeHead(503); response.end(); return; }
      response.end(JSON.stringify({ dagRuns: round === 1 ? [run] : [] }));
    } else if (url.pathname === "/api/v1/dag-runs/feature/outage-run") {
      detailRounds.push(round);
      if (round >= 3 && scenario.terminal === "missing") {
        response.writeHead(404); response.end(); return;
      }
      if (round === 3 && scenario.retry === "unavailable") {
        response.writeHead(503); response.end(); return;
      }
      const status = round === 1 || (round === 3 && scenario.retry === "running")
        ? "running" : scenario.terminal;
      response.end(JSON.stringify({ dagRunDetails: {
        ...run, statusLabel: status, nodes: [{ step: { name: "gate" }, statusLabel: status }],
      } }));
    } else if (url.pathname === "/api/v1/dag-runs/feature/outage-run/spec") {
      response.end(JSON.stringify({ spec: "env: []\n" }));
    } else {
      // A closed SSE connection starts the next discovery round.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.DAGU_URL;
  const restoreStation = useStation(process.env.DAGU_HOME!, `http://127.0.0.1:${address.port}/`);
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  const notifications: { message: string; type: string; round: number }[] = [];
  const received: { message: string; round: number }[] = [];
  let widget: string[] | undefined;
  const widgetHost = new WidgetHost(lines => { widget = lines; });
  const ctx = {
    cwd: statusRepository, hasUI: true, isIdle: () => false, agent: { kind: "main" as const },
    abort() {},
    sessionManager: { getSessionId: () => "owner" }, ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
      setWidget: widgetHost.setWidget,
      notify(message: string, type: "info" | "warning" | "error") { notifications.push({ message, type, round }); },
    },
  };
  extension({
    registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; },
    sendMessage(message) { received.push({ message: message.content!, round }); },
  });
  const finalRound = scenario.retry ? 4 : 3;
  try {
    handlers.session_start!(null, ctx);
    const deadline = Date.now() + 15_000;
    while (round < finalRound || widget !== undefined) {
      assert.ok(Date.now() < deadline, JSON.stringify({ round, detailRounds, widget, notifications, received }));
      await delay(20);
    }
    await delay(1200); // Another durable sweep must not duplicate the recovered notice.
    assert.deepEqual(detailRounds, scenario.retry ? [1, 3, 4] : [1, 3]);
    if (scenario.terminal === "missing") {
      assert.deepEqual(notifications, []);
      assert.deepEqual(received, []);
    } else {
      const type = scenario.terminal === "failed" ? "error" : scenario.terminal === "aborted" ? "warning" : "info";
      assert.deepEqual(notifications, [{
        message: `dagu · feature outage-run ${scenario.terminal}`, type, round: finalRound,
      }]);
      // All owner wakes belong to the independent durable watcher. This fixture
      // disables its discovery above, leaving only the widget's terminal toast.
      assert.deepEqual(received, []);
    }
  } finally {
    handlers.session_shutdown!(null, ctx);
    restoreStation();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
