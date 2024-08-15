import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import extension from "../src/status/index.ts";

for (const failure of ["discover timeout", "details timeout", "headers timeout", "ECONNREFUSED", "ECONNRESET", "HTTP 503"]) {
  test(`widget retains known runs on ${failure} and recovers`, { timeout: 12_000 }, async () => {
    const original = globalThis.fetch;
    let stage = 0;
    let latest: string[] = [];
    const frames: string[][] = [];
    const run = { name: "feature", dagRunId: "known-run", statusLabel: "queued", labels: ["workspace=a4s"] };
    const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
    const ctx = {
      cwd: process.cwd(), hasUI: true, isIdle: () => true, agent: { kind: "sub" as const },
      abort() {},
      sessionManager: { getSessionId: () => "owner" },
      ui: {
        theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
        setWidget(_key: string, lines: string[] | undefined) { latest = lines ?? []; frames.push(latest); }, notify() {},
      },
    };
    globalThis.fetch = (async (input, options) => {
      const path = new URL(String(input)).pathname;
      const signal = options?.signal;
      const fail = async () => {
        if (failure.endsWith("timeout")) {
          // Exercise the fetch deadline's actual abort reason without waiting five seconds.
          const deadline = AbortSignal.timeout(20);
          await new Promise<void>((_resolve, reject) => deadline.addEventListener("abort", () => reject(deadline.reason), { once: true }));
        } else if (failure === "HTTP 503") return new Response("unavailable", { status: 503 });
        else throw new TypeError("fetch failed", { cause: Object.assign(new Error(failure), { code: failure }) });
        throw new Error("deadline must reject");
      };
      if (path === "/api/v1/dag-runs") {
        if (stage === 1 && !failure.startsWith("details") && !failure.startsWith("headers")) { stage = 2; return await fail(); }
        return Response.json({ dagRuns: [run] });
      }
      if (path.startsWith("/api/v1/dag-runs/")) {
        if (stage === 1 && failure.startsWith("details")) { stage = 2; return await fail(); }
        return Response.json({ dagRunDetails: run });
      }
      if (stage === 0) { stage = 1; throw new DOMException("headers expired", "TimeoutError"); }
      if (stage === 1 && failure.startsWith("headers")) { stage = 2; return await fail(); }
      return new Response(new ReadableStream({ start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    extension({ registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; }, sendMessage() {} });
    const until = async (probe: () => boolean) => {
      const end = Date.now() + 10_000;
      while (!probe()) { assert.ok(Date.now() < end, JSON.stringify(frames)); await delay(10); }
    };
    try {
      handlers.session_start!(null, ctx);
      await until(() => stage === 2 && latest.some(line => line.includes("reintentando en 2s")));
      const slow = failure.endsWith("timeout");
      assert.ok(latest.some(line => line.includes(slow ? "dagu · lento" : "sin conexión")), latest.join("\n"));
      if (slow) assert.ok(latest.some(line => line.includes("known-run")), latest.join("\n"));
      await until(() => latest.some(line => line.includes("known-run")) && latest.every(line => !line.includes("reintentando")));
    } finally {
      handlers.session_shutdown!(null, ctx);
      globalThis.fetch = original;
    }
  });
}
