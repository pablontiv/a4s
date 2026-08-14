import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { jobId, RoleJobStore, verifyJobResult, type Job, type JobBinding, type JobResult } from "../src/role-jobs.ts";
import { nativeEvidence, roleSchema } from "../src/role-runtime.ts";
import { dispatchStage, requireReadyStage, roleAssignment, runRoleJob } from "../src/role-dispatch.ts";
import { roleAdmission, roleExecution } from "./role-job-fixtures.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-role-jobs-")));
  const repo = join(root, "repo"); mkdirSync(repo);
  const binding: JobBinding = { repo, worktree: repo, lane: "feature", dag: "feature", run: "feature-513", stage: "quality_review",
    role: "qa", sha: "a".repeat(40), iteration: 0, attempt: "123.1" };
  return { root, repo, binding, home: join(root, "dagu"), directory: join(root, "results"),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function completed(job: Job, output: Record<string, unknown> = { verdict: "FAIL" }): JobResult {
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
    if (retained.kind === "terminal") assert.equal(retained.result.output?.verdict, "FAIL");
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
    const unrelated = { ...f.binding, repo: otherRepo, worktree: otherRepo, run: "unrelated-ticket", role: "reviewer" as const };
    assert.equal(store.claim(unrelated, join(f.root, "unrelated"), readyAt, () => {}).kind, "claimed");
    assert.equal(store.claim({ ...unrelated, run: "third" }, join(f.root, "third"), readyAt, () => {}).kind, "capacity");
    assert.throws(() => new RoleJobStore(f.home, 3), /persisted DAGU_HOME policy/);
    assert.throws(() => new RoleJobStore(f.home, 0), /positive integer/);
  } finally { store.close(); f.cleanup(); }
});

test("candidate mutation is exclusive to its actual worktree while unrelated work progresses", () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 4);
  try {
    const implement = { ...f.binding, role: "implement" as const, stage: "implement" };
    assert.equal(store.claim(implement, f.directory, readyAt, () => {}).kind, "claimed");
    assert.equal(store.claim(f.binding, join(f.root, "qa"), readyAt, () => {}).kind, "capacity");
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
      { step: { id: "quality_prepare" }, statusLabel: "succeeded", startedAt: readyAt },
      { step: { id: "quality_review" }, statusLabel: "running", startedAt: readyAt },
    ] };
    assert.equal(requireReadyStage(state, "quality_review", ["quality_prepare"]).startedAt, readyAt);
    assert.throws(() => requireReadyStage(state, "implement", []), /current running/);
    assert.throws(() => requireReadyStage(state, "quality_review", ["gate"]), /not ready/);
    state.nodes[0]!.statusLabel = "failed";
    assert.throws(() => requireReadyStage(state, "quality_review", ["quality_prepare"]), /not ready/);
  } finally { store.close(); f.cleanup(); }
});

test("native session/model/fallback evidence is sealed and bound, including FAIL outputs", () => {
  const f = fixture(); const store = new RoleJobStore(f.home, 1);
  try {
    const claim = store.claim(f.binding, f.directory, readyAt, () => {}); assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    mkdirSync(f.directory);
    const transcript = join(f.directory, `${claim.job.id}.jsonl`);
    const rows = [ { type: "session", id: "native-session-1" },
      { type: "model_change", id: "fallback", model: "provider/actual", resolvedModelIsFallback: true },
      { type: "message", id: "response", message: { role: "assistant", provider: "provider", model: "actual", stopReason: "toolUse", content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: { data: JSON.stringify({ verdict: "FAIL" }) } }] } },
      { type: "message", id: "yield-result", message: { role: "toolResult", toolName: "yield", toolCallId: "yield-1", details: { status: "success", data: { verdict: "FAIL" } } } } ];
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const result = { ...completed(claim.job), native: nativeEvidence(transcript, { patterns: ["@slow", "other/model"], role: "slow" }) };
    store.finish(claim.job, result);
    const path = join(f.directory, "result.json");
    assert.equal(verifyJobResult(path, f.binding).native?.session, "native-session-1");
    assert.equal(result.native.model, "actual"); assert.equal(result.native.fallbacks.length, 1);
    assert.throws(() => verifyJobResult(path, { attempt: "stale" }), /attempt mismatch/);
    writeFileSync(transcript, readFileSync(transcript, "utf8") + JSON.stringify({ type: "session_exit" }) + "\n");
    assert.equal(verifyJobResult(path).output?.verdict, "FAIL");
    writeFileSync(transcript, "changed prefix\n");
    assert.throws(() => verifyJobResult(path), /transcript changed/);
  } finally { store.close(); f.cleanup(); }
});

test("stage progression retains one execution on concurrent delivery and reports runtime failures", async () => {
  const f = fixture(); let executions = 0; let authorizations = 0;
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>(resolve => { resolveDelivered = resolve; });
  try {
    const options = { home: f.home, capacity: 2, binding: f.binding, directory: f.directory, readyAt,
      assignment: "bounded QA", authorize: async () => { if (++authorizations >= 2) resolveDelivered(); }, execute: async () => {
        executions++; await delivered;
        throw new Error("provider exhausted");
      } };
    const [first, duplicate] = await Promise.all([runRoleJob(options), runRoleJob(options)]);
    assert.equal(executions, 1); assert.equal(first.state, "failed"); assert.deepEqual(duplicate, first);
    assert.match(first.error!, /provider exhausted/);
  } finally { f.cleanup(); }
});

for (const terminal of ["failed", "interrupted"] as const) {
  test(`dispatcher retries a ${terminal} native step attempt and deduplicates successful redelivery`, async () => {
    const f = fixture();
    const saved = { ...process.env }; const originalFetch = globalThis.fetch;
    try {
      execFileSync("git", ["init", "-q", f.repo]);
      execFileSync("git", ["-C", f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
      mkdirSync(f.home);
      const bin = join(f.root, "bin"); mkdirSync(bin);
      for (const [name, output] of [["dagu", "Running - push-back iteration: 0"], ["gh", "{}"]]) {
        writeFileSync(join(bin, name!), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
        chmodSync(join(bin, name!), 0o755);
      }
      const run = "dispatcher-retry";
      const state = join(f.repo, ".git", "dagu-feature", "runs", run); mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "receipt.json"), JSON.stringify(roleAdmission(f.repo, f.home, run, "dagu-role-jobs stage triage")));
      Object.assign(process.env, { PRIMARY: f.repo, DAGU_HOME: f.home, RUN: run, ISSUE: "189", PATH: `${bin}:${saved.PATH}`, A4S_ROLE_JOB_CAPACITY: "2", DAG_PUSHBACK_ITERATION: "0" });
      let startedAt = readyAt;
      const details = () => ({ dagRunDetails: { params: "ISSUE=189 OMP_SESSION_ID=parent-id", nodes: [
        { step: { id: "admit" }, statusLabel: "succeeded", startedAt: readyAt },
        { step: { id: "triage" }, statusLabel: "running", startedAt },
      ] } });
      globalThis.fetch = async () => new Response(JSON.stringify(details()));
      if (terminal === "interrupted") {
        const module = new URL("../src/role-dispatch.ts", import.meta.url).href;
        const code = `import {dispatchStage} from ${JSON.stringify(module)};globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(details()))});await dispatchStage("triage",()=>{},async()=>process.exit(0));`;
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: process.env, encoding: "utf8" });
        assert.equal(child.status, 0, child.stderr);
        await assert.rejects(dispatchStage("triage", () => {}, roleExecution), /interrupted/);
      } else {
        await assert.rejects(dispatchStage("triage", () => {}, async () => { throw new Error("provider exhausted"); }), /provider exhausted/);
      }
      // Only the native step retry changes readiness, never a hand-edited job binding.
      startedAt = "2026-10-22T05:00:01Z";
      let executions = 0;
      const emitted: Record<string, string> = {};
      const execute = async (job: Job, assignment: string) => { executions++; return roleExecution(job, assignment); };
      await Promise.all([0, 1].map(() => dispatchStage("triage", (key, value) => { emitted[key] = value; }, execute)));
      await dispatchStage("triage", () => {}, execute);
      assert.equal(executions, 1);
      assert.equal(emitted.POC, "no");
      const result = verifyJobResult(join(state, "role-jobs", emitted.REVIEW!, "result.json"));
      assert.equal(result.binding.attempt, `0:${startedAt}`);
      const receipt = JSON.parse(readFileSync(join(state, "receipt.json"), "utf8"));
      assert.ok(receipt.runReceipt.observations.some((entry: { data: { state: string } }) => entry.data.state === terminal));
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved); f.cleanup();
    }
  });
}

test("triage completes and redelivers the admitted identity while PRIMARY fast-forwards", async () => {
  const f = fixture();
  const saved = { ...process.env }; const originalFetch = globalThis.fetch;
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", f.repo, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", f.repo]);
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    git("commit", "--allow-empty", "-qm", "admitted");
    const admittedHead = git("rev-parse", "HEAD");
    // Prepare an unrelated ticket's commit without moving PRIMARY yet.
    git("branch", "admitted");
    git("checkout", "-qb", "unrelated");
    git("commit", "--allow-empty", "-qm", "unrelated ticket");
    const nextHead = git("rev-parse", "HEAD");
    git("checkout", "-q", "admitted");
    mkdirSync(f.home);
    const bin = join(f.root, "bin"); mkdirSync(bin);
    for (const [name, output] of [["dagu", "Running - push-back iteration: 0"], ["gh", "{}"]]) {
      writeFileSync(join(bin, name!), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
      chmodSync(join(bin, name!), 0o755);
    }
    const run = "triage-moving-primary";
    const state = join(f.repo, ".git", "dagu-feature", "runs", run); mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "receipt.json"), JSON.stringify(roleAdmission(f.repo, f.home, run, "dagu-role-jobs stage triage")));
    Object.assign(process.env, { PRIMARY: f.repo, DAGU_HOME: f.home, RUN: run, ISSUE: "189", PATH: `${bin}:${saved.PATH}`, A4S_ROLE_JOB_CAPACITY: "2", DAG_PUSHBACK_ITERATION: "0" });
    globalThis.fetch = async () => new Response(JSON.stringify({ dagRunDetails: {
      params: "ISSUE=189 OMP_SESSION_ID=parent-id", nodes: [
        { step: { id: "admit" }, statusLabel: "succeeded", startedAt: readyAt },
        { step: { id: "triage" }, statusLabel: "running", startedAt: readyAt },
      ],
    } }));
    let executions = 0;
    const emitted: Record<string, string> = {};
    const execute = async (job: Job, assignment: string) => {
      executions++;
      assert.equal(job.binding.sha, admittedHead);
      git("merge", "--ff-only", "unrelated");
      assert.equal(git("rev-parse", "HEAD"), nextHead);
      return roleExecution(job, assignment);
    };
    await dispatchStage("triage", (key, value) => { emitted[key] = value; }, execute);
    assert.equal(emitted.POC, "no");
    const result = verifyJobResult(join(state, "role-jobs", emitted.REVIEW!, "result.json"));
    assert.equal(result.state, "completed");
    assert.equal(result.binding.sha, admittedHead);
    const redelivered: Record<string, string> = {};
    await dispatchStage("triage", (key, value) => { redelivered[key] = value; }, execute);
    assert.deepEqual(redelivered, emitted);
    assert.equal(executions, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); f.cleanup();
  }
});

test("independent OS processes share the same transactional claim", async () => {
  const f = fixture();
  try {
    const module = pathToFileURL(fileURLToPath(new URL("../src/role-jobs.ts", import.meta.url))).href;
    const code = `import {RoleJobStore} from ${JSON.stringify(module)}; const store=new RoleJobStore(${JSON.stringify(f.home)},2); console.log(store.claim(${JSON.stringify(f.binding)},${JSON.stringify(f.directory)},${JSON.stringify(readyAt)},()=>{}).kind); process.stdin.once("data",()=>{store.close();process.exit(0)});`;
    const workers = [0, 1].map(() => {
      let resolveClaim!: (value: string) => void;
      let rejectClaim!: (reason: Error) => void;
      const claim = new Promise<string>((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject; });
      let resolveDone!: () => void;
      let rejectDone!: (reason: Error) => void;
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", data => { stdout += data; if (stdout.includes("\n")) resolveClaim(stdout.trim()); });
      child.stderr.on("data", data => { stderr += data; });
      child.on("error", error => { rejectClaim(error); rejectDone(error); });
      child.on("close", code => {
        if (code === 0) resolveDone();
        else { const error = new Error(stderr); rejectClaim(error); rejectDone(error); }
      });
      return { child, claim, done };
    });
    const results = await Promise.all(workers.map(worker => worker.claim));
    for (const worker of workers) worker.child.stdin.end("release");
    await Promise.all(workers.map(worker => worker.done));
    assert.deepEqual(results.sort(), ["active", "claimed"]);
    const restarted = new RoleJobStore(f.home, 2);
    try {
      const recovered = restarted.claim(f.binding, f.directory, readyAt, () => {});
      assert.equal(recovered.kind, "terminal");
      if (recovered.kind === "terminal") assert.equal(recovered.result.state, "interrupted");
      assert.equal(restarted.claim({ ...f.binding, attempt: "fresh-after-process-exit" }, f.directory, readyAt, () => {}).kind, "claimed");
    } finally { restarted.close(); }
  } finally { f.cleanup(); }
});

test("each required semantic stage has a registered role contract and Dagu consumes its outputs", () => {
  const f = fixture();
  try {
    for (const role of ["triage", "implement", "conflict-resolution", "qa", "reviewer"] as const) {
      const binding = { ...f.binding, role };
      const schema = roleSchema(binding);
      assert.equal(schema.type, "object");
      const assignment = roleAssignment(binding, "513", "Actual issue acceptance", "/state");
      assert.ok(assignment.includes(jobId(binding))); assert.ok(assignment.includes("Actual issue acceptance"));
    }
    const dag = parse(readFileSync(new URL("../skills/dagu-feature/feature.yaml", import.meta.url), "utf8"));
    for (const [stage, outputs] of [["triage", ["POC", "QUESTION", "BASIS", "REVIEW", "REQUIRED_TARGETS", "AUTHORIZED_TARGETS", "SCOPE_BASIS"]], ["implement", ["SUMMARY", "MESSAGE", "IMPLEMENTER"]]] as const) {
      const node = dag.steps.find((step: { id: string }) => step.id === stage);
      assert.equal(node.run, stage === "triage"
        ? "set -euo pipefail\ndagu-feature-bundle escalation route\ndagu-role-jobs stage triage\n"
        : "dagu-role-jobs stage implement");
      assert.deepEqual(node.outputs.map((output: { name: string }) => output.name), outputs);
    }
    const quality = dag.steps.find((step: { id: string }) => step.id === "quality_review");
    assert.equal(quality.run, "set -euo pipefail\ndagu-role-jobs stage quality_review\n");
    assert.deepEqual(quality.outputs.map((output: { name: string }) => output.name), ["QA", "REVIEW"]);
    const transition = dag.steps.find((step: { id: string }) => step.id === "quality_transition");
    assert.equal(transition.action, "human.task");
    assert.deepEqual(transition.with.form.properties.CANCEL, { type: "string", enum: ["yes", "no"] });
    const cancellation = dag.steps.find((step: { id: string }) => step.id === "quality_transition_cancellation");
    assert.equal(cancellation.depends, "quality_transition");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "quality_admit").depends, "quality_review");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "validation").action, "human.task");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "capture").env[2].IMPLEMENTER, "${steps.implement.outputs.IMPLEMENTER}");
    assert.equal(dag.steps.find((step: { id: string }) => step.id === "quality_admit").env[0].QA, "${steps.quality_review.outputs.QA}");
  } finally { f.cleanup(); }
});
