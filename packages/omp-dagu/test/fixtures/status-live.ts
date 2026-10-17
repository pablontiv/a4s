import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import extension from "../../src/status/index.ts";

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

export async function liveWatcher(binary = "dagu"): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-notices-"));
  const runId = `fast-push-back-${root.slice(root.lastIndexOf("-") + 1)}`;
  const home = join(root, "dagu");
  mkdirSync(join(home, "dags"), { recursive: true });
  const httpPort = await port();
  const schedulerPort = await port();
  const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
  const dagu = (...args: string[]) => execFileSync(binary, args, { env, encoding: "utf8" }).trim();
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${httpPort}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: ${schedulerPort}\nevent_store:\n  enabled: true\n  retention_days: 1\n`);
  writeFileSync(join(home, "dags", "feature.yaml"), `type: graph\nlabels: [workspace=a4s]\nparams:\n  - OMP_SESSION_ID: smoke-owner\nsteps:\n  - id: a\n    action: human.task\n    with:\n      prompt: Approve a\n  - id: b\n    depends: a\n    action: human.task\n    with:\n      prompt: Approve b\n  - id: c\n    depends: b\n    action: human.task\n    with:\n      prompt: Approve c\n      push_back:\n        rewind_to: a\n  - id: done\n    depends: c\n    run: echo done\n`);
  const service = spawn(binary, ["start-all", "--host", "127.0.0.1", "--port", String(httpPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  service.stdout.on("data", value => { log += value; });
  service.stderr.on("data", value => { log += value; });
  const base = `http://127.0.0.1:${httpPort}`;
  const previous = process.env.DAGU_URL;
  process.env.DAGU_URL = base;
  const received: string[] = [];
  const ctx = {
    cwd: process.cwd(), hasUI: false, isIdle: () => false, agent: { kind: "main" as const },
    abort() {},
    sessionManager: { getSessionId: () => "smoke-owner" }, ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
      setWidget() {}, notify() {},
    },
  };
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  extension({
    registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; },
    sendMessage(message, options) {
      assert.equal(message.display, false);
      assert.equal(options?.deliverAs, "aside");
      received.push(message.content!);
      console.log(message.content);
    },
  });
  async function until(description: string, probe: () => Promise<boolean>) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await delay(25);
    }
    throw new Error(`Timed out ${description}\n${log}`);
  }
  try {
    await until("server", async () => { try { return (await fetch(`${base}/api/v1/dag-runs`)).ok; } catch { return false; } });
    console.log(`LIVE dagu=${dagu("version")} DAGU_HOME=${home} port=${httpPort}`);
    handlers.session_start!(null, ctx);
    // Finish the startup baseline before enqueueing this run.
    await delay(1250);
    dagu("enqueue", "--run-id", runId, "feature");
    for (const iteration of [0, 1]) for (const step of ["a", "b", "c"]) {
      await until(`${step}/${iteration} waiting`, async () => {
        const response = await fetch(`${base}/api/v1/dag-runs/feature/${runId}`);
        if (!response.ok) return false;
        const { dagRunDetails: run } = await response.json() as { dagRunDetails: { nodes: Array<{ step: { name: string }; statusLabel: string; approvalIteration?: number }> } };
        return run.nodes.some(node => node.step.name === step && node.statusLabel === "waiting" && (node.approvalIteration ?? 0) === iteration);
      });
      if (iteration === 0 && step === "c") dagu("human-task", "push-back", "feature", "--run-id", runId, "--step", step, "--expected-iteration", "0");
      else dagu("human-task", "complete", "feature", "--run-id", runId, "--step", step);
    }
    await until("seven notices", async () => received.length >= 7);
    await delay(1250);
    assert.deepEqual(received.map(message => {
      const step = message.match(/step=(\S+)/)?.[1];
      return step ? `${step}:${message.match(/iteration=(\d+)/)?.[1]}` : "succeeded";
    }), ["a:0", "b:0", "c:0", "a:1", "b:1", "c:1", "succeeded"]);
    console.log("NOTICE_COUNTS waiting=6 succeeded=1 total=7 unique=7 owner=smoke-owner order=PASS");
    return received;
  } finally {
    handlers.session_shutdown!(null, ctx);
    if (previous === undefined) delete process.env.DAGU_URL; else process.env.DAGU_URL = previous;
    service.kill("SIGTERM");
    await new Promise<void>(resolve => { if (service.exitCode !== null) resolve(); else service.once("exit", () => resolve()); });
    rmSync(root, { recursive: true, force: true });
    console.log("CLEANUP isolated service stopped; DAGU_HOME removed");
  }
}
