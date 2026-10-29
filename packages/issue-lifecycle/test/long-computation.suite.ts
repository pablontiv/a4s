import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import {
  appendStallNotice, computationCommand, LONG_COMPUTATION_CONTRACT, nextShard, openComputation, readCompleted, readManifest, recordSample,
  runShards, superviseComputation, superviseRunComputations, writeDecision,
} from "../src/long-computation.ts";
import { roleAssignment } from "../src/role-dispatch.ts";
import { readStallNotices } from "../src/status/repository.ts";
import { Transitions } from "../src/status/progress.ts";
import type { JobBinding } from "../src/role-jobs.ts";

const phrases = [
  "bounded representative sample",
  "measured throughput",
  "projected duration",
  "durable shard checkpoints",
  "index, range and completion time",
  "last completed shard",
  "configured multiple of the measured shard time",
  "owning OMP session",
  "continue, resize, or stop",
  "Completed shards stay preserved.",
];

function workerFixture(t: TestContext, directory: string) {
  const worker = { alive: true, onProbe: undefined as (() => void) | undefined };
  const started = "Thu Oct 29 05:49:57 2026";
  const probe = t.mock.method(childProcess, "execFileSync", (command: string) => {
    assert.equal(command, "ps");
    worker.onProbe?.();
    if (!worker.alive) throw new Error("No such process");
    return `${started}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => { probe.mock.restore(); syncBuiltinESMExports(); });
  const register = (target: string) => writeFileSync(join(target, "worker.json"), JSON.stringify({ schemaVersion: 1, pid: process.pid, processStartedAt: `ps-c:${started}` }));
  register(directory);
  return Object.assign(worker, { die: () => { worker.alive = false; }, register });
}

test("sample, resume and stall math preserve completed shard output", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-computation-")));
  const directory = join(root, "computations", "embed");
  try {
    const sample = recordSample(directory, { units: 10, elapsedMs: 1000, projectedUnits: 100, shardUnits: 50 });
    assert.equal(sample.throughputPerSecond, 10);
    assert.equal(sample.projectedDurationMs, 10_000);
    assert.equal(sample.measuredShardMs, 5_000);
    openComputation(directory, { id: "embed", run: "feature-560", session: "owner", totalUnits: 100, shardUnits: 50, stallMultiple: 3 });
    const signal = new AbortController();
    const seen: number[] = [];
    const interrupted = await runShards(directory, async shard => {
      seen.push(shard.index);
      if (shard.index === 2) signal.abort();
      return `shard ${shard.index} output\n`;
    }, signal.signal);
    assert.equal(interrupted, "interrupted");
    assert.deepEqual(seen, [1, 2]);
    const manifest = readManifest(directory);
    assert.equal(nextShard(manifest, readCompleted(directory, manifest))?.index, 2);
    const preserved = readFileSync(join(directory, "shards", "1.json"), "utf8");
    assert.match(preserved, /shard 1 output/);
    const resumed = await runShards(directory, async () => "shard 2 output\n", new AbortController().signal);
    assert.equal(resumed, "completed");
    assert.equal(readFileSync(join(directory, "shards", "1.json"), "utf8"), preserved);
    assert.equal(readCompleted(directory).map(shard => shard.index).join(","), "1,2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live worker stall produces one owner notice and stop, resize or continue keeps completed shards", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-stall-")));
  try {
    let expectedNotices = 0;
    t.mock.method(process, "kill", () => true);
    const worker = workerFixture(t, root);
    for (const decision of ["stop", "resize", "continue"] as const) {
      const directory = join(root, "computations", decision);
      recordSample(directory, { units: 1, elapsedMs: 50, projectedUnits: 2, shardUnits: 1 });
      openComputation(directory, { id: decision, run: "feature-560", session: "owner", totalUnits: 2, shardUnits: 1, stallMultiple: 2 });
      worker.register(directory);
      const signal = new AbortController();
      await runShards(directory, async shard => {
        if (shard.index === 2) signal.abort();
        return `shard ${shard.index} output\n`;
      }, signal.signal);
      const preserved = readFileSync(join(directory, "shards", "1.json"), "utf8");
      const notices: Array<{ progress: { completed: number; total: number; lastShard?: { index: number } }; deadlineMs: number }> = [];
      let extra = 0;
      let phase: "jump" | "decide" | "finish" = "jump";
      const controller = new AbortController();
      const result = await superviseComputation(directory, {
        signal: controller.signal, pollMs: 1, now: () => Date.now() + extra,
        notify: notice => { notices.push(notice); },
        sleep: async () => {
          if (phase === "jump") { extra += 10_000; phase = "decide"; }
          else if (phase === "decide") {
            writeDecision(directory, decision === "resize" ? { decision, stallMultiple: 9 } : { decision });
            phase = "finish";
          } else controller.abort();
        },
      });
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.progress.completed, 1);
      assert.equal(notices[0]!.progress.total, 2);
      assert.equal(notices[0]!.progress.lastShard?.index, 1);
      assert.equal(notices[0]!.deadlineMs, 100);
      expectedNotices += 1;
      assert.equal(readFileSync(join(root, "stall-notices.jsonl"), "utf8").trim().split("\n").length, expectedNotices);
      assert.equal(readFileSync(join(directory, "shards", "1.json"), "utf8"), preserved);
      assert.equal(readCompleted(directory).length, 1);
      if (decision === "stop") assert.equal(result, "stopped");
      else {
        assert.equal(readManifest(directory).stallMultiple, decision === "resize" ? 9 : 2);
        assert.notEqual(result, "stopped");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a nonzero shard command records failure and supervise returns before the stall deadline", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-shard-failure-")));
  const directory = join(root, "computations", "failed");
  try {
    recordSample(directory, { units: 1, elapsedMs: 60_000, projectedUnits: 2, shardUnits: 1 });
    const manifest = openComputation(directory, { id: "failed", run: "feature-775", session: "owner", totalUnits: 2, shardUnits: 1, stallMultiple: 8 });
    const worker = workerFixture(t, directory);
    const spawn = t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
      assert.equal(command, "bash");
      assert.deepEqual(args, ["-lc", "printf 'diagnostic' >&2; exit 7"]);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => { child.stderr.write("diagnostic"); child.emit("close", 7, null); });
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
    const started = Date.now();
    let sleeps = 0;
    const supervised = superviseComputation(directory, {
      notify: () => assert.fail("a failed shard is not a stall"),
      sleep: async () => {
        assert.equal(sleeps++, 0);
        await assert.rejects(computationCommand(["run", "--dir", directory, "--command", "printf 'diagnostic' >&2; exit 7"]), /Shard 1 command exited 7: diagnostic/);
        worker.die();
      },
    });
    const result = await supervised;
    assert.equal(typeof result, "object");
    if (typeof result !== "object" || result.state !== "failed") assert.fail("expected failed result");
    assert.equal(result.shard, 1);
    assert.equal(result.exitCode, 7);
    assert.equal(result.log, "command-1.log");
    assert.match(result.error, /diagnostic/);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")), result);
    assert.equal(readFileSync(join(directory, result.log), "utf8"), "diagnostic");
    assert.ok(Date.now() - started < manifest.measuredShardMs * manifest.stallMultiple / 10);
    assert.equal(existsSync(join(directory, "stall.json")), false);
    assert.equal(existsSync(join(root, "stall-notices.jsonl")), false);
    assert.equal(readCompleted(directory).length, 0);
    const output: string[] = [];
    t.mock.method(console, "log", (line: string) => { output.push(line); });
    await computationCommand(["supervise", "--dir", directory]);
    assert.deepEqual(JSON.parse(output[0]!), result);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a vanished worker returns dead even beyond the stall deadline and without a terminal record", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-dead-worker-")));
  const directory = join(root, "computations", "dead");
  try {
    recordSample(directory, { units: 1, elapsedMs: 50, projectedUnits: 2, shardUnits: 1 });
    const manifest = openComputation(directory, { id: "dead", run: "feature-775", session: "owner", totalUnits: 2, shardUnits: 1, stallMultiple: 2 });
    const worker = workerFixture(t, directory);
    let now = Date.parse(manifest.openedAt);
    const result = await superviseComputation(directory, {
      now: () => now,
      notify: () => assert.fail("a dead worker is not a stall"),
      sleep: async () => { worker.die(); now += 10_000; },
    });
    assert.deepEqual(result, { state: "dead", log: "worker.log" });
    assert.equal(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).state, "running");
    assert.equal(existsSync(join(directory, "stall.json")), false);
    assert.equal(existsSync(join(root, "stall-notices.jsonl")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker exit races preserve a terminal record or final checkpoint", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-worker-exit-")));
  try {
    const worker = workerFixture(t, root);
    for (const terminal of ["completed", "stopped", "checkpoint"] as const) {
      const directory = join(root, "computations", terminal);
      recordSample(directory, { units: 1, elapsedMs: 50, projectedUnits: 1, shardUnits: 1 });
      openComputation(directory, { id: terminal, run: "feature-775", session: "owner", totalUnits: 1, shardUnits: 1, stallMultiple: 2 });
      worker.register(directory);
      worker.onProbe = () => {
        if (terminal === "checkpoint") {
          mkdirSync(join(directory, "shards"), { recursive: true });
          writeFileSync(join(directory, "shards", "1.json"), JSON.stringify({
            schemaVersion: 1, index: 1, range: { start: 0, end: 1 }, completedAt: new Date().toISOString(), output: "done",
          }));
        } else writeFileSync(join(directory, "state.json"), JSON.stringify({ schemaVersion: 1, state: terminal }));
        worker.die();
      };
      assert.equal(await superviseComputation(directory, { sleep: async () => assert.fail("terminal worker must return promptly") }), terminal === "stopped" ? "stopped" : "completed");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the run watchdog waits for worker registration before supervising an opened plan", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-worker-registration-")));
  const directory = join(root, "computations", "pending");
  try {
    recordSample(directory, { units: 1, elapsedMs: 50, projectedUnits: 1, shardUnits: 1 });
    openComputation(directory, { id: "pending", run: "feature-775", session: "owner", totalUnits: 1, shardUnits: 1, stallMultiple: 2 });
    const controller = new AbortController();
    let sleeps = 0;
    let notices = 0;
    await superviseRunComputations({
      evidenceDir: root, session: "owner", signal: controller.signal, now: () => Date.now() + 10_000,
      notify: () => { notices += 1; controller.abort(); },
      sleep: async () => {
        if (sleeps++ === 0) workerFixture(t, directory);
        else if (!notices) { controller.abort(); assert.fail("registered worker was never supervised"); }
      },
    });
    assert.equal(notices, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("implement and run_poc assignments and the skill state the long-computation contract", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "a4s-assignment-")));
  const binding: JobBinding = { repo, worktree: repo, lane: "feature", dag: "feature", run: "feature-560", stage: "implement", role: "implement", sha: "c".repeat(40), iteration: 0, attempt: "1" };
  try {
  const implement = roleAssignment(binding, "560", "Acceptance", "/state");
  const triage = roleAssignment({ ...binding, role: "triage", stage: "triage" }, "560", "Acceptance", "/state");
  const skill = readFileSync(new URL("../skills/issue-execution/SKILL.md", import.meta.url), "utf8");
  const poc = parse(readFileSync(new URL("../skills/issue-execution/poc.yaml", import.meta.url), "utf8")) as { steps: Array<{ id: string; with?: { prompt?: string } }> };
  const prompt = poc.steps.find(step => step.id === "run_poc")?.with?.prompt ?? "";
  for (const phrase of phrases) {
    assert.ok(implement.includes(phrase), phrase);
    assert.ok(prompt.includes(phrase), phrase);
    assert.ok(skill.includes(phrase), phrase);
  }
  assert.equal(implement.includes(LONG_COMPUTATION_CONTRACT), true);
  assert.equal(triage.includes("Long computation contract"), false);
  assert.match(skill, /stall watchdog/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the status watcher reads one stall notice for the owning session", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-stall-notice-")));
  try {
    execFileSync("git", ["init", "-q", root]);
    const run = "feature-560";
    const evidence = join(root, ".git", "dagu-feature", "runs", run);
    const directory = join(evidence, "computations", "embed");
    mkdirSync(directory, { recursive: true });
    const notice = {
      schemaVersion: 1 as const, session: "owner", computation: "embed", directory,
      progress: { schemaVersion: 1 as const, completed: 1, total: 2, lastShard: { schemaVersion: 1 as const, index: 1, range: { start: 0, end: 1 }, completedAt: "2026-10-25T00:00:00.000Z", output: "shard 1\n" } },
      measuredShardMs: 200, stallMultiple: 8, deadlineMs: 1600, notifiedAt: "2026-10-25T00:00:02.000Z",
    };
    appendStallNotice(evidence, notice);
    appendStallNotice(evidence, notice);
    const notices = await readStallNotices(root, run, AbortSignal.timeout(5_000));
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.progress.lastShard?.index, 1);
    const runDetails = { name: "feature", dagRunId: run, statusLabel: "running", params: "ISSUE=560 OMP_SESSION_ID=owner", labels: [`dagu-feature-bundle=${BUNDLE_VERSION}`], nodes: [{ step: { name: "implement" }, statusLabel: "running" }] };
    const transitions = new Transitions("owner");
    const effects = transitions.observe(runDetails, { stalls: notices });
    assert.match(effects.wakeMessage ?? "", /\[DAGU STALL\]/);
    assert.match(effects.wakeMessage ?? "", /completed=1\/2/);
    assert.match(effects.wakeMessage ?? "", /lastShard=1/);
    assert.match(effects.wakeMessage ?? "", /options=continue; resize; stop/);
    assert.deepEqual(transitions.observe(runDetails, { stalls: notices }), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
