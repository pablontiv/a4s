import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import extension from "../src/status/index.ts";

type Hook = (event: unknown, ctx: unknown) => void | Promise<void>;

function widget(cwd: string) {
  const hooks = new Map<string, Hook>();
  const rendered = new EventEmitter();
  const ready = once(rendered, "render");
  extension({
    registerTool() {}, registerFlag() {}, getFlag() {}, getActiveTools: () => [],
    async setActiveTools() {}, sendMessage() {},
    on(event: string, handler: Hook) { hooks.set(event, handler); },
  } as never);
  const ctx = {
    cwd, hasUI: true, agent: { kind: "main" },
    sessionManager: { getSessionId: () => "session-main" },
    ui: { setWidget() { rendered.emit("render"); }, notify() {} },
  };
  return {
    start: () => hooks.get("session_start")!({}, ctx),
    stop: () => hooks.get("session_shutdown")!({}, ctx),
    ready: () => ready,
  };
}

function configure(root: string, daguUrl: string) {
  mkdirSync(join(root, ".workspace", "config"), { recursive: true });
  writeFileSync(join(root, ".workspace", "config", "dagu.json"), JSON.stringify({ daguUrl }));
}

test("widget uses repository and linked-worktree config from nested session directories, ignoring DAGU_URL", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-status-config-"));
  const repo = join(root, "repo");
  const linked = join(root, "linked");
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ dagRuns: [] }));
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previousUrl = process.env.DAGU_URL;
  process.env.DAGU_URL = "http://127.0.0.1:1";
  try {
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "linked", linked]);
    for (const [path, station] of [[repo, "primary"], [linked, "worktree"]] as const) {
      configure(path, `http://127.0.0.1:${address.port}/${station}/`);
      const nested = join(path, "nested", "session");
      mkdirSync(nested, { recursive: true });
      const status = widget(nested);
      try {
        await status.start();
        await status.ready();
      } finally {
        await status.stop();
      }
    }
    assert.equal(requested.length, 2);
    assert.match(requested[0] ?? "", /^\/primary\/api\/v1\/dag-runs\?/);
    assert.match(requested[1] ?? "", /^\/worktree\/api\/v1\/dag-runs\?/);
  } finally {
    if (previousUrl === undefined) delete process.env.DAGU_URL;
    else process.env.DAGU_URL = previousUrl;
    await promisify(server.close.bind(server))();
    rmSync(root, { recursive: true, force: true });
  }
});

test("widget defaults to localhost and rejects malformed config with the file path", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "dagu-status-default-"));
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL | string) => {
    requested.push(String(url));
    return Response.json({ dagRuns: [] });
  });
  execFileSync("git", ["init", "-b", "main", root]);
  const status = widget(root);
  try {
    await status.start();
    await status.ready();
    assert.equal(requested.length, 1);
    assert.ok(requested[0]?.startsWith("http://127.0.0.1:8080/api/v1/dag-runs?"));
    await status.stop();
    configure(root, "unused");
    const file = join(root, ".workspace", "config", "dagu.json");
    writeFileSync(file, "{");
    await assert.rejects(async () => status.start(), error => error instanceof Error && error.message.includes(file));
    assert.equal(requested.length, 1);
  } finally {
    await status.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
