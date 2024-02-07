import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { detectRoleRuntime, executeNativeJob } from "../../src/role-runtime.ts";
import { jobId, type Job } from "../../src/role-jobs.ts";
import { roleRuntimeFixture } from "../fixtures/role-runtime.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-runner-live-")));
  const runtime = roleRuntimeFixture(root);
  const binding = { repo: root, worktree: root, lane: "feature", dag: "feature", run: "runner", stage: "implement", role: "implement" as const,
    sha: "a".repeat(40), iteration: 0, attempt: "0:fixture" };
  const job: Job = { schemaVersion: 1, id: jobId(binding), binding, directory: join(root, "job"), state: "running",
    executor: { host: "fixture", pid: 1, processStartedAt: "fixture" }, readyAt: "fixture", startedAt: "fixture" };
  mkdirSync(job.directory);
  return { root, runtime, job };
}
for (const mode of ["detect", "job"]) test(`fake omp ${mode} names a missing host module`, async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  rmSync(join(f.runtime, "src/task/executor.ts"));
  const previous = process.env; process.env = { ...process.env, PATH: join(f.root, "bin") };
  t.after(() => { process.env = previous; });
  await assert.rejects(mode === "detect" ? detectRoleRuntime(f.root) : executeNativeJob(f.job, "assignment"), /Required OMP host module @oh-my-pi\/pi-coding-agent\/task\/executor is unavailable/);
});
for (const failure of ["nonzero", "no-result"]) test(`fake omp ${failure} fails closed`, async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  writeFileSync(join(f.root, "bin/omp"), `#!/bin/sh\nif [ "$1" = --version ]; then echo omp/fixture; exit 0; fi\necho fixture-diagnostic >&2\nexit ${failure === "nonzero" ? 23 : 0}\n`);
  const previous = process.env; process.env = { ...process.env, PATH: join(f.root, "bin") };
  t.after(() => { process.env = previous; });
  await assert.rejects(executeNativeJob(f.job, "assignment"), failure === "nonzero" ? /exited 23: fixture-diagnostic/ : /without a valid native-result.json/);
});

test("parent cancellation terminates the omp child while its awaited factory is running", { timeout: 20_000 }, async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const started = join(f.root, "started"), stopped = join(f.root, "stopped");
  writeFileSync(join(f.runtime, "src/task/executor.ts"), `import {writeFileSync} from 'node:fs';
export async function runSubprocess(){
process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(stopped)},'terminated');process.exit(143)});
writeFileSync(${JSON.stringify(started)},String(process.pid));
setInterval(()=>{},1000); return await new Promise(()=>{});
}`);
  const module = new URL("../../src/role-runtime.ts", import.meta.url).href;
  const source = `import {executeNativeJob} from ${JSON.stringify(module)};try{await executeNativeJob(${JSON.stringify(f.job)},'assignment')}catch(error){console.error(error.message);process.exit(1)}`;
  const parent = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source], {
    env: { ...process.env, PATH: join(f.root, "bin") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; parent.stderr.on("data", chunk => { stderr += chunk; });
  const closed = once(parent, "close");
  t.after(() => { if (parent.exitCode === null) parent.kill("SIGKILL"); });
  // This OS signal regression must wait for the real child to register its handler.
  const deadline = Date.now() + 10_000;
  while (!existsSync(started) && Date.now() < deadline && parent.exitCode === null) await delay(25);
  assert.ok(existsSync(started), stderr);
  parent.kill("SIGTERM");
  const [code] = await closed;
  assert.equal(code, 1, stderr);
  assert.equal(readFileSync(stopped, "utf8"), "terminated");
  assert.match(stderr, /OMP role runner exited 143/);
  const pid = Number(readFileSync(started, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
