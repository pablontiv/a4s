import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { nextShard, readCompleted, readManifest, readSample, workerAlive, type StallNotice } from "../src/long-computation.ts";
import { runRoleJob } from "../src/role-dispatch.ts";
import type { JobBinding } from "../src/role-jobs.ts";
import { roleExecution } from "./role-job-fixtures.ts";

const cli = fileURLToPath(new URL("../bin/dagu-role-jobs.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

export interface ScenarioEvidence {
  commands: string[];
  notice: StallNotice;
  shardOutput: string;
  resumeIndex: number;
}

/** Two-shard synthetic computation: interrupt after shard 1, resume at shard 2, one stall notice. */
export async function proveLongComputation(root: string): Promise<ScenarioEvidence> {
  const home = join(root, "dagu-home");
  const repo = join(root, "repo");
  const run = "feature-560";
  const evidence = join(root, "evidence");
  const directory = join(evidence, "computations", "embed");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const env = { ...process.env, DAGU_HOME: home, A4S_ROLE_JOB_CAPACITY: "2" };
  const commands: string[] = [];
  const pids: number[] = [];
  const runCli = (args: string[]): string => {
    commands.push(["dagu-role-jobs", ...args].join(" "));
    const result = spawnSync(process.execPath, ["--import", tsx, cli, ...args], { encoding: "utf8", env });
    if (result.status !== 0) {
      const logPath = join(directory, "worker.log");
      let log = "";
      try { log = readFileSync(logPath, "utf8"); } catch { /* Worker had not opened its log. */ }
      throw new Error(`${args.join(" ")}\n${result.stdout}\n${result.stderr}\n${log}`);
    }
    return result.stdout;
  };
  const waitFor = async (label: string, predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(20);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  try {
    runCli(["computation", "sample", "--dir", directory, "--units", "1", "--elapsed-ms", "200", "--projected-units", "2", "--shard-units", "1"]);
    const sample = readSample(directory);
    if (sample.throughputPerSecond !== 5 || sample.projectedDurationMs !== 400 || sample.measuredShardMs !== 200) {
      throw new Error(`sample was not recorded from the representative run: ${JSON.stringify(sample)}`);
    }
    runCli(["computation", "open", "--dir", directory, "--id", "embed", "--run", run, "--session", "owner-session",
      "--total-units", "2", "--shard-units", "1", "--stall-multiple", "8"]);
    runCli(["computation", "run", "--dir", directory, "--delay-ms", "1000", "--background"]);
    await waitFor("shard 1", () => {
      try { return readCompleted(directory).some(shard => shard.index === 1); } catch { return false; }
    });
    const worker = JSON.parse(readFileSync(join(directory, "worker.json"), "utf8")) as { pid: number };
    pids.push(worker.pid);
    process.kill(worker.pid, "SIGTERM");
    await waitFor("worker exit", () => !workerAlive(directory));
    const preserved = readFileSync(join(directory, "shards", "1.json"), "utf8");
    const manifest = readManifest(directory);
    const resumeAt = nextShard(manifest, readCompleted(directory, manifest))?.index;
    if (resumeAt !== 2) throw new Error(`resume point was ${String(resumeAt)}`);
    runCli(["computation", "run", "--dir", directory, "--delay-ms", "20", "--stall-shard", "2", "--background"]);
    await waitFor("resume at shard 2", () => {
      try { return JSON.parse(readFileSync(join(directory, "resume.json"), "utf8")).index === 2; } catch { return false; }
    });
    const resumed = JSON.parse(readFileSync(join(directory, "worker.json"), "utf8")) as { pid: number };
    pids.push(resumed.pid);
    if (readFileSync(join(directory, "shards", "1.json"), "utf8") !== preserved) throw new Error("shard 1 output changed before the stall");
    const notices: StallNotice[] = [];
    const binding: JobBinding = {
      repo, worktree: repo, lane: "feature", dag: "feature", run, stage: "implement", role: "implement",
      sha: "b".repeat(40), iteration: 0, attempt: "0:ready",
    };
    await runRoleJob({
      home, capacity: 2, binding, directory: join(root, "role-result"), readyAt: "2026-10-25T00:00:00.000Z",
      assignment: "long computation", evidenceDir: evidence, session: "owner-session", computationPollMs: 20,
      notifyStall: notice => { notices.push(notice); }, authorize: async () => {},
      execute: async (job, assignment) => {
        await waitFor("stall notice", () => notices.length === 1);
        runCli(["computation", "decide", "--dir", directory, "--decision", "stop"]);
        await waitFor("stopped computation", () => {
          try { return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).state === "stopped"; } catch { return false; }
        });
        return roleExecution(job, assignment);
      },
    });
    if (notices.length !== 1) throw new Error(`expected one stall notice, found ${notices.length}`);
    const notice = notices[0]!;
    if (notice.session !== "owner-session" || notice.progress.completed !== 1 || notice.progress.total !== 2 || notice.progress.lastShard?.index !== 1) {
      throw new Error(`stall notice lost the last progress: ${JSON.stringify(notice)}`);
    }
    const lines = readFileSync(join(evidence, "stall-notices.jsonl"), "utf8").trim().split("\n");
    if (lines.length !== 1) throw new Error(`expected one owner notice line, found ${lines.length}`);
    if (readFileSync(join(directory, "shards", "1.json"), "utf8") !== preserved) throw new Error("shard 1 output was not preserved");
    try { readFileSync(join(directory, "shards", "2.json")); throw new Error("incomplete shard 2 was checkpointed"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { commands, notice, shardOutput: preserved, resumeIndex: 2 };
  } finally {
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* The worker already exited. */ }
    }
  }
}
