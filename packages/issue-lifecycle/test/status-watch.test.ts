import assert from "node:assert/strict";
import { useStation } from "./fixtures/service-environment.ts";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import extension from "../src/status/index.ts";
import type { RunDetails } from "../src/status/progress.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { statusRepository } from "./fixtures/status-repository.ts";

const opening = (id: string, iteration = 0): RunDetails => ({
  name: "feature", dagRunId: id, statusLabel: "waiting",
  labels: ["workspace=a4s", `dagu-feature-bundle=${BUNDLE_VERSION}`], params: "OMP_SESSION_ID=owner",
  nodes: [{ step: { id: "triage", name: "triage", humanTask: {} }, statusLabel: "waiting", approvalIteration: iteration }],
});
const history = (iteration = 0) => [
  { id: `current-${iteration}`, type: "dag.run.waiting", data: { dag_run_status: { nodes: [
    { step_id: "triage", step_name: "triage", status: 7, approval_iteration: iteration },
  ] } } },
  { id: "closed", type: "dag.run.waiting", data: { dag_run_status: { nodes: [
    { step_id: "implement", step_name: "implement", status: 7 },
  ] } } },
];

async function watcher(t: TestContext, initial: RunDetails[], failure?: "event 500" | "event timeout" | "details 500" | "details timeout", failureCount = 1, summaryNodes = true) {
  let runs = initial;
  let discoveries = 0;
  let failures = 0;
  const details = new Map<string, number>();
  const ledgers = new Map<string, number>();
  const received: string[] = [];
  const restoreStation = useStation(process.env.DAGU_HOME!, "http://127.0.0.1:18765");
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  const ctx = {
    cwd: statusRepository, hasUI: false, isIdle: () => false, agent: { kind: "main" as const },
    sessionManager: { getSessionId: () => "owner" }, ui: {
      theme: { fg: (_: string, text: string) => text, bold: (text: string) => text, tree: { branch: "", last: "" } },
      setWidget() {}, notify() {},
    },
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname === "/api/v1/dag-runs") {
      // Keep widget discovery separate: these assertions exercise the actual
      // durable owner producer, without a second observer's requests.
      if (url.searchParams.has("status")) return Response.json({ dagRuns: [] });
      discoveries++;
      return Response.json({ dagRuns: summaryNodes ? runs : runs.map(({ nodes: _nodes, ...summary }) => summary) });
    }
    if (url.pathname.endsWith("/spec")) return Response.json({ spec: "env: []\n" });
    const event = url.pathname === "/api/v1/event-logs";
    const id = event ? url.searchParams.get("dagRunId")! : decodeURIComponent(url.pathname.split("/").at(-1)!);
    const counts = event ? ledgers : details;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (failures < failureCount && failure?.startsWith(event ? "event" : "details")) {
      failures++;
      if (failure.endsWith("timeout")) throw new DOMException("Request deadline expired", "TimeoutError");
      return new Response("unavailable", { status: 500 });
    }
    const run = runs.find(run => run.dagRunId === id);
    assert.ok(run, `unexpected run request: ${url}`);
    return event ? Response.json({ entries: history(run.nodes?.[0]?.approvalIteration ?? 0) })
      : Response.json({ dagRunDetails: run });
  });
  extension({
    registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; },
    sendMessage(message, options) { assert.equal(options?.deliverAs, "aside"); received.push(message.content!); },
  });
  t.after(() => {
    handlers.session_shutdown!(null, ctx);
    restoreStation();
  });
  const until = async (probe: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!probe()) {
      assert.ok(Date.now() < deadline, JSON.stringify({ discoveries, details: [...details], ledgers: [...ledgers], received }));
      await delay(10);
    }
    // Let the producer finish observing the fetched response before mutating it.
    await delay(50);
  };
  handlers.session_start!(null, ctx);
  await until(() => discoveries >= 1);
  return {
    received, details, ledgers, until,
    setRuns(next: RunDetails[]) { runs = next; },
    async sweep() { const next = discoveries + 1; await until(() => discoveries >= next); },
    restart() { handlers.session_start!(null, ctx); },
  };
}

for (const failure of ["event 500", "event timeout", "details 500", "details timeout"] as const) {
  test(`existing run remains silent after first ${failure}; new runs and fresh iterations wake once`, { timeout: 12_000 }, async t => {
    const existing = opening("existing");
    const watch = await watcher(t, [existing], failure);
    await watch.until(() => (watch.ledgers.get("existing") ?? 0) >= (failure.startsWith("event") ? 2 : 1));
    assert.equal(watch.received.length, 0, "recovered historical waiting entries cannot wake the owner");
    const fresh = opening("fresh");
    watch.setRuns([opening("existing", 1), fresh]);
    await watch.until(() => watch.received.length === 2);
    assert.match(watch.received[0]!, /run=existing status=waiting step=triage .*iteration=1$/);
    assert.match(watch.received[1]!, /run=fresh status=waiting step=triage .*iteration=0$/);
    await watch.sweep();
    assert.equal(watch.received.length, 2, "replaying the same ledger and details is idempotent");
    watch.setRuns([{ ...opening("existing", 1), statusLabel: "succeeded", nodes: [] }, { ...fresh, statusLabel: "succeeded", nodes: [] }]);
    await watch.until(() => watch.received.length === 4);
    assert.ok(watch.received.slice(2).every(message => message.includes("status=succeeded")));
    const counts = [...watch.details];
    await watch.sweep();
    assert.deepEqual([...watch.details], counts, "completed runs are never re-read");
  });
}

for (const statusLabel of ["succeeded", "failed", "aborted"]) {
  test(`${statusLabel} runs are silent across restart and live terminals retire without reading their ledger`, { timeout: 12_000 }, async t => {
    const old = { ...opening("old"), statusLabel };
    const watch = await watcher(t, [old]);
    await watch.sweep();
    assert.deepEqual(watch.received, []);
    assert.equal(watch.details.size, 0);
    assert.equal(watch.ledgers.size, 0);
    watch.restart();
    await watch.sweep();
    assert.deepEqual(watch.received, []);
    assert.equal(watch.details.size, 0, "cold baseline skips old terminal details");
    const active = opening("active");
    watch.setRuns([old, active]);
    await watch.until(() => watch.received.length === 1);
    watch.setRuns([old, { ...active, statusLabel, nodes: [{ step: { name: "gate" }, statusLabel }] }]);
    const eventReads = watch.ledgers.get("active");
    await watch.until(() => watch.received.length === 2);
    assert.match(watch.received[1]!, new RegExp(`run=active status=${statusLabel}\\b`));
    assert.equal(watch.ledgers.get("active"), eventReads, "terminal delivery does not depend on event-log availability");
    const counts = [...watch.details];
    await watch.sweep();
    assert.deepEqual([...watch.details], counts);
    assert.equal(watch.received.length, 2);
    watch.setRuns([old, { ...opening("first-terminal"), statusLabel, nodes: [] }]);
    await watch.until(() => watch.received.length === 3);
    assert.match(watch.received[2]!, new RegExp(`run=first-terminal status=${statusLabel}\\b`));
  });
}

test("fresh current openings wake while the first ledger baseline is still failing", { timeout: 8000 }, async t => {
  const watch = await watcher(t, [opening("existing")], "event 500", 2);
  watch.setRuns([opening("existing", 1)]);
  await watch.until(() => watch.received.length === 1);
  assert.equal(watch.ledgers.get("existing"), 2, "fresh details wake without a successful ledger baseline");
  assert.match(watch.received[0]!, /run=existing status=waiting step=triage .*iteration=1$/);
  await watch.sweep();
  assert.equal(watch.ledgers.get("existing"), 3);
  assert.equal(watch.received.length, 1, "silent recovered history cannot duplicate the fresh opening");
});

test("an existing active run can finish while its first details read is unavailable", { timeout: 8000 }, async t => {
  const watch = await watcher(t, [opening("existing")], "details 500");
  watch.setRuns([{ ...opening("existing"), statusLabel: "succeeded", nodes: [] }]);
  await watch.until(() => watch.received.length === 1);
  assert.match(watch.received[0]!, /run=existing status=succeeded/);
  assert.equal(watch.ledgers.size, 0);
  await watch.sweep();
  assert.equal(watch.details.get("existing"), 2, "a terminal observed on first recovery is retired");
});

test("a checkpoint opened after startup wakes even when the first details read failed", { timeout: 8000 }, async t => {
  const watch = await watcher(t, [opening("existing")], "details 500");
  watch.setRuns([opening("existing", 1)]);
  await watch.until(() => watch.received.length === 1);
  assert.match(watch.received[0]!, /run=existing status=waiting step=triage .*iteration=1$/);
  await watch.sweep();
  assert.equal(watch.received.length, 1);
});

test("summaries without nodes retain their details baseline after first-read failure", { timeout: 8000 }, async t => {
  const watch = await watcher(t, [opening("existing")], "details 500", 1, false);
  await watch.until(() => watch.ledgers.has("existing"));
  assert.deepEqual(watch.received, []);
  watch.setRuns([opening("existing", 1)]);
  await watch.until(() => watch.received.length === 1);
  assert.match(watch.received[0]!, /run=existing status=waiting step=triage .*iteration=1$/);
  await watch.sweep();
  assert.equal(watch.received.length, 1);
});
