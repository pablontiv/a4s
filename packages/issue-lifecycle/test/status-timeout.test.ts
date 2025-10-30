import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import extension from "../src/status/index.ts";
import { resolveRepository } from "../src/status/repository.ts";
import { statusRepository } from "./fixtures/status-repository.ts";
import { WidgetHost } from "./fixtures/widget-host.ts";

// Capture real timers before Node's MockTimers replaces setTimeout.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

for (const stage of ["discovery", "details", "headers"] as const) {
  for (const latency of [8_000, 15_001]) {
    test(`${stage}: ${latency} ms response ${latency < 15_000 ? "succeeds" : "is aborted"}`, async t => {
      const cwd = statusRepository;
      const workspace = await resolveRepository(cwd, new AbortController().signal);
      assert.ok(workspace, `fixture repository identity could not be resolved for cwd=${cwd}`);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      // Native AbortSignal.timeout uses internal timers, so route it through the fake clock.
      t.mock.method(AbortSignal, "timeout", (ms: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
        return controller.signal;
      });
      const { promise: requested, resolve: requestStarted } = Promise.withResolvers<void>();
      let delivered = false;
      let aborted = false;
      const { promise: streamOpened, resolve: streamStarted } = Promise.withResolvers<void>();
      const warnings = t.mock.method(console, "warn");
      let discoveries = 0;
      const widgets: string[][] = [];
      const widgetHost = new WidgetHost(lines => { if (lines) widgets.push(lines); });
      const requests: string[] = [];
      const run = { name: "feature", dagRunId: "slow-run", statusLabel: "running", labels: [`workspace=${workspace}`], nodes: [] };
      t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit) => {
        const path = new URL(input).pathname;
        requests.push(String(input));
        if (path.endsWith("/spec")) return Response.json({ spec: "env: []\n" });
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
            if (init.signal!.aborted) onAbort();
          });
        }
        if (kind === "discovery") return Response.json({ dagRuns: [run] });
        if (kind === "details") return Response.json({ dagRunDetails: run });
        return new Response(new ReadableStream({
          start(controller) {
            init.signal!.addEventListener("abort", () => controller.close(), { once: true });
          },
          pull() { streamStarted(); },
        }, { highWaterMark: 0 }));
      });
      const handlers: Record<string, (event: unknown, ctx: never) => void> = {};
      extension({ registerTool() {}, registerCommand() {}, sendMessage() {}, on(event, handler) { handlers[event] = handler; } });
      const ctx = {
        // Only exercise the widget: main-agent receipt observation is outside this test.
        cwd, hasUI: true, agent: { kind: "sub" }, isIdle: () => true,
        abort() {},
        sessionManager: { getSessionId: () => "timeout-test" },
        ui: {
          theme: { fg: (_: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
          setWidget: widgetHost.setWidget, notify() {},
        },
      };
      const waitFor = async (event: Promise<void>, expected: string) => {
        const { promise: readinessExpired, reject: rejectReadiness } = Promise.withResolvers<never>();
        const readinessTimer = realSetTimeout(() => rejectReadiness(new Error(
          `Observer readiness timed out after 10000 ms: phase=${stage}, expected=${expected}, workspace=${workspace}; observed requests=${JSON.stringify(requests)}`,
        )), 10_000);
        try {
          await Promise.race([event, readinessExpired]);
        } finally {
          realClearTimeout(readinessTimer);
        }
      };
      try {
        handlers.session_start!(undefined, ctx as never);
        const expectedRequest = stage === "discovery" ? "/api/v1/dag-runs"
          : stage === "details" ? "/api/v1/dag-runs/feature/slow-run" : "/api/v1/events/stream";
        await waitFor(requested, expectedRequest);
        t.mock.timers.tick(latency < 15_000 ? latency : 15_000);
        if (latency < 15_000) {
          // Zero buffering resolves only when the observer reads, after clearing the headers deadline.
          await waitFor(streamOpened, "SSE reader opened");
          assert.equal(delivered, true);
          assert.equal(aborted, false);
          assert.ok(widgets.some(lines => lines.join("\n").includes("slow-run")));
          // Header deadlines are cleared once connected; the round still refreshes at 30 seconds.
          t.mock.timers.tick(15_001);
          await nextTurn();
          assert.equal(discoveries, 1);
          assert.equal(aborted, false);
        } else {
          assert.equal(aborted, true);
          assert.equal(delivered, false);
        }
      } finally {
        handlers.session_shutdown!(undefined, ctx as never);
        await nextTurn();
      }
      assert.equal(warnings.mock.callCount(), 0, "widget timeout tests must not attempt receipt observation");
    });
  }
}
