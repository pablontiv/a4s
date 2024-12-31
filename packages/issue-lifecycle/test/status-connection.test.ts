import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import extension from "../src/status/index.ts";
import { statusRepository } from "./fixtures/status-repository.ts";
import { WidgetHost } from "./fixtures/widget-host.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancellationState, saveCancellation } from "../src/cancellation.ts";

for (const failure of ["discover timeout", "details timeout", "headers timeout", "ECONNREFUSED", "ECONNRESET", "HTTP 503"]) {
  test(`widget retains known runs on ${failure} and recovers`, { timeout: 12_000 }, async () => {
    const original = globalThis.fetch;
    let stage = 0;
    let latest: string[] = [];
    const frames: string[][] = [];
    const widgetHost = new WidgetHost(lines => { latest = lines ?? []; frames.push(latest); });
    const run = { name: "feature", dagRunId: "known-run", statusLabel: "queued", labels: ["workspace=a4s"] };
    const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
    const ctx = {
      cwd: statusRepository, hasUI: true, isIdle: () => true, agent: { kind: "sub" as const },
      abort() {},
      sessionManager: { getSessionId: () => "owner" },
      ui: {
        theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, tree: { branch: "├─", last: "└─" } },
        setWidget: widgetHost.setWidget, notify() {},
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

test("widget discovers dequeued cancellations even beside unsupported historical records", { timeout: 5_000 }, async () => {
  const original = globalThis.fetch, run = "cancelled-hidden", state = cancellationState(statusRepository, run), historical = cancellationState(statusRepository, "aaa-legacy");
  mkdirSync(historical, { recursive: true });
  writeFileSync(join(historical, "cancellation.json"), JSON.stringify({ outcome: "cancelled", checkpoint: "triage" }));
  saveCancellation(state, { schemaVersion: 1, run, dag: "feature", checkpoint: "queued", iteration: 0, requester: "owner", requestedAt: new Date().toISOString(), outcome: "cancelled", nativeExpected: "not_found", nativeObserved: "not_found", unexecutedEffects: [], retained: [{ location: "retained-candidate", owner: run, kind: "candidate" }] });
  writeFileSync(join(state, "receipt.json"), JSON.stringify({ initial: { execution: { primary: statusRepository, parameters: [`PRIMARY=${statusRepository}`, "OMP_SESSION_ID=owner"] } } }));
  let latest: string[] = [], details = 0;
  const host = new WidgetHost(lines => { latest = lines ?? []; });
  const handlers: Record<string, (event: unknown, context: typeof ctx) => void> = {};
  const ctx = {
    cwd: statusRepository, hasUI: true, isIdle: () => true, agent: { kind: "sub" as const }, abort() {},
    sessionManager: { getSessionId: () => "owner" },
    ui: { theme: { fg: (_: string, text: string) => text, bold: (text: string) => text, tree: { branch: "", last: "" } }, setWidget: host.setWidget, notify() {} },
  };
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/dag-runs") return Response.json({ dagRuns: [] });
    if (path.endsWith(`/feature/${run}`)) { details++; return Response.json({ code: "not_found" }, { status: 404 }); }
    throw new Error(`Unexpected status request ${path}`);
  }) as typeof fetch;
  extension({ registerTool() {}, registerCommand() {}, on(event, handler) { handlers[event] = handler; }, sendMessage() {} });
  try {
    handlers.session_start!(null, ctx);
    const deadline = Date.now() + 4_000;
    while (!latest.some(line => line.includes("cancelled/not_found"))) { assert.ok(Date.now() < deadline, latest.join("\n")); await delay(10); }
    assert.ok(details > 0, "verify native absence rather than manufacturing a native terminal state");
    assert.ok(latest.some(line => line.includes("retained-candidate")), latest.join("\n"));
    const card = host.component!.describe();
    assert.match(JSON.stringify(card.p?.head), /0 active/);
    assert.equal(card.p?.status, undefined, "retained cancellation is not pending or running work");
    assert.ok(latest.every(line => !line.includes("sin conexión")), latest.join("\n"));
  } finally {
    handlers.session_shutdown!(null, ctx); globalThis.fetch = original;
    rmSync(state, { recursive: true, force: true }); rmSync(historical, { recursive: true, force: true });
  }
});
