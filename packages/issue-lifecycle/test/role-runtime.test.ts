import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectRoleRuntime, executeNativeJob, roleEnvironment, type RoleProcessBoundary } from "../src/role-runtime.ts";
import { HOST_MODULES, runRoleRunner, type HostLoader } from "../src/role-runner.ts";
import { packageRoot } from "../src/executable.ts";
import { jobId, verifyJobResult, type Job } from "../src/role-jobs.ts";
import { roleExecution } from "./role-job-fixtures.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-role-unit-")));
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "omp"), "compiled host fixture", { mode: 0o755 });
  const binding = { repo: root, worktree: root, lane: "feature", dag: "feature", run: "unit", stage: "triage", role: "triage" as const,
    sha: "a".repeat(40), iteration: 0, attempt: "0:now" };
  const job: Job = { schemaVersion: 1, id: jobId(binding), binding, directory: join(root, "job"), state: "running",
    executor: { host: "fixture", pid: 1, processStartedAt: "now" }, readyAt: "now", startedAt: "now" };
  mkdirSync(job.directory);
  return { root, bin, job, dispose() { rmSync(root, { recursive: true, force: true }); } };
}

test("the Dagu environment allowlist scrubs host startup without mutating the parent", () => {
  const environment = { HOME: "/home/fixture", PATH: "/tools", RUN: "unit", PRIMARY: "/repo", WORKTREE: "/work", ISSUE: "791",
    DAGU_HOME: "/dagu", DAG_PUSHBACK_ITERATION: "2", DAGU_OUTPUT_FILE: "/private", DAG_RUN_LOG_FILE: "/log",
    DAG_RUN_STEP_STDOUT_FILE: "/stdout", DAG_RUN_STEP_NAME: "implement", DAGU_UNRELATED: "no", DAG_OTHER: "no", API_KEY: "keep" };
  assert.deepEqual(roleEnvironment(environment), { HOME: "/home/fixture", PATH: "/tools", RUN: "unit", PRIMARY: "/repo", WORKTREE: "/work",
    ISSUE: "791", DAGU_HOME: "/dagu", DAG_PUSHBACK_ITERATION: "2", API_KEY: "keep" });
  assert.equal(environment.DAGU_OUTPUT_FILE, "/private");
});

test("detect resolves PATH realpath and uses the release runner with the exact headless flags", async t => {
  const f = fixture(); t.after(f.dispose);
  const previous = process.env; process.env = { ...process.env, PATH: f.bin, DAGU_OUTPUT_FILE: "private", DAG_RUN_STEP_NAME: "detect" };
  t.after(() => { process.env = previous; });
  const calls: string[][] = [];
  const boundary: RoleProcessBoundary = { async run(binary, args, options) {
    calls.push(args);
    assert.equal(binary, realpathSync(join(f.bin, "omp")));
    assert.equal(options.env.DAGU_OUTPUT_FILE, undefined);
    assert.equal(options.env.DAG_RUN_STEP_NAME, undefined);
    if (args[0] === "--version") return { code: 0, stdout: "omp/fixture\n", stderr: "" };
    assert.deepEqual(args.slice(0, 4), ["-p", "--no-session", "-e", join(packageRoot, "src/role-runner.ts")]);
    const directory = args.at(-1)!;
    const input = JSON.parse(readFileSync(join(directory, "runner-input.json"), "utf8"));
    assert.equal(input.runtime.version, "omp/fixture");
    assert.match(input.runtime.digest, /^[a-f0-9]{64}$/);
    writeFileSync(join(directory, "detect.json"), JSON.stringify({ root: binary, agents: [{ name: "triage-reviewer", source: input.agentFile }, { name: "task", source: "bundled" }] }));
    return { code: 0, stdout: "host noise is not the protocol", stderr: "" };
  } };
  const result = await detectRoleRuntime(f.root, boundary);
  assert.equal(result.agents[0]!.source, join(packageRoot, "agents/triage-reviewer.md"));
  assert.equal(calls.length, 2);
});

test("no omp on PATH fails closed before spawning", async t => {
  const f = fixture(); t.after(f.dispose);
  const previous = process.env; process.env = { ...process.env, PATH: f.root };
  t.after(() => { process.env = previous; });
  await assert.rejects(detectRoleRuntime(f.root, { async run() { throw Error("must not spawn"); } }), /no executable omp on PATH/);
});

for (const failure of ["module", "agent", "exit", "missing-result", "invalid-result", "aborted"] as const) {
  test(`job process boundary fails closed on ${failure}`, async t => {
    const f = fixture(); t.after(f.dispose);
    const previous = process.env; process.env = { ...process.env, PATH: f.bin };
    t.after(() => { process.env = previous; });
    const boundary: RoleProcessBoundary = { async run(_binary, args) {
      if (args[0] === "--version") return { code: 0, stdout: "omp/fixture", stderr: "" };
      if (failure === "module") return { code: 1, stdout: "", stderr: "Required OMP host module @oh-my-pi/pi-coding-agent/task/executor is unavailable" };
      if (failure === "agent") return { code: 1, stdout: "", stderr: "Registered OMP agent task is required" };
      if (failure === "exit") return { code: 143, stdout: "", stderr: "terminated" };
      if (failure === "invalid-result") writeFileSync(join(f.job.directory, "native-result.json"), "not JSON");
      if (failure === "aborted") writeFileSync(join(f.job.directory, "native-result.json"), JSON.stringify({ exitCode: 1, aborted: true, error: "BLOCKED", output: "" }));
      return { code: 0, stdout: "", stderr: "" };
    } };
    await assert.rejects(executeNativeJob(f.job, "assignment", boundary), failure === "module" ? /task\/executor/ : failure === "agent" ? /agent task/ : failure === "exit" ? /exited 143/ : failure === "aborted" ? /Native role execution failed: BLOCKED/ : /without a valid native-result.json/);
  });
}

test("native verification accepts both historical and binary runtime evidence unchanged", async t => {
  const f = fixture(); t.after(f.dispose);
  const previous = process.env; process.env = { ...process.env, PATH: f.bin };
  t.after(() => { process.env = previous; });
  const assignment = `Authorized Dagu role job ${f.job.id}. Exact binding: fixture`;
  const execution = await roleExecution(f.job, assignment);
  for (const runtime of [{ root: "/old-runtime", version: "old", executorDigest: "old" }, { binary: "/omp", version: "omp/new", digest: "new" }]) {
    const boundary: RoleProcessBoundary = { async run(_binary, args) {
      if (args[0] !== "--version") {
        writeFileSync(join(f.job.directory, "native-result.json"), JSON.stringify({ exitCode: 0, output: JSON.stringify(execution.output) }));
        writeFileSync(join(f.job.directory, "routing.json"), JSON.stringify({ runtime }));
      }
      return { code: 0, stdout: "omp/fixture", stderr: "" };
    } };
    const result = await executeNativeJob(f.job, assignment, boundary);
    const path = join(f.job.directory, "result.json");
    writeFileSync(path, JSON.stringify({ ...f.job, ...result, state: "completed", finishedAt: "now", readyToStartMs: 0 }));
    assert.deepEqual(verifyJobResult(path).native!.routing, { runtime });
  }
});

function hostModules(names = ["task"]): Record<string, unknown> {
  return {
    "task/discovery": { async discoverAgents() { return { agents: names.map(name => ({ name, source: "bundled", model: ["@task"], systemPrompt: "shared" })) }; } },
    "task/executor": { async runSubprocess() { throw Error("detect must not execute a role"); } },
    "task/settings": { cfgTaskAgentModelOverrides: { get() { return {}; } } },
    "config/settings": { Settings: { async loadReadOnly() { return {}; } } },
    "config/model-resolver": { resolveAgentModelSelection() { return { patterns: ["provider/a", "provider/b"], role: "slow" }; } },
  };
}
function runnerInput(f: { root: string; job: Job }, mode = "detect") {
  writeFileSync(join(f.job.directory, "runner-input.json"), JSON.stringify({ mode, cwd: f.root,
    runtime: { binary: "/omp", version: "omp/fixture", digest: "hash" }, agentFile: join(packageRoot, "agents/triage-reviewer.md"),
    job: f.job, assignment: "authorized", outputSchema: { type: "object" } }));
}
test("detect loads every required host module and uses pinned triage plus discovered task", async t => {
  const f = fixture(); t.after(f.dispose); runnerInput(f);
  const modules = hostModules(), loaded: string[] = [];
  await runRoleRunner(f.job.directory, async id => { const name = id.split("pi-coding-agent/")[1]!; loaded.push(name); return modules[name]; });
  assert.deepEqual(loaded, HOST_MODULES);
  assert.deepEqual(JSON.parse(readFileSync(join(f.job.directory, "detect.json"), "utf8")), { root: "/omp", agents: [
    { name: "triage-reviewer", source: join(packageRoot, "agents/triage-reviewer.md") }, { name: "task", source: "bundled" },
  ] });
});
for (const mode of ["detect", "run"]) {
  for (const missing of HOST_MODULES) test(`${mode} names missing host module ${missing}`, async t => {
    const f = fixture(); t.after(f.dispose); runnerInput(f, mode);
    const modules = hostModules();
    const loader: HostLoader = async id => { const name = id.split("pi-coding-agent/")[1]!; if (name === missing) throw Error("missing export surface"); return modules[name]; };
    await assert.rejects(runRoleRunner(f.job.directory, loader), error => String(error).includes(`@oh-my-pi/pi-coding-agent/${missing}`));
  });
  test(`${mode} names an incompatible discovery signature`, async t => {
    const f = fixture(); t.after(f.dispose); runnerInput(f, mode);
    const modules = hostModules();
    modules["task/discovery"] = { discoverAgents() { throw new TypeError("legacy signature requires options"); } };
    await assert.rejects(runRoleRunner(f.job.directory, async id => modules[id.split("pi-coding-agent/")[1]!]),
      /Required OMP host module @oh-my-pi\/pi-coding-agent\/task\/discovery could not discover agents:.*legacy signature.*compatible omp on PATH/);
  });
  test(`${mode} fails closed for missing shared task and missing pinned triage`, async t => {
    const f = fixture(); t.after(f.dispose); runnerInput(f, mode);
    let modules = hostModules([]);
    const loader: HostLoader = async id => modules[id.split("pi-coding-agent/")[1]!];
    await assert.rejects(runRoleRunner(f.job.directory, loader), /agent task is required/);
    modules = hostModules();
    const input = JSON.parse(readFileSync(join(f.job.directory, "runner-input.json"), "utf8"));
    writeFileSync(join(f.job.directory, "runner-input.json"), JSON.stringify({ ...input, agentFile: join(f.root, "missing-agent.md") }));
    await assert.rejects(runRoleRunner(f.job.directory, loader), /Pinned OMP agent triage-reviewer is required/);
  });
}
for (const role of ["triage", "implement"] as const) test(`runner preserves complete ${role} routing and strict native executor options`, async t => {
  const f = fixture(); t.after(f.dispose);
  f.job.binding.role = role; runnerInput(f, "run");
  const modules = hostModules();
  const name = role === "triage" ? "triage-reviewer" : "task";
  const settings = { fixture: "read-only settings" }, overrides = ["@override", "provider/fallback"];
  modules["config/settings"] = { Settings: { async loadReadOnly(options: { cwd: string }) {
    assert.deepEqual(options, { cwd: f.root }); return settings;
  } } };
  modules["task/settings"] = { cfgTaskAgentModelOverrides: { get(value: unknown) {
    assert.equal(value, settings); return { [name]: overrides };
  } } };
  modules["config/model-resolver"] = { resolveAgentModelSelection(options: Record<string, unknown>) {
    assert.equal(options.settings, settings);
    assert.equal(options.settingsOverride, overrides);
    assert.deepEqual(options.agentModel, role === "triage" ? "@slow" : ["@task"]);
    return { patterns: ["provider/a", "provider/b"], role: "slow" };
  } };
  modules["task/executor"] = { async runSubprocess(options: Record<string, unknown>) {
    assert.deepEqual(options.modelOverride, ["provider/a", "provider/b"]);
    assert.equal(options.modelRole, "slow");
    assert.equal(options.settings, settings);
    assert.ok(options.agent && typeof options.agent === "object" && "name" in options.agent);
    assert.equal(options.agent.name, name);
    assert.equal(options.task, "authorized");
    assert.equal(options.artifactsDir, f.job.directory);
    assert.deepEqual([options.structured, options.outputSchemaMode, options.outputSchemaSource, options.outputSchemaOverridesAgent], [true, "strict", "caller", true]);
    assert.deepEqual([options.keepAlive, options.enableIrc, options.enableMCP], [false, false, false]);
    return { exitCode: 0, output: "{}" };
  } };
  await runRoleRunner(f.job.directory, async id => modules[id.split("pi-coding-agent/")[1]!]);
  const routing = JSON.parse(readFileSync(join(f.job.directory, "routing.json"), "utf8"));
  assert.deepEqual(routing.runtime, { binary: "/omp", version: "omp/fixture", digest: "hash" });
  assert.equal(routing.agent.name, name);
  assert.deepEqual(routing.overrides, overrides);
  if (role === "triage") {
    assert.equal(routing.agent.model, "@slow");
    assert.match(routing.agent.digest, /^[a-f0-9]{64}$/);
  } else {
    assert.equal(routing.agent.source, "bundled");
    assert.deepEqual(routing.agent.model, ["@task"]);
  }
});
