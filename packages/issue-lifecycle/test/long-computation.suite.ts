import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import {
  appendStallNotice, LONG_COMPUTATION_CONTRACT, nextShard, openComputation, readCompleted, readManifest, recordSample,
  runShards, superviseComputation, writeDecision,
} from "../src/long-computation.ts";
import { roleAssignment } from "../src/role-dispatch.ts";
import { readStallNotices } from "../src/status/repository.ts";
import { Transitions } from "../src/status/progress.ts";
import type { JobBinding } from "../src/role-jobs.ts";
import { proveLongComputation } from "./long-computation-scenario.ts";

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

test("a stall produces one owner notice and a stop or resize keeps completed shards", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-stall-")));
  try {
    for (const decision of ["stop", "resize"] as const) {
      const directory = join(root, "computations", decision);
      recordSample(directory, { units: 1, elapsedMs: 50, projectedUnits: 2, shardUnits: 1 });
      openComputation(directory, { id: decision, run: "feature-560", session: "owner", totalUnits: 2, shardUnits: 1, stallMultiple: 2 });
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
      assert.equal(readFileSync(join(root, "stall-notices.jsonl"), "utf8").trim().split("\n").length, decision === "stop" ? 1 : 2);
      assert.equal(readFileSync(join(directory, "shards", "1.json"), "utf8"), preserved);
      assert.equal(readCompleted(directory).length, 1);
      if (decision === "stop") assert.equal(result, "stopped");
      else {
        assert.equal(readManifest(directory).stallMultiple, 9);
        assert.notEqual(result, "stopped");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the role-job executor resumes at shard 2 and reports one stall to the owner", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-computation-scenario-")));
  try {
    const evidence = await proveLongComputation(root);
    assert.equal(evidence.resumeIndex, 2);
    assert.match(evidence.shardOutput, /"index": 1/);
    assert.equal(evidence.notice.progress.lastShard?.index, 1);
    assert.ok(evidence.commands.some(command => command.includes("computation sample")));
    assert.ok(evidence.commands.some(command => command.includes("computation open")));
    assert.ok(evidence.commands.some(command => command.includes("computation run") && command.includes("--background")));
    assert.ok(evidence.commands.some(command => command.includes("--decision stop")));
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
