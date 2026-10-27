import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import extension from "../src/status/index.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;
type Widget = string[] | undefined;

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
  tree: { branch: "├─", last: "└─" },
};

const run = (issue: number) => ({
  name: "feature", dagRunId: `widget-issue-${issue}`, statusLabel: "waiting", params: `ISSUE=${issue}`,
  labels: ["workspace=widget", `dagu-feature-bundle=${BUNDLE_VERSION}`],
  nodes: [{ step: { name: "triage" }, statusLabel: "succeeded" }, { step: { name: "implement" }, statusLabel: "waiting" }],
});

// Minimal Dagu: discovery lists four runs, details echo them, SSE stays open silently.
async function fakeDagu(): Promise<{ base: string; close(): void }> {
  const runs = [1, 2, 3, 4].map(run);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/api/v1/dag-runs") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ dagRuns: runs }));
    } else if (url.pathname.startsWith("/api/v1/dag-runs/")) {
      const details = runs.find(r => url.pathname.endsWith(`/${r.dagRunId}`));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ dagRunDetails: details }));
    } else if (url.pathname === "/api/v1/events/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": open\n\n");
      request.on("close", () => response.end());
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

test("/workflows folds, hides and shows the widget while the observer keeps rendering", async () => {
  const dagu = await fakeDagu();
  const cwd = mkdtempSync(join(tmpdir(), "widget-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.com/acme/widget.git"]);
  process.env.DAGU_URL = dagu.base;
  const widgets: Widget[] = [];
  const notices: string[] = [];
  let command: Handler | undefined;
  let start: ((event: unknown, ctx: unknown) => void) | undefined;
  let stop: ((event: unknown, ctx: unknown) => void) | undefined;
  extension({
    registerTool() {},
    registerCommand(_name: string, options: { handler: Handler }) { command = options.handler; },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") start = handler;
      if (event === "session_shutdown") stop = handler;
    },
    sendMessage() {},
  } as never);
  const ctx = {
    cwd, hasUI: true, agent: { kind: "main" },
    sessionManager: { getSessionId: () => "session", getSessionDir: () => undefined },
    ui: { theme, setWidget: (_key: string, lines: Widget) => { widgets.push(lines); }, notify: (m: string) => { notices.push(m); } },
  };
  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await delay(50);
    assert.ok(predicate(), `widget never settled; last=${JSON.stringify(widgets.at(-1))}`);
  };
  try {
    start!(undefined, ctx);
    await settle(() => widgets.at(-1)?.[0] === "<b><accent>Workflows</accent></b>");
    assert.equal(widgets.at(-1)!.length, 5);
    assert.equal(widgets.at(-1)!.at(-1), " <dim>… 1 more — /workflows</dim>");

    await command!("", ctx);
    assert.equal(widgets.at(-1)!.length, 6);
    assert.equal(widgets.at(-1)!.at(-1), " <dim>… show less — /workflows</dim>");

    await command!("hide", ctx);
    assert.equal(widgets.at(-1), undefined);

    await command!("", ctx);
    assert.equal(widgets.at(-1)!.length, 6, "bare command after hide only shows, keeping the fold");

    await command!("collapse", ctx);
    assert.equal(widgets.at(-1)!.length, 5);

    await command!("bogus", ctx);
    assert.match(notices.at(-1)!, /^\/workflows: /);
    assert.equal(widgets.at(-1)!.length, 5);

    await command!("hide", ctx);
    const hiddenAt = widgets.length;
    await command!("show", ctx);
    assert.equal(widgets.length, hiddenAt + 1);
    assert.equal(widgets.at(-1)!.length, 5);
  } finally {
    stop!(undefined, ctx);
    dagu.close();
    delete process.env.DAGU_URL;
  }
});
