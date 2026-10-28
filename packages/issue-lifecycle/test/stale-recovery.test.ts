import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decideStaleRecoveries, emptyLedger, FEATURE_CHECKPOINT_RETRY, FEATURE_HUMAN_TASKS, FEATURE_STEP_ORDER,
  STALE_PROCESS_ERROR, type AdminEvent, type DagNodeSnapshot,
} from "../src/stale-recovery.ts";

function node(id: string, status?: number): DagNodeSnapshot {
  return status === undefined ? { step_id: id, step_name: id } : { step_id: id, step_name: id, status };
}

function event(input: {
  type: string; at: string; service: string; instance: string; run: string; attempt: string;
  nodes?: DagNodeSnapshot[]; error?: string; dag?: string;
}): AdminEvent {
  return {
    type: input.type, occurred_at: input.at, recorded_at: input.at, source_service: input.service,
    source_instance: input.instance, dag_name: input.dag ?? "feature", dag_run_id: input.run, attempt_id: input.attempt,
    data: { dag_run_status: { ...(input.error ? { error: input.error } : {}), nodes: input.nodes ?? [] } },
  };
}

function pair(run: string, attempt: string, previous: "dag.run.waiting" | "dag.run.queued", nodes: DagNodeSnapshot[], error = STALE_PROCESS_ERROR): AdminEvent[] {
  return [
    event({ type: previous, at: "2026-10-22T06:08:13.000Z", service: "cli", instance: "station:111", run, attempt, nodes }),
    event({ type: "dag.run.failed", at: "2026-10-22T06:08:14.000Z", service: "scheduler", instance: "station:64722", run, attempt, nodes, error }),
  ];
}

function queuedThrough(step: string): DagNodeSnapshot[] {
  const cutoff = FEATURE_STEP_ORDER.indexOf(step);
  assert.ok(cutoff > 0);
  return FEATURE_STEP_ORDER.map((id, index) => node(id, index < cutoff ? 4 : undefined));
}



test("stale-process recovery follows the SKILL table and refuses non-stale or same-writer failures", () => {
  const skill = readFileSync(new URL("../skills/issue-execution/SKILL.md", import.meta.url), "utf8");
  const fromSkill: Record<string, string> = {};
  for (const row of skill.matchAll(/^\| feature \| ([^|\n]+) \| ([^|\n]+) \|$/gm)) {
    const step = row[2]!.trim();
    for (const checkpoint of row[1]!.split(",").map(part => part.trim())) fromSkill[checkpoint] = step;
  }
  assert.deepEqual(fromSkill, FEATURE_CHECKPOINT_RETRY);
  assert.match(skill, /a4s stale-recovery recover-scheduled/);
  assert.match(skill, /manual table above/);
  assert.match(readFileSync(new URL("../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8"), /"\$A4S_BIN" stale-recovery recover-scheduled/);
  assert.ok(FEATURE_HUMAN_TASKS.has("escalation"));
  assert.equal(Object.hasOwn(FEATURE_CHECKPOINT_RETRY, "escalation"), false);

  const sameWriter = pair("same-writer", "111aaa", "dag.run.waiting", [node("conflict_review", 7)]);
  const writer = sameWriter[0]?.source_instance ?? "station:111";
  sameWriter[1] = { ...sameWriter[1]!, source_instance: writer };
  assert.deepEqual(decideStaleRecoveries(sameWriter, emptyLedger()), []);
  const running = pair("was-running", "222bbb", "dag.run.waiting", [node("conflict_review", 7)]);
  running[0] = { ...running[0]!, type: "dag.run.running" };
  assert.deepEqual(decideStaleRecoveries(running, emptyLedger()), []);
  const manual = decideStaleRecoveries(pair("needs-person", "333ccc", "dag.run.waiting", [node("escalation", 7)]), emptyLedger())[0];
  assert.equal(manual?.action, "manual");
  assert.equal(manual?.action === "manual" ? manual.checkpoint : "", "escalation");
  const resumed = decideStaleRecoveries(pair("after-capture", "444ddd", "dag.run.queued", queuedThrough("rebase")), emptyLedger())[0];
  assert.equal(resumed?.action, "retry");
  assert.equal(resumed?.action === "retry" ? resumed.step : "", "rebase");
  for (const [checkpoint, step] of [["implement", "start_gate"], ["quality_review", "quality_prepare"]] as const) {
    const legacy = decideStaleRecoveries(pair(`legacy-${checkpoint}`, "555eee", "dag.run.waiting", [node(checkpoint, 7)]), emptyLedger())[0];
    assert.equal(legacy?.action === "retry" ? legacy.step : "", step);
  }
  const newerAttempt = [
    ...pair("new-attempt", "old111", "dag.run.waiting", [node("conflict_review", 7)]),
    event({ type: "dag.run.failed", at: "2026-10-22T06:08:15.000Z", service: "cli", instance: "station:112", run: "new-attempt", attempt: "new222", error: "gate failed" }),
  ];
  assert.deepEqual(decideStaleRecoveries(newerAttempt, emptyLedger()), []);
});

test("recovery requires the scheduler signature on the latest attempt and latest status", () => {
  const original = pair("strict-signature", "111aaa", "dag.run.waiting", [node("conflict_review", 7)]);
  for (const change of [
    { source_service: "cli" },
    { source_instance: "" },
    { type: "dag.run.aborted" },
    { data: { dag_run_status: { error: "CI verification failed" } } },
  ]) {
    assert.deepEqual(decideStaleRecoveries([original[0]!, { ...original[1]!, ...change }], emptyLedger()), []);
  }
  const resumed = event({
    type: "dag.run.queued", at: "2026-10-22T06:08:15.000Z", service: "cli",
    instance: "station:112", run: "strict-signature", attempt: "111aaa", nodes: queuedThrough("gate"),
  });
  assert.deepEqual(decideStaleRecoveries([...original, resumed], emptyLedger()), []);
  // A status from a different attempt cannot supply the required predecessor.
  assert.deepEqual(decideStaleRecoveries([
    { ...original[0]!, attempt_id: "old111" }, original[1]!,
  ], emptyLedger()), []);

  for (const [checkpoint, step] of Object.entries(FEATURE_CHECKPOINT_RETRY)) {
    const decision = decideStaleRecoveries(pair(`table-${checkpoint}`, "111aaa", "dag.run.waiting", [node(checkpoint, 7)]), emptyLedger())[0];
    assert.equal(decision?.action === "retry" ? decision.step : undefined, step, checkpoint);
  }
});

test("recovery requires an immediate scheduler overwrite with valid event timestamps", () => {
  const original = pair("immediate-repair", "111aaa", "dag.run.waiting", [node("conflict_review", 7)]);
  for (const at of ["2026-10-22T06:08:18.001Z", "", "invalid"]) {
    const failed = { ...original[1]!, occurred_at: at, recorded_at: at };
    assert.deepEqual(decideStaleRecoveries([original[0]!, failed], emptyLedger()), [], at);
  }
  const boundary = { ...original[1]!, occurred_at: "2026-10-22T06:08:18.000Z" };
  assert.equal(decideStaleRecoveries([original[0]!, boundary], emptyLedger())[0]?.action, "retry");
  const missingPreviousTime = { ...original[0]!, occurred_at: "", recorded_at: "" };
  assert.deepEqual(decideStaleRecoveries([missingPreviousTime, original[1]!], emptyLedger()), []);
});

test("native RFC3339Nano timestamps order zero and fractional seconds across admin files", () => {
  const events = pair("timestamp-order", "111aaa", "dag.run.waiting", [node("conflict_review", 7)]);
  events[0] = { ...events[0]!, occurred_at: "2026-10-22T06:08:13Z" };
  events[1] = { ...events[1]!, occurred_at: "2026-10-22T06:08:13.000000001Z" };
  assert.equal(decideStaleRecoveries([...events].reverse(), emptyLedger())[0]?.action, "retry");
  const newerFailure = event({
    type: "dag.run.failed", at: "2026-10-22T06:08:13.000000002Z", service: "cli",
    instance: "station:112", run: "timestamp-order", attempt: "new222", error: "verifier failed",
  });
  assert.deepEqual(decideStaleRecoveries([newerFailure, ...events].reverse(), emptyLedger()), []);
});
