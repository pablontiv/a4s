import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import extension from "../src/status/index.ts";

for (const stage of ["discovery", "details", "headers"] as const) {
  for (const latency of [8_000, 15_001]) {
    test(`${stage}: ${latency} ms response ${latency < 15_000 ? "succeeds" : "is aborted"}`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      // Native AbortSignal.timeout uses internal timers, so route it through the fake clock.
      t.mock.method(AbortSignal, "timeout", (ms: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
        return controller.signal;
      });
      let requestStarted!: () => void;
      const requested = new Promise<void>(resolve => { requestStarted = resolve; });
      let delivered = false;
      let aborted = false;
      let streamOpened = false;
      let discoveries = 0;
      const widgets: string[][] = [];
      const run = { name: "feature", dagRunId: "slow-run", statusLabel: "running", labels: ["workspace=a4s"], nodes: [] };
      t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
        const path = new URL(input).pathname;
        const kind = path.endsWith("/dag-runs") ? "discovery" : path.includes("/dag-runs/") ? "details" : "headers";
        if (kind === "discovery") discoveries++;
        if (kind === stage) {
          requestStarted();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              aborted = true;
              clearTimeout(timer);
              reject(init.signal!.reason);
            };
            const timer = setTimeout(() => {
              init.signal!.removeEventListener("abort", onAbort);
              delivered = true;
              resolve();
            }, latency);
            init.signal!.addEventListener("abort", onAbort, { once: true });
          });
        }
        if (kind === "discovery") return Response.json({ dagRuns: [run] });
        if (kind === "details") return Response.json({ dagRunDetails: run });
        streamOpened = true;
        return new Response(new ReadableStream({
          start(controller) {
            init.signal!.addEventListener("abort", () => controller.close(), { once: true });
          },
        }));
      });
      const handlers: Record<string, (event: unknown, ctx: never) => void> = {};
      extension({ registerTool() {}, registerCommand() {}, sendMessage() {}, on(event, handler) { handlers[event] = handler; } });
      const ctx = {
        cwd: process.cwd(), hasUI: true, agent: { kind: "sub" }, isIdle: () => true,
        sessionManager: { getSessionId: () => "timeout-test" },
        ui: {
          theme: { fg: (_: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
          setWidget: (_: string, lines: string[] | undefined) => { if (lines) widgets.push(lines); }, notify() {},
        },
      };
      const settle = async (predicate: () => boolean) => {
        for (let i = 0; i < 200 && !predicate(); i++) await nextTurn();
        assert.ok(predicate(), "observer reached expected phase");
      };
      try {
        handlers.session_start!(undefined, ctx as never);
        await requested;
        t.mock.timers.tick(latency < 15_000 ? latency : 15_000);
        if (latency < 15_000) {
          await settle(() => streamOpened);
          assert.equal(delivered, true);
          assert.equal(aborted, false);
          assert.ok(widgets.some(lines => lines.join("\n").includes("slow-run")));
          // Header deadlines are cleared once connected; the round still refreshes at 30 seconds.
          t.mock.timers.tick(15_001);
          await nextTurn();
          assert.equal(discoveries, 1);
          assert.equal(aborted, false);
        } else {
          await settle(() => aborted);
          assert.equal(delivered, false);
        }
      } finally {
        handlers.session_shutdown!(undefined, ctx as never);
        await nextTurn();
      }
    });
  }
}
