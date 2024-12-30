import { stationEnvironment } from "../fixtures/service-environment.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { jobId, RoleJobStore, verifyJobResult, type JobBinding, type Job } from "../../src/role-jobs.ts";
import { dispatchStage, runRoleJob } from "../../src/role-dispatch.ts";
import { roleAdmission, roleExecution } from "../role-job-fixtures.ts";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-role-jobs-")));
  const repo = join(root, "repo"); mkdirSync(repo);
  const binding: JobBinding = { repo, worktree: repo, lane: "feature", dag: "feature", run: "feature-513", stage: "triage", role: "triage", sha: "a".repeat(40), iteration: 0, attempt: "123.1" };
  return { root, repo, binding, home: join(root, "dagu"), directory: join(root, "results"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const readyAt = "2026-10-22T05:00:00Z";
test("store initialization waits for another process's initial database transaction", async () => {
  const f = fixture();
  mkdirSync(f.home);
  const initializing = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
  initializing.exec("CREATE TABLE seed (id INTEGER); BEGIN IMMEDIATE");
  const module = new URL("../../src/role-jobs.ts", import.meta.url).href;
  const code = `import {RoleJobStore} from ${JSON.stringify(module)};
process.stdout.write("opening\\n");
const store = new RoleJobStore(${JSON.stringify(f.home)}, 2);
store.close(); process.stdout.write("ready\\n");`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let error = ""; let released = false;
  let release: NodeJS.Timeout | undefined;
  child.stdout.on("data", data => {
    output += data;
    if (output.includes("opening\n") && !release) {
      // SQLite busy_timeout runs inside a separate native process, so real time
      // holds the lock across its open; JavaScript fake timers cannot drive it.
      release = setTimeout(() => { initializing.exec("COMMIT"); released = true; }, 100);
    }
  });
  child.stderr.on("data", data => { error += data; });
  try {
    const [status] = await once(child, "exit");
    assert.equal(status, 0, error);
    assert.equal(released, true);
    assert.equal(output, "opening\nready\n");
    const store = new RoleJobStore(f.home, 2);
    try { assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}).kind, "claimed"); }
    finally { store.close(); }
  } finally {
    clearTimeout(release);
    initializing.close(); f.cleanup();
  }
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
      writeFileSync(join(state, "receipt.json"), JSON.stringify({ ...roleAdmission(f.repo, f.home, run, "dagu-role-jobs stage triage"), schemaVersion: 2 }));
      Object.assign(process.env, stationEnvironment({ ...process.env, PRIMARY: f.repo, DAGU_HOME: f.home, RUN: run, ISSUE: "189", PATH: `${bin}:${saved.PATH}`, A4S_ROLE_JOB_CAPACITY: "2", DAG_PUSHBACK_ITERATION: "0" }));
      let startedAt = readyAt;
      const details = () => ({ dagRunDetails: { params: "ISSUE=189 OMP_SESSION_ID=parent-id", nodes: [
        { step: { id: "admit" }, statusLabel: "succeeded", startedAt: readyAt },
        { step: { id: "triage" }, statusLabel: "running", startedAt },
      ] } });
      globalThis.fetch = async () => new Response(JSON.stringify(details()));
      if (terminal === "interrupted") {
        const module = new URL("../../src/role-dispatch.ts", import.meta.url).href;
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

test("triage seeds capacity from the environment and redelivers with a diagnosed stale value while PRIMARY fast-forwards", async t => {
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
    Object.assign(process.env, stationEnvironment({ ...process.env, PRIMARY: f.repo, DAGU_HOME: f.home, RUN: run, ISSUE: "189", PATH: `${bin}:${saved.PATH}`, A4S_ROLE_JOB_CAPACITY: "2", DAG_PUSHBACK_ITERATION: "0" }));
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
    const policy = new RoleJobStore(f.home, 9);
    try {
      assert.equal(policy.capacity, 2);
      policy.changeCapacity(1);
    } finally { policy.close(); }
    process.env.A4S_ROLE_JOB_CAPACITY = "3";
    const diagnostics: string[] = [];
    t.mock.method(console, "error", (message: string) => { diagnostics.push(message); });
    const result = verifyJobResult(join(state, "role-jobs", emitted.REVIEW!, "result.json"));
    assert.equal(result.state, "completed");
    assert.equal(result.binding.sha, admittedHead);
    const redelivered: Record<string, string> = {};
    await dispatchStage("triage", (key, value) => { redelivered[key] = value; }, execute);
    assert.deepEqual(redelivered, emitted);
    assert.deepEqual(diagnostics, ['ROLE_JOB_CAPACITY {"environmentCapacity":"3","persistedCapacity":1,"authority":"persisted"}']);
    assert.equal(executions, 1);
    process.env.A4S_ROLE_JOB_CAPACITY = "stale-invalid";
    diagnostics.length = 0;
    await dispatchStage("triage", () => {}, execute);
    assert.deepEqual(diagnostics, ['ROLE_JOB_CAPACITY {"environmentCapacity":"stale-invalid","persistedCapacity":1,"authority":"persisted"}']);
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
    const module = pathToFileURL(fileURLToPath(new URL("../../src/role-jobs.ts", import.meta.url))).href;
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
test("stage progression retains one execution on concurrent delivery and reports runtime failures", async () => {
  const f = fixture(); let executions = 0; let authorizations = 0;
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>(resolve => { resolveDelivered = resolve; });
  try {
    const options = { home: f.home, capacity: 2, binding: f.binding, directory: f.directory, readyAt,
      assignment: "bounded triage", authorize: async () => { if (++authorizations >= 2) resolveDelivered(); }, execute: async () => {
        executions++; await delivered;
        throw new Error("provider exhausted");
      } };
    const [first, duplicate] = await Promise.all([runRoleJob(options), runRoleJob(options)]);
    assert.equal(executions, 1); assert.equal(first.state, "failed"); assert.deepEqual(duplicate, first);
    assert.match(first.error!, /provider exhausted/);
  } finally { f.cleanup(); }
});
