import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { liveDagu } from "../fixtures/live-dagu.ts";
import { testRunId } from "../fixtures/run-id.ts";
import { exampleConfig, serializeConfig } from "../../src/config.ts";
import { deriveQueue } from "../../src/queue.ts";
const installer = fileURLToPath(new URL("../../bin/dagu-station-install.ts", import.meta.url));
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
async function exit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const [code] = await once(child, "exit");
  return code;
}
async function until(probe: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for isolated Dagu");
    await delay(100);
  }
}

test("drain preserves existing runs; TERM restart stub activates capacity 8 on next enqueue", { ...liveDagu, timeout: 150_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "dagu-restart-drain-"));
  const port = await freePort();
  // Preserve a private listener across reconciliation of the station's port defaults.
  const env = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false", DAGU_PORT: String(port) };
  const id = testRunId("drain");
  const release = join(home, "release-old");
  const closed = join(home, "closed");
  const opened = join(home, "opened");
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  type Row = { dagRunId: string; status: string; startedAt?: string };
  const rows = (): Row[] => JSON.parse(dagu("history", "--format", "json", "--limit", "1000"));
  let service: ChildProcess | undefined;
  let applying: ChildProcess | undefined;
  let logs = "";
  let restarts = 0;
  const start = () => {
    service = spawn("dagu", ["start-all"], { env, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout!.on("data", value => { logs += value; });
    service.stderr!.on("data", value => { logs += value; });
  };
  const ready = async () => until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok; } catch { return false; }
  });
  const restart = createHttpServer((_req, response) => {
    void (async () => {
      assert.ok(existsSync(closed));
      assert.equal(rows().filter(row => ["running", "queued"].includes(row.status)).length, 0);
      assert.equal(rows().filter(row => row.dagRunId.startsWith(id) && row.status === "succeeded").length, 2);
      assert.match(readFileSync(join(home, "config.yaml"), "utf8"), /max_concurrency: 8/);
      restarts++;
      service!.kill("SIGTERM");
      await exit(service!);
      start();
      await ready();
      response.end("TERM replacement ready\n");
    })().catch(error => { response.writeHead(500); response.end(String(error)); });
  });
  try {
    mkdirSync(join(home, "dags"));
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\nqueues:\n  enabled: true\n  config:\n    - name: a4s\n      max_concurrency: 1\n`);
    writeFileSync(join(home, "dags", `${id}.yaml`), `queue: a4s\nmax_active_runs: 10\nsteps:\n  - run: while [ ! -f '${release}' ]; do sleep 0.2; done\n`);
    start();
    await ready();
    dagu("enqueue", "--run-id", `${id}-first`, id);
    dagu("enqueue", "--run-id", `${id}-second`, id);
    await until(() => rows().some(row => row.dagRunId === `${id}-first` && row.status === "running"));
    const originalStartedAt = rows().find(row => row.dagRunId === `${id}-first`)!.startedAt;
    assert.ok(rows().some(row => row.dagRunId === `${id}-second` && row.status === "queued"));
    const repoDag = join(home, "repo.yaml");
    writeFileSync(repoDag, serializeConfig(exampleConfig({ lane: "a4s", queueConcurrency: 8 })));
    // Derivation changes disk while the old scheduler still runs at capacity one.
    writeFileSync(join(home, "config.yaml"), deriveQueue(readFileSync(join(home, "config.yaml"), "utf8"), { name: "a4s", max_concurrency: 8 }).content);
    const listening = once(restart, "listening");
    restart.listen(0, "127.0.0.1");
    await listening;
    const address = restart.address();
    assert.ok(address && typeof address !== "string");
    const args = [installer, "--dagu-home", home, "--apply", "--repo-dag", repoDag, "--admission-close", `touch '${closed}'`, "--admission-open", `touch '${opened}'`, "--restart-command", `test "$DAGU_RESTART_SIGNAL" = TERM; curl --fail --silent --max-time 60 http://127.0.0.1:${address.port}/restart`, "--timeout-seconds", "60"];
    applying = spawn(process.execPath, [...args.slice(0, -1), "1"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let timeoutOutput = "";
    applying.stderr!.on("data", value => { timeoutOutput += value; });
    applying.stdout!.resume();
    assert.equal(await exit(applying), 1);
    assert.match(timeoutOutput, /Timed out: station drained/);
    assert.match(timeoutOutput, /Admission remains closed/);
    assert.equal(restarts, 0);
    assert.equal(rows().find(row => row.dagRunId === `${id}-first`)!.status, "running");
    // Simulate operator recovery: admission stays closed while a new apply retries.
    rmSync(join(home, ".station-install.lock"), { recursive: true });
    applying = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    applying.stdout!.on("data", value => { output += value; });
    applying.stderr!.on("data", value => { output += value; });
    await until(() => existsSync(closed));
    await delay(500);
    assert.equal(restarts, 0);
    assert.equal(existsSync(opened), false);
    assert.equal(rows().find(row => row.dagRunId === `${id}-first`)!.startedAt, originalStartedAt);
    writeFileSync(release, "release\n");
    assert.equal(await exit(applying), 0, `${output}\n${logs}`);
    assert.equal(restarts, 1);
    assert.ok(existsSync(opened));
    assert.match(output, /verified next enqueue queue=a4s max_concurrency=8 succeeded=9/);
    assert.equal(rows().find(row => row.dagRunId === `${id}-first`)!.startedAt, originalStartedAt);
    assert.equal(rows().find(row => row.dagRunId === `${id}-first`)!.status, "succeeded");
    assert.doesNotMatch(logs, /signal: killed/);
  } finally {
    writeFileSync(release, "release\n");
    if (applying && applying.exitCode === null) { applying.kill("SIGTERM"); await exit(applying); }
    if (service) { service.kill("SIGTERM"); await exit(service); }
    const stopped = once(restart, "close");
    restart.close();
    await stopped;
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed admission closure retains recovery state and keeps restart/open behind the drain", liveDagu, () => {
  const home = mkdtempSync(join(tmpdir(), "dagu-restart-closed-"));
  const repoDag = join(home, "repo.yaml");
  writeFileSync(repoDag, serializeConfig(exampleConfig({ lane: "a4s", queueConcurrency: 8 })));
  writeFileSync(join(home, "config.yaml"), "queues:\n  enabled: true\n  config:\n    - name: a4s\n      max_concurrency: 8\n");
  try {
    const result = execFileSync(process.execPath, [installer, "--dagu-home", home, "--apply", "--repo-dag", repoDag, "--admission-close", "exit 17", "--admission-open", "echo reopened", "--restart-command", "echo restarted"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.fail(`expected admission closure failure: ${result}`);
  } catch (error) {
    assert.ok(error && typeof error === "object" && "stderr" in error && "stdout" in error);
    assert.match(String(error.stderr), /Admission remains closed/);
    assert.equal(String(error.stdout).includes("restarted"), false);
    assert.equal(String(error.stdout).includes("reopened"), false);
    assert.ok(existsSync(join(home, ".station-install.lock")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
