import { setTimeout as delay } from "node:timers/promises";
import { isActive, renderRun, topicFor, Transitions } from "./progress.ts";
import type { RunDetails } from "./progress.ts";
import { resolveRepository } from "./repository.ts";
import { SSEParser } from "./sse.ts";
import type { SSEEvent } from "./sse.ts";

// OMP's structural surface avoids a runtime dependency on a provider-specific host.
interface Context {
  cwd: string;
  hasUI: boolean;
  ui: {
    setWidget(key: string, lines: string[] | undefined, options?: { placement: "aboveEditor" }): void;
    notify(message: string, type: "info" | "warning" | "error"): void;
  };
}
interface ExtensionAPI {
  on(event: "session_start" | "session_switch" | "session_shutdown", handler: (event: unknown, ctx: Context) => void): void;
}

async function discover(base: string, repo: string, signal: AbortSignal): Promise<RunDetails[]> {
  const url = new URL(`${base}/api/v1/dag-runs`);
  for (const status of [1, 5, 7]) url.searchParams.append("status", String(status));
  url.searchParams.set("labels", `workspace=${repo}`);
  url.searchParams.set("fromDate", String(Math.floor(Date.now() / 1000) - 48 * 60 * 60));
  url.searchParams.set("limit", "100");
  const runs: RunDetails[] = [];
  do {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json() as { dagRuns: RunDetails[]; nextCursor?: string };
    runs.push(...page.dagRuns.filter(run => isActive(run) && run.labels?.includes(`workspace=${repo}`)));
    if (!page.nextCursor) break;
    url.searchParams.set("cursor", page.nextCursor);
  } while (!signal.aborted);
  return runs;
}

async function streamTopics(base: string, topics: string[], signal: AbortSignal, emit: (event: SSEEvent) => void) {
  const url = new URL(`${base}/api/v1/events/stream`);
  for (const topic of topics) url.searchParams.append("topic", topic);
  const headers = new AbortController();
  const headerTimer = setTimeout(() => headers.abort(), 5000);
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.any([signal, headers.signal]) }); }
  finally { clearTimeout(headerTimer); }
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const parser = new SSEParser(emit);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (signal.aborted) break;
      if (done) throw new Error("Stream SSE cerrado");
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function observe(ctx: Context, signal: AbortSignal): Promise<void> {
  const repo = await resolveRepository(ctx.cwd, signal);
  if (!repo || signal.aborted) return;
  const base = (process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
  const runs = new Map<string, RunDetails>();
  const transitions = new Transitions();
  let backoff = 1000;
  while (!signal.aborted) {
    const round = new AbortController();
    const roundSignal = AbortSignal.any([signal, round.signal]);
    let refresh = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const discovered = await discover(base, repo, roundSignal);
      // Retain previously active topics until their final snapshot arrives, even if
      // they finish between discovery and subscription (or during an outage).
      for (const run of discovered) {
        const key = topicFor(run);
        const previous = runs.get(key);
        if (!previous) transitions.observe(run);
        runs.set(key, { ...run, ...(previous?.nodes ? { nodes: previous.nodes } : {}) });
      }
      ctx.ui.setWidget("dagu-status", runs.size ? [...runs.values()].slice(0, 10).map(renderRun) : undefined,
        { placement: "aboveEditor" });
      if (!runs.size) {
        backoff = 1000;
        await delay(30_000, undefined, { signal });
        continue;
      }
      timer = setTimeout(() => { refresh = true; round.abort(); }, 30_000);
      const emit = (event: SSEEvent): void => {
        const data = JSON.parse(event.data);
        if (event.event === "control") {
          if (data.errors?.length || Object.keys(data.errors ?? {}).length) throw new Error("Suscripción SSE rechazada");
          return;
        }
        if (event.event !== "message") return;
        const details = data.payload?.dagRunDetails as RunDetails | undefined;
        if (!details || !runs.has(data.topic)) return;
        const run = { ...runs.get(data.topic)!, ...details };
        const notification = transitions.observe(run);
        if (notification) ctx.ui.notify(notification.message, notification.type);
        if (isActive(run)) runs.set(data.topic, run);
        else {
          runs.delete(data.topic);
          refresh = true;
          round.abort();
        }
        ctx.ui.setWidget("dagu-status", runs.size ? [...runs.values()].slice(0, 10).map(renderRun) : undefined,
          { placement: "aboveEditor" });
        backoff = 1000;
      };
      // Dagu 2.19.2 accepts at most 20 topics per SSE connection by default.
      const topics = [...runs.keys()];
      const streams: Promise<void>[] = [];
      for (let index = 0; index < topics.length; index += 20) {
        streams.push(streamTopics(base, topics.slice(index, index + 20), roundSignal, emit)
          .catch(error => { round.abort(); throw error; }));
      }
      const results = await Promise.allSettled(streams);
      if (results.some(result => result.status === "rejected")) throw new Error("Conexión SSE interrumpida");
    } catch {
      if (!signal.aborted && !refresh) {
        ctx.ui.setWidget("dagu-status", [`dagu · sin conexión · reintentando en ${backoff / 1000}s`],
          { placement: "aboveEditor" });
        await delay(backoff, undefined, { signal }).catch(() => {});
        backoff = Math.min(backoff * 2, 30_000);
      }
    } finally {
      clearTimeout(timer);
      round.abort();
    }
  }
}

export default function daguStatus(pi: ExtensionAPI): void {
  let controller: AbortController | undefined;
  let activeContext: Context | undefined;
  const stop = (): void => {
    controller?.abort();
    if (activeContext?.hasUI) activeContext.ui.setWidget("dagu-status", undefined);
    activeContext = undefined;
  };
  const start = (_event: unknown, ctx: Context): void => {
    stop();
    if (!ctx.hasUI) return;
    activeContext = ctx;
    controller = new AbortController();
    // Every detached promise has an error boundary; shutdown aborts fetches and sleeps.
    void observe(ctx, controller.signal).catch(() => {});
  };
  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.on("session_shutdown", stop);
}
