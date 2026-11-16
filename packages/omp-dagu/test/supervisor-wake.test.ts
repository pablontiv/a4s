import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import extension from "../src/status/index.ts";

const dagu = process.env.DAGU_BIN;
const execute = promisify(execFile);
type Hook = (event: unknown, ctx: unknown) => void | Promise<void>;

async function until(check: () => Promise<boolean>, evidence: () => string) {
  // These real Dagu subprocesses and SSE sockets cannot advance on a fake test clock.
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, evidence());
    await setTimeout(50);
  }
}

test("isolated Dagu 2.26 station wakes the supervisor without a coordinator", { skip: !dagu, timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-supervisor-wake-")), repo = join(root, "repo"), bin = join(root, "bin");
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const probe = createServer();
  const listening = once(probe, "listening");
  probe.listen(0, "127.0.0.1");
  await listening;
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const closed = once(probe, "close");
  probe.close();
  await closed;
  const base = `http://127.0.0.1:${address.port}`;
  mkdirSync(join(repo, ".workspace", "config"), { recursive: true });
  writeFileSync(join(repo, ".workspace", "config", "dagu.json"), JSON.stringify({ daguUrl: base }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
  const env = { ...environment, DAGU_HOME: join(root, "dagu"), DAGU_SKIP_EXAMPLES: "true", DAGU_AUTH_MODE: "none", DAGU_COORDINATOR_ENABLED: "false", DAGU_SCHEDULER_PORT: "0" };
  const server = spawn(dagu!, ["start-all", "--host", "127.0.0.1", "--port", String(address.port)], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let evidence = "";
  server.stdout.on("data", value => { evidence += value; });
  server.stderr.on("data", value => { evidence += value; });
  const exit = once(server, "exit");
  const hooks = new Map<string, Hook>(), messages: string[] = [];
  let renders = 0, sse = false;
  const originalFetch = globalThis.fetch;
  const ctx = {
    cwd: repo, hasUI: true, agent: { kind: "main" }, sessionManager: { getSessionId: () => "supervisor-session" },
    ui: { setWidget() { renders++; }, notify() {} },
  };
  extension({
    registerTool() {}, registerFlag() {}, getFlag: () => "supervisor", getActiveTools: () => [], async setActiveTools() {},
    on(event: string, handler: Hook) { hooks.set(event, handler); },
    sendMessage(message: { content: string; display: boolean }, options: { deliverAs: string }) {
      assert.equal(message.display, false); assert.equal(options.deliverAs, "aside"); messages.push(message.content);
    },
  } as never);
  try {
    await until(async () => {
      assert.equal(server.exitCode, null, evidence);
      return fetch(`${base}/api/v1/dags`, { signal: AbortSignal.timeout(1_000) }).then(response => response.ok, () => false);
    }, () => evidence);
    for (const [name, step, session] of [["role", "escalation", "supervisor-session"], ["feature", "decide", "supervisor-session"], ["poc", "decide", "supervisor-session"], ["unrelated", "escalation", "other-session"]]) {
      const path = join(root, `${name}.yaml`);
      writeFileSync(path, `name: ${name}\nshell: bash\nlabels: {workspace: repo, dagu-feature-bundle: 0.2.0}\nparams: {ISSUE: '920', OMP_SESSION_ID: '${session}'}\nsteps:\n  - id: ${step}\n    action: human.task\n    with: {prompt: 'Supervisor attention required'}\n`);
      await execute(dagu!, ["start", "--run-id", `${name}-waiting`, path], { env, timeout: 20_000, maxBuffer: 2_000_000 });
    }
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).includes("/events/stream?")) sse = true;
      return originalFetch(input, init);
    }) as typeof fetch;
    await hooks.get("session_start")!({}, ctx);
    await until(async () => messages.length >= 3 && sse && renders > 1, () => `${JSON.stringify(messages)}\n${evidence}`);
    assert.equal(messages.length, 3, JSON.stringify(messages));
    for (const name of ["role", "feature", "poc"]) assert.equal(messages.filter(message => message.includes(`dag=${name} `)).length, 1);
    assert.ok(messages.every(message => !message.includes("unrelated")));
  } finally {
    await hooks.get("session_shutdown")!({}, ctx);
    globalThis.fetch = originalFetch;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (server.exitCode === null && server.signalCode === null) process.kill(-server.pid!, "SIGTERM");
    await exit;
    rmSync(root, { recursive: true, force: true });
  }
});
