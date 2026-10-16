import assert from "node:assert/strict";
import test from "node:test";
import { EventLog } from "../src/status/event-log.ts";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";

const run: RunDetails = {
  name: "poc", dagRunId: "fast", statusLabel: "succeeded", params: "OMP_SESSION_ID=owner",
  nodes: ["a", "b", "c"].map(name => ({ step: { id: name, name, humanTask: {} }, statusLabel: "succeeded" })),
};
const waiting = (step: string, iteration: number, n: number) => ({
  id: `event-${n}`, type: "dag.run.waiting", recordedAt: `2026-10-16T00:00:00.${n === 1 ? "1" : `1${n}`}Z`,
  data: { dag_run_status: { nodes: [{ step_id: step, step_name: step, status: 7, ...(iteration ? { approval_iteration: iteration } : {}) }] } },
});

test("DEFAULT cursor replay recovers SSE omissions, both iterations and eventual succeeded in order", async t => {
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
  // SSE jumped directly to b; the notice ledger still emits a first.
  const signal = new AbortController().signal;
  const snapshots = await reader.read("http://fake", run, signal);
  assert.equal(restarted, true);
  const messages = snapshots.flatMap(snapshot => {
    const effect = transitions.observe(snapshot);
    return effect.wakeMessages ?? (effect.wakeMessage ? [effect.wakeMessage] : []);
  });
  assert.deepEqual(messages.map(message => message.match(/step=(\w+).*iteration=(\d+)/)?.slice(1)), [
    ["a", "0"], ["b", "0"], ["c", "0"], ["a", "1"], ["b", "1"], ["c", "1"],
  ]);
  assert.deepEqual(await reader.read("http://fake", run, signal), []);
  visible = [...events, { id: "success", type: "dag.run.succeeded", recordedAt: "2026-10-16T00:00:07Z" } as typeof events[number]];
  const terminal = await reader.read("http://fake", run, signal);
  assert.equal(terminal.length, 1);
  assert.ok(transitions.observe(terminal[0]!).wakeMessage?.includes("status=succeeded"));
  assert.deepEqual(await reader.read("http://fake", run, signal), []);
});
