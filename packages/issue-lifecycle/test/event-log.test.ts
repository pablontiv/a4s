import assert from "node:assert/strict";
import test from "node:test";
import { EventLog } from "../src/status/event-log.ts";
import { Transitions, type RunDetails } from "../src/status/progress.ts";

test("persisted waiting events retain the failed node stderr for recovery notices", async t => {
  const run: RunDetails = {
    name: "feature", dagRunId: "rejected-push", statusLabel: "waiting",
    params: "ISSUE=355 OMP_SESSION_ID=owner",
    nodes: [
      { step: { id: "push", name: "push" }, statusLabel: "failed", error: "exit status 1\nrecent stderr (tail):\ntransport context\nrule=push.remote_lease expected=abc observed=def" },
      { step: { id: "recover_push", name: "recover_push", humanTask: { prompt: "Static recovery prompt" } }, statusLabel: "waiting", approvalIteration: 0 },
    ],
  };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ entries: [{
    id: "waiting-event", type: "dag.run.waiting", data: { dag_run_status: { nodes: [
      { step_id: "recover_push", step_name: "recover_push", status: 7, approval_iteration: 0 },
    ] } },
  }] })));
  const snapshots = await new EventLog().read("http://dagu.invalid", run, new AbortController().signal);
  assert.equal(snapshots.length, 1);
  assert.match(new Transitions("owner").observe(snapshots[0]!).wakeMessage!, /cause=rule=push.remote_lease expected=abc observed=def$/);
});
