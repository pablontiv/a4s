import assert from "node:assert/strict";
import test from "node:test";
import { EventLog } from "../src/status/event-log.ts";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";

const run: RunDetails = {
  name: "poc", dagRunId: "fast", statusLabel: "waiting", params: "OMP_SESSION_ID=owner",
  nodes: ["a", "b", "c"].map(name => ({ step: { id: name, name, humanTask: {} }, statusLabel: "waiting", approvalIteration: 1 })),
};
const waiting = (step: string, iteration: number, n: number) => ({
  id: `event-${n}`, type: "dag.run.waiting", recordedAt: `2026-10-16T00:00:00.${n === 1 ? "1" : `1${n}`}Z`,
  data: { dag_run_status: { nodes: [{ step_id: step, step_name: step, status: 7, ...(iteration ? { approval_iteration: iteration } : {}) }] } },
});

test("cursor replay preserves persistence order but only wakes still-open checkpoint iterations", async t => {
  const events = [waiting("a", 0, 1), waiting("b", 0, 2), waiting("c", 0, 3), waiting("a", 1, 4), waiting("b", 1, 5), waiting("c", 1, 6)];
  let visible = events.slice();
  let invalidated = false;
  let restarted = false;
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/api/v1/event-logs");
    assert.equal(url.searchParams.get("dagName"), "poc");
    assert.equal(url.searchParams.get("dagRunId"), "fast");
    assert.deepEqual([...url.searchParams.keys()].filter(key => key !== "cursor").sort(),
      ["dagName", "dagRunId", "limit", "paginationMode"]);
    assert.equal(url.searchParams.get("paginationMode"), "cursor");
    const cursor = url.searchParams.get("cursor");
    if (cursor && !invalidated) { invalidated = true; return new Response("stale fingerprint", { status: 400 }); }
    if (!cursor && invalidated) restarted = true;
    const offset = Number(cursor ?? 0);
    const newest = [...visible].reverse();
    return Response.json({ entries: newest.slice(offset, offset + 2), ...(offset + 2 < newest.length ? { nextCursor: String(offset + 2) } : {}) });
  });
  const reader = new EventLog();
  const transitions = new Transitions("owner");
  // The run has parallel waiting nodes at iteration 1; iteration 0 is history.
  const signal = new AbortController().signal;
  const snapshots = await reader.read("http://fake", run, signal);
  assert.equal(restarted, true);
  assert.deepEqual(snapshots[0]?.receiptEvent, { id: "event-1", type: "dag.run.waiting", source: "dagu-persisted-event-log", cursorReset: true });
  const messages = snapshots.flatMap(snapshot => {
    const effect = transitions.observe(snapshot);
    return effect.wakeMessages ?? (effect.wakeMessage ? [effect.wakeMessage] : []);
  });
  assert.deepEqual(messages.map(message => message.match(/step=(\w+).*iteration=(\d+)/)?.slice(1)), [
    ["a", "1"], ["b", "1"], ["c", "1"],
  ]);
  assert.deepEqual(await reader.read("http://fake", run, signal), []);
  visible = [...events, { id: "success", type: "dag.run.succeeded", recordedAt: "2026-10-16T00:00:07Z" } as typeof events[number]];
  const terminal = await reader.read("http://fake", { ...run, statusLabel: "succeeded", nodes: [] }, signal);
  assert.equal(terminal.length, 1);
  assert.ok(transitions.observe(terminal[0]!).wakeMessage?.includes("status=succeeded"));
  assert.deepEqual(await reader.read("http://fake", run, signal), []);
});

for (const statusLabel of ["running", "waiting", "succeeded", "failed", "aborted"]) {
  test(`historical waiting cannot reopen closed tasks when the current run is ${statusLabel}`, async t => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ entries: [
      waiting("a", 0, 1), waiting("b", 1, 2), waiting("c", 1, 3),
    ] }));
    const current: RunDetails = {
      ...run, statusLabel, nodes: [
        { step: { id: "a", name: "a", humanTask: {} }, statusLabel: "waiting", approvalIteration: 1 },
        { step: { id: "b", name: "b", humanTask: {} }, statusLabel: "succeeded", approvalIteration: 1 },
        { step: { id: "c", name: "c" }, statusLabel: "waiting", approvalIteration: 1 },
      ],
    };
    const snapshots = await new EventLog().read("http://fake", current, new AbortController().signal);
    assert.ok(snapshots.every(snapshot => snapshot.nodes?.length === 0),
      "mismatched iterations, closed tasks and non-human nodes never become openings");
    assert.ok(snapshots.every(snapshot => !new Transitions("owner").observe(snapshot).wakeMessage));
  });
}

for (const failure of ["HTTP 500", "timeout"]) {
  test(`a partial ${failure} read does not consume IDs before complete recovery`, async t => {
    let fail = true;
    t.mock.method(globalThis, "fetch", async (input: URL) => {
      const url = new URL(input);
      if (!url.searchParams.has("cursor")) return Response.json({ entries: [waiting("b", 1, 2)], nextCursor: "older" });
      if (fail) {
        if (failure === "timeout") throw new DOMException("Deadline expired", "TimeoutError");
        return new Response("unavailable", { status: 500 });
      }
      return Response.json({ entries: [waiting("a", 1, 1)] });
    });
    const ledger = new EventLog();
    const signal = new AbortController().signal;
    await assert.rejects(ledger.read("http://fake", run, signal), failure === "timeout" ? /Deadline expired/ : /HTTP 500/);
    fail = false;
    const snapshots = await ledger.read("http://fake", run, signal);
    assert.deepEqual(snapshots.map(snapshot => snapshot.receiptEvent?.id), ["event-1", "event-2"]);
    assert.deepEqual(await ledger.read("http://fake", run, signal), []);
  });
}

test("an old succeeded event cannot complete a currently active retry", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ entries: [{ id: "old-success", type: "dag.run.succeeded" }] }));
  assert.deepEqual(await new EventLog().read("http://fake", run, new AbortController().signal), []);
});
