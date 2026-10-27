import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { REQUIRED_DAGU_VERSION } from "../../src/bundle.ts";
import { readAdminEvents, STALE_PROCESS_ERROR } from "../../src/stale-recovery.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { testRunId } from "../fixtures/run-id.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const closed = once(server, "close");
  server.close();
  await closed;
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

interface RunDetails {
  statusLabel: string;
  error?: string;
  nodes: Array<{ step: { name: string }; statusLabel: string; approvalIteration?: number }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

test("pinned Dagu preserves CLI/storage contracts, the SSE boundary and native stale-process text", {
  ...liveDagu, timeout: 180_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "a4s-dagu-runtime-"));
  const home = join(root, "home");
  const port = await freePort();
  const schedulerPort = await freePort();
  const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false", DAGU_PARAMS_JSON: "{}" };
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const run = testRunId("runtime-compat");
  const staleRun = testRunId("native-stale");
  const childPidFile = join(root, "step.pid");
  mkdirSync(join(home, "dags"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: ${schedulerPort}\n  zombie_detection_interval: 500ms\n  failure_threshold: 1\nproc:\n  heartbeat_interval: 100ms\n  stale_threshold: 1s\nevent_store:\n  enabled: true\n  retention_days: 1\n`);
  writeFileSync(join(home, "dags", "runtime-compat.yaml"), "type: graph\nparams:\n  - ISSUE: 623\nsteps:\n  - id: review\n    action: human.task\n    with:\n      prompt: Runtime contract probe\n");
  writeFileSync(join(home, "dags", "stale-compat.yaml"), `steps:\n  - id: work\n    run: echo $$ > '${childPidFile}'; exec sleep 300\n`);
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  service.stdout.on("data", chunk => { log += chunk; });
  service.stderr.on("data", chunk => { log += chunk; });
  let runner: ChildProcess | undefined;
  const base = `http://127.0.0.1:${port}/api/v1`;
  async function until(description: string, probe: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await delay(50);
    }
    throw new Error(`Timed out ${description}\n${log}`);
  }
  async function details(name: string, id: string): Promise<RunDetails | undefined> {
    const response = await fetch(`${base}/dag-runs/${name}/${id}`);
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    assert.ok(isObject(payload) && isObject(payload.dagRunDetails));
    const run = payload.dagRunDetails;
    assert.equal(typeof run.statusLabel, "string");
    assert.ok(typeof run.statusLabel === "string" && Array.isArray(run.nodes));
    assert.ok(run.error === undefined || typeof run.error === "string");
    const nodes = run.nodes.map((node: unknown) => {
      assert.ok(isObject(node) && isObject(node.step));
      assert.ok(typeof node.step.name === "string" && typeof node.statusLabel === "string");
      assert.ok(node.approvalIteration === undefined || typeof node.approvalIteration === "number");
      return { step: { name: node.step.name }, statusLabel: node.statusLabel,
        ...(node.approvalIteration === undefined ? {} : { approvalIteration: node.approvalIteration }) };
    });
    return { statusLabel: run.statusLabel, nodes, ...(run.error === undefined ? {} : { error: run.error }) };
  }
  try {
    assert.equal(dagu("version"), REQUIRED_DAGU_VERSION);
    await until("isolated start-all", async () => {
      try { return (await fetch(`${base}/dag-runs`)).ok; } catch { return false; }
    });
    const ids = Array.from({ length: 21 }, (_, index) => `${run}-${index}`);
    for (const id of ids) dagu("start", "--run-id", id, "runtime-compat");
    const first = ids[0]!;
    const waiting = await details("runtime-compat", first);
    assert.ok(waiting);
    assert.equal(waiting?.statusLabel, "waiting");
    assert.equal(waiting.nodes.find(node => node.step.name === "review")?.approvalIteration ?? 0, 0);
    const entries: unknown = JSON.parse(dagu("history", "runtime-compat", "--format", "json", "--from", "1970-01-01", "--status", "queued,running,waiting,not_started", "--limit", "1000"));
    assert.ok(Array.isArray(entries));
    const history = entries.map((entry: unknown) => {
      assert.ok(isObject(entry) && typeof entry.name === "string" && typeof entry.dagRunId === "string"
        && typeof entry.status === "string" && typeof entry.params === "string");
      return { name: entry.name, dagRunId: entry.dagRunId, status: entry.status, params: entry.params };
    });
    assert.equal(history.length, 21);
    const row = history.find(entry => entry.dagRunId === first)!;
    assert.equal(row.name, "runtime-compat");
    assert.equal(row.status, "waiting");
    assert.equal(typeof row.params, "string");
    assert.match(row.params, /ISSUE=623/);
    assert.match(dagu("status", "--run-id", first, "runtime-compat"), /^Waiting\b/);
    const stream = (count: number): URL => {
      const url = new URL(`${base}/events/stream`);
      for (const id of ids.slice(0, count)) url.searchParams.append("topic", `dagrun:runtime-compat/${id}`);
      return url;
    };
    const accepted = await fetch(stream(20), { signal: AbortSignal.timeout(10_000) });
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get("content-type") ?? "", /text\/event-stream/);
    await accepted.body?.cancel();
    const rejected = await fetch(stream(21), { signal: AbortSignal.timeout(10_000) });
    assert.equal(rejected.status, 503);
    assert.match(await rejected.text(), /unable to open SSE stream/);

    const store = join(home, "data", "dag-runs", "runtime-compat");
    const statusFiles = readdirSync(store, { recursive: true }).map(String).filter(path => path.endsWith("/status.jsonl"));
    assert.equal(statusFiles.length, 21);
    const records: unknown[] = readFileSync(join(store, statusFiles[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.length >= 1);
    const latest = records.at(-1)!;
    assert.ok(isObject(latest) && Array.isArray(latest.nodes));
    assert.equal(latest.status, 7);
    const review: unknown = latest.nodes.find((node: unknown) => isObject(node) && isObject(node.step) && node.step.name === "review");
    assert.ok(isObject(review));
    assert.equal(review.status, 7);

    runner = spawn("dagu", ["start", "--run-id", staleRun, "stale-compat"], { env, stdio: ["ignore", "pipe", "pipe"] });
    runner.stdout!.on("data", chunk => { log += chunk; });
    runner.stderr!.on("data", chunk => { log += chunk; });
    await until("native running process", async () => (await details("stale-compat", staleRun))?.statusLabel === "running" && existsSync(childPidFile));
    const exited = once(runner, "exit");
    runner.kill("SIGKILL");
    await exited;
    await until("native scheduler stale repair", async () => (await details("stale-compat", staleRun))?.statusLabel === "failed");
    const failed = await details("stale-compat", staleRun);
    assert.ok(failed);
    assert.equal(failed?.error, STALE_PROCESS_ERROR);
    assert.match(dagu("status", "--run-id", staleRun, "stale-compat"), /^Failed\b/);
    const eventsDirectory = join(home, "logs", "admin", "events");
    await until("durable native repair event", async () => readAdminEvents(eventsDirectory).some(event => event.dag_run_id === staleRun && event.type === "dag.run.failed"));
    const repair = readAdminEvents(eventsDirectory).find(event => event.dag_run_id === staleRun && event.type === "dag.run.failed")!;
    assert.equal(repair.source_service, "scheduler");
    assert.equal(repair.data?.dag_run_status?.error, STALE_PROCESS_ERROR);
    assert.equal(repair.data?.dag_run_status?.nodes?.find(node => node.step_name === "work")?.status, 2);
    assert.ok(readAdminEvents(eventsDirectory).some(event => event.dag_run_id === first && event.type === "dag.run.waiting" && event.data?.dag_run_status?.nodes?.some(node => node.step_name === "review" && node.status === 7)));
    t.diagnostic(JSON.stringify({ version: dagu("version"), home, port, sse: { topics20: 200, topics21: 503 }, history: row, storage: { statusFiles: statusFiles.length, records: records.length, lastStatus: latest.status }, stale: { error: failed.error, source: repair.source_service, attempt: repair.attempt_id }, initialApprovalIteration: waiting.nodes.find(node => node.step.name === "review")?.approvalIteration ?? 0 }));
  } finally {
    if (runner) await stop(runner);
    if (existsSync(childPidFile)) {
      const pid = Number(readFileSync(childPidFile, "utf8").trim());
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if (!isObject(error) || error.code !== "ESRCH") throw error;
      }
    }
    await stop(service);
    rmSync(root, { recursive: true, force: true });
    t.diagnostic("CLEANUP isolated start-all and native probe processes stopped; DAGU_HOME removed");
  }
});
