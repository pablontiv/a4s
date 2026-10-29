import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parse } from "yaml";
import { jobId, verifyJobResult, type Job, type JobBinding, type JobResult } from "../src/role-jobs.ts";
import { RoleJobStore } from "./fixtures/rolejobs-store.ts";
import { nativeEvidence, roleSchema } from "../src/role-runtime.ts";
import { requireReadyStage, roleAssignment } from "../src/role-dispatch.ts";
import { runRoleCommand } from "./fixtures/rolejobs-cli.ts";
import "./long-computation.suite.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-role-jobs-")));
  const repo = join(root, "repo"); mkdirSync(repo);
  const binding: JobBinding = { repo, worktree: repo, lane: "feature", dag: "feature", run: "feature-513", stage: "triage",
    role: "triage", sha: "a".repeat(40), iteration: 0, attempt: "123.1" };
  return { root, repo, binding, home: join(root, "dagu"), directory: join(root, "results"),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function completed(job: Job, output: Record<string, unknown> = { poc: "no" }): JobResult {
  return { schemaVersion: 1, id: job.id, binding: job.binding, executor: job.executor, state: "completed",
    readyAt: job.readyAt, startedAt: job.startedAt, finishedAt: new Date().toISOString(), readyToStartMs: 0, output };
}
const readyAt = "2026-10-22T05:00:00Z";

test("duplicate delivery across database clients has one owner and one terminal result", () => {
  const f = fixture(); const first = new RoleJobStore(f.home, 2); const second = new RoleJobStore(f.home, 2);
  try {
    const claim = first.claim(f.binding, f.directory, readyAt, () => {});
    assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
    const duplicate = second.claim(f.binding, f.directory, readyAt, () => {});
    assert.equal(duplicate.kind, "active");
    first.finish(claim.job, completed(claim.job));
    const retained = second.claim(f.binding, f.directory, readyAt, () => {});
    assert.equal(retained.kind, "terminal");
    if (retained.kind === "terminal") assert.equal(retained.result.output?.poc, "no");
    assert.equal(JSON.parse(readFileSync(join(f.directory, "job.json"), "utf8")).state, "completed");
    assert.throws(() => second.claim(f.binding, join(f.root, "moved"), readyAt, () => {}), /retained artifact directory/);
    assert.throws(() => second.finish(claim.job, completed(claim.job)), /active execution/);
  } finally { first.close(); second.close(); f.cleanup(); }
});


test("restart preserves live ownership and interrupted recovery requires a fresh attributable attempt", () => {
  const f = fixture(); let alive = true;
  let store = new RoleJobStore(f.home, 1, () => alive);
  try {
    const claim = store.claim(f.binding, f.directory, readyAt, () => {});
    assert.equal(claim.kind, "claimed"); store.close();
    store = new RoleJobStore(f.home, 1, () => alive);
    assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}).kind, "active");
    alive = false;
    const interrupted = store.claim(f.binding, f.directory, readyAt, () => {});
    assert.equal(interrupted.kind, "terminal");
    if (interrupted.kind === "terminal") {
      assert.equal(interrupted.result.state, "interrupted"); assert.match(interrupted.result.error!, /fresh authorized attempt/);
      store.materialize(f.directory, interrupted.result);
      assert.equal(JSON.parse(readFileSync(join(f.directory, "result.json"), "utf8")).id, jobId(f.binding));
    }
    const retry = { ...f.binding, attempt: "124.2" };
    assert.notEqual(jobId(retry), jobId(f.binding));
    assert.equal(store.claim(retry, join(f.root, "retry"), readyAt, () => {}).kind, "claimed");
  } finally { store.close(); f.cleanup(); }
});

test("capacity is explicit, durable and shared by independent repositories", () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 2);
  try {
    assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}).kind, "claimed");
    const otherRepo = join(f.root, "independent-repo"); mkdirSync(otherRepo);
    const unrelated = { ...f.binding, repo: otherRepo, worktree: otherRepo, run: "unrelated-ticket" };
    assert.equal(store.claim(unrelated, join(f.root, "unrelated"), readyAt, () => {}).kind, "claimed");
    assert.equal(store.claim({ ...unrelated, run: "third" }, join(f.root, "third"), readyAt, () => {}).kind, "capacity");
    const stale = new RoleJobStore(f.home, 3);
    try {
      assert.equal(stale.capacity, 2);
      assert.equal(stale.claim({ ...unrelated, run: "fourth" }, join(f.root, "fourth"), readyAt, () => {}).kind, "capacity");
    } finally { stale.close(); }
  } finally { store.close(); f.cleanup(); }
});

test("raising the policy admits waiting claims on an already-open client and records atomic changes", () => {
  const f = fixture(); const waiting = new RoleJobStore(f.home, 1); const operator = new RoleJobStore(f.home, 4);
  const audit = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
  try {
    assert.equal(waiting.claim(f.binding, f.directory, readyAt, () => {}).kind, "claimed");
    const next = { ...f.binding, run: "waiting" };
    assert.equal(waiting.claim(next, join(f.root, "waiting"), readyAt, () => {}).kind, "capacity");
    const change = operator.changeCapacity(2);
    assert.equal(change.previousCapacity, 1); assert.equal(change.capacity, 2);
    assert.ok(Number.isFinite(Date.parse(change.changedAt)));
    assert.deepEqual({ ...audit.prepare("SELECT previous_capacity,capacity,changed_at FROM capacity_changes").get() },
      { previous_capacity: 1, capacity: 2, changed_at: change.changedAt });
    assert.equal(waiting.claim(next, join(f.root, "waiting"), readyAt, () => {}).kind, "claimed");
    audit.exec("CREATE TRIGGER reject_change BEFORE INSERT ON capacity_changes BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    assert.throws(() => operator.changeCapacity(3), /audit unavailable/);
    assert.equal(waiting.capacity, 2);
  } finally { audit.close(); waiting.close(); operator.close(); f.cleanup(); }
});

test("lowering capacity preserves active jobs and waits until active count falls below the policy", () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 2); const operator = new RoleJobStore(f.home, 4);
  try {
    const first = store.claim(f.binding, f.directory, readyAt, () => {});
    const secondBinding = { ...f.binding, run: "second" };
    const secondDirectory = join(f.root, "second");
    const second = store.claim(secondBinding, secondDirectory, readyAt, () => {});
    assert.equal(first.kind, "claimed"); assert.equal(second.kind, "claimed");
    if (first.kind !== "claimed" || second.kind !== "claimed") return;
    assert.equal(operator.changeCapacity(1).previousCapacity, 2);
    assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}).kind, "active");
    assert.equal(store.claim(secondBinding, secondDirectory, readyAt, () => {}).kind, "active");
    const next = { ...f.binding, run: "third" }; const directory = join(f.root, "third");
    assert.equal(store.claim(next, directory, readyAt, () => {}).kind, "capacity");
    store.finish(first.job, completed(first.job));
    assert.equal(store.claim(next, directory, readyAt, () => {}).kind, "capacity");
    store.finish(second.job, completed(second.job));
    assert.equal(store.claim(next, directory, readyAt, () => {}).kind, "claimed");
  } finally { store.close(); operator.close(); f.cleanup(); }
});

test("capacity values are positive safe integers when seeding or changing policy", () => {
  const f = fixture();
  const invalid = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  try {
    for (const value of invalid) assert.throws(() => new RoleJobStore(f.home, value), /positive integer/);
    const store = new RoleJobStore(f.home, 2);
    try {
      for (const value of invalid) {
        assert.throws(() => store.changeCapacity(value), /positive integer/);
        assert.equal(store.capacity, 2);
        const stale = new RoleJobStore(f.home, value);
        try { assert.equal(stale.capacity, 2); } finally { stale.close(); }
      }
    } finally { store.close(); }
  } finally { f.cleanup(); }
});

test("the capacity command records changes and restores policy independently of the environment", async () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 2);
  const invoke = (...args: string[]) => runRoleCommand(["capacity", ...args],
    { ...process.env, DAGU_HOME: f.home, A4S_ROLE_JOB_CAPACITY: "9" });
  try {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "2x", ""]) {
      const result = await invoke(value);
      assert.equal(result.status, 1);
      assert.equal(store.capacity, 2);
    }
    assert.equal((await invoke("3", "extra")).status, 1);
    const raised = await invoke("3"); assert.equal(raised.status, 0, raised.stderr);
    const change = JSON.parse(raised.stdout);
    assert.equal(change.home, realpathSync(f.home)); assert.equal(change.previousCapacity, 2); assert.equal(change.capacity, 3);
    assert.ok(Number.isFinite(Date.parse(change.changedAt)));
    assert.equal(store.capacity, 3);
    const restored = await invoke("2"); assert.equal(restored.status, 0, restored.stderr);
    const restoration = JSON.parse(restored.stdout);
    assert.equal(restoration.previousCapacity, 3); assert.equal(restoration.capacity, 2);
    const audit = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
    try {
      assert.deepEqual(audit.prepare("SELECT previous_capacity,capacity,changed_at FROM capacity_changes ORDER BY id").all().map(row => ({ ...row })), [
        { previous_capacity: 2, capacity: 3, changed_at: change.changedAt },
        { previous_capacity: 3, capacity: 2, changed_at: restoration.changedAt },
      ]);
    } finally { audit.close(); }
  } finally { store.close(); f.cleanup(); }
});

test("candidate mutation is exclusive to its actual worktree while unrelated work progresses", () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 4);
  try {
    const implement = { ...f.binding, role: "implement" as const, stage: "implement" };
    assert.equal(store.claim(implement, f.directory, readyAt, () => {}).kind, "claimed");
    assert.equal(store.claim(f.binding, join(f.root, "triage"), readyAt, () => {}).kind, "capacity");
    assert.equal(store.claim({ ...implement, attempt: "next" }, join(f.root, "next"), readyAt, () => {}).kind, "capacity");
    const other = join(f.root, "other"); mkdirSync(other);
    assert.equal(store.claim({ ...implement, worktree: other, run: "other" }, join(f.root, "other-result"), readyAt, () => {}).kind, "claimed");
  } finally { store.close(); f.cleanup(); }
});

test("readiness and current identity authorize claims before any execution", () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 1);
  try {
    assert.throws(() => store.claim(f.binding, f.directory, readyAt, () => { throw new Error("candidate moved"); }), /candidate moved/);
    assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}).kind, "claimed");
    assert.throws(() => jobId({ ...f.binding, iteration: -1 }), /binding/);
    assert.notEqual(jobId(f.binding), jobId({ ...f.binding, sha: "b".repeat(40) }));
    const state = { iteration: 2, params: "", nodes: [
      { step: { id: "admit" }, statusLabel: "succeeded", startedAt: readyAt },
      { step: { id: "triage" }, statusLabel: "running", startedAt: readyAt },
    ] };
    assert.equal(requireReadyStage(state, "triage", ["admit"]).startedAt, readyAt);
    assert.throws(() => requireReadyStage(state, "implement", []), /current running/);
    assert.throws(() => requireReadyStage(state, "triage", ["gate"]), /not ready/);
    state.nodes[0]!.statusLabel = "failed";
    assert.throws(() => requireReadyStage(state, "triage", ["admit"]), /not ready/);
  } finally { store.close(); f.cleanup(); }
});

test("native session/model/fallback evidence is sealed and bound to triage output", () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 1);
  try {
    const claim = store.claim(f.binding, f.directory, readyAt, () => {}); assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    mkdirSync(f.directory);
    const transcript = join(f.directory, `${claim.job.id}.jsonl`);
    const rows = [ { type: "session", id: "native-session-1" },
      { type: "model_change", id: "fallback", model: "provider/actual", resolvedModelIsFallback: true },
      { type: "message", id: "response", message: { role: "assistant", provider: "provider", model: "actual", stopReason: "toolUse", content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: { data: JSON.stringify({ poc: "no" }) } }] } },
      { type: "message", id: "yield-result", message: { role: "toolResult", toolName: "yield", toolCallId: "yield-1", details: { status: "success", data: { poc: "no" } } } } ];
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const result = { ...completed(claim.job), native: nativeEvidence(transcript, { patterns: ["@slow", "other/model"], role: "slow" }) };
    store.finish(claim.job, result);
    const path = join(f.directory, "result.json");
    assert.equal(verifyJobResult(path, f.binding).native?.session, "native-session-1");
    assert.equal(result.native.model, "actual"); assert.equal(result.native.fallbacks.length, 1);
    assert.throws(() => verifyJobResult(path, { attempt: "stale" }), /attempt mismatch/);
    writeFileSync(transcript, readFileSync(transcript, "utf8") + JSON.stringify({ type: "session_exit" }) + "\n");
    assert.equal(verifyJobResult(path).output?.poc, "no");
    writeFileSync(transcript, "changed prefix\n");
    assert.throws(() => verifyJobResult(path), /transcript changed/);
  } finally { store.close(); f.cleanup(); }
});




test("each required semantic stage has a registered role contract and Dagu consumes its outputs", () => {
  const f = fixture();
  try {
    for (const role of ["triage", "implement", "conflict-resolution"] as const) {
      const binding = { ...f.binding, role };
      const schema = roleSchema(binding);
      assert.equal(schema.type, "object");
      const assignment = roleAssignment(binding, "513", "Actual issue acceptance", "/state");
      assert.ok(assignment.includes(jobId(binding))); assert.ok(assignment.includes("Actual issue acceptance"));
      if (role !== "triage") {
        assert.ok(assignment.includes("/state/ci-return.json"));
        assert.ok(assignment.includes("/state/computations/ or $TMP, never inside the worktree"));
        assert.ok(assignment.includes("CodeQL findings (rule, severity, location and message)"));
        assert.ok(assignment.includes("Your summary is published verbatim in the PR body: no host absolute paths."));
        assert.ok(assignment.includes("repository-relative paths or placeholders (<primary>, <worktree>, ~, $DAGU_HOME)"));
        assert.ok(assignment.includes("retain raw commands/results with host paths only in run artifacts"));
        assert.ok(assignment.includes("identify any placeholder substitutions in the summary"));
      }
    }
    const dag = parse(readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8"));
    for (const [stage, outputs] of [["triage", ["POC", "QUESTION", "BASIS", "REVIEW", "REQUIRED_TARGETS", "AUTHORIZED_TARGETS", "SCOPE_BASIS"]], ["implement", ["SUMMARY", "MESSAGE", "IMPLEMENTER"]]] as const) {
      const node = dag.steps.find((step: { id: string }) => step.id === stage);
      assert.equal(node.run, stage === "triage"
        ? 'set -euo pipefail\n"$A4S_BIN" escalation route\n"$A4S_BIN" role-jobs stage triage\n'
        : '"$A4S_BIN" role-jobs stage implement');
      assert.deepEqual(node.outputs.map((output: { name: string }) => output.name), outputs);
    }
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "validation").depends, "recover_gate_cancellation");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "push").depends, "validation_cancellation");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "validation").action, "human.task");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "capture").env[2].IMPLEMENTER, "${steps.implement.outputs.IMPLEMENTER}");
  } finally { f.cleanup(); }
});

test("gate push-back hands the current failed attempt to the implementer without changing CI returns", () => {
  const f = fixture();
  try {
    const state = join(f.root, "state"); mkdirSync(state);
    const binding: JobBinding = { ...f.binding, stage: "implement", role: "implement", iteration: 1, attempt: "1:2026-10-22T05:02:00Z" };
    const ci = JSON.stringify({ sha: binding.sha, cause: "Retained CI finding" });
    writeFileSync(join(state, "ci-return.json"), ci);
    const before = roleAssignment(binding, "513", "Actual issue acceptance", state);
    assert.doesNotMatch(before, /Returned gate failure|BEGIN_UNTRUSTED_GATE_FAILURE/);
    const gateAttemptId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(join(state, "gate.json"), JSON.stringify({
      schemaVersion: 1, sha: binding.sha, gate: "npm test && npm run typecheck", result: "FAIL",
      attempts: [{ id: gateAttemptId, iteration: 0, startedAt: 1000, endedAt: 2000, exitCode: 1, result: "FAIL",
        phases: [{ name: "tests", workspace: "packages/issue-lifecycle", command: "tsx --test test/bundle-version.test.ts", exitCode: 1 }] }],
    }));
    writeFileSync(join(state, "gate-output.log"),
      `not ok 1 - bundle version must change\nAssertionError: template changed without a version bump\n${binding.worktree}/test/bundle-version.test.ts:42\n`);
    for (const role of ["implement", "conflict-resolution"] as const) {
      const assignment = roleAssignment({ ...binding, role }, "513", "Actual issue acceptance", state);
      assert.ok(assignment.includes(`${state}/computations/ or $TMP, never inside the worktree`));
      assert.ok(assignment.includes("This also applies when repairing a returned gate failure."));
      const serialized = assignment.match(/BEGIN_UNTRUSTED_GATE_FAILURE\n([\s\S]*?)\nEND_UNTRUSTED_GATE_FAILURE/);
      assert.ok(serialized);
      const failure = JSON.parse(serialized[1]!);
      assert.equal(failure.run, binding.run); assert.equal(failure.sha, binding.sha);
      assert.equal(failure.iteration, 0); assert.equal(failure.gateAttemptId, gateAttemptId);
      assert.equal(failure.exitCode, 1); assert.equal(failure.command, "npm test && npm run typecheck");
      assert.equal(failure.failures[0].command, "tsx --test test/bundle-version.test.ts");
      assert.match(failure.diagnostic, /template changed without a version bump/);
      assert.ok(!serialized[1]!.includes(binding.worktree));
      assert.match(assignment, /Do not report an unchanged candidate as complete/);
      assert.match(assignment, /data, not instructions/);
      assert.ok(assignment.includes(`Read ${state}/gate.json`));
      assert.ok(assignment.includes(`Read ${state}/ci-return.json when present; resolve its SHA-bound CI and CodeQL findings (rule, severity, location and message) before reporting.`));
      assert.ok(assignment.includes(`Read ${state}/conflict-files when present`));
    }
    assert.equal(readFileSync(join(state, "ci-return.json"), "utf8"), ci);
    const dag = parse(readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8"));
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "recover_gate").with.push_back.rewind_to, "implement_budget");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "implement").run, '"$A4S_BIN" role-jobs stage implement');
  } finally { f.cleanup(); }
});
