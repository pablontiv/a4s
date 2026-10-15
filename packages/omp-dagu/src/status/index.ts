import { setTimeout as delay } from "node:timers/promises";
import { activityTarget, readActivity } from "./activity.ts";
import { ghIssueTitleResolver, IssueTitles } from "./issue-title.ts";
import { isActive, issueNumber, renderRun, topicFor, Transitions } from "./progress.ts";
import type { RunDetails } from "./progress.ts";
import { resolveRepository } from "./repository.ts";
import { SSEParser } from "./sse.ts";
import type { SSEEvent } from "./sse.ts";

// OMP's structural surface avoids a runtime dependency on a provider-specific host.
interface Context {
  cwd: string;
  hasUI: boolean;
  agent: { kind: "main" | "sub" };
  sessionManager: { getSessionId(): string; getSessionDir?(): string };
  ui: {
    setWidget(key: string, lines: string[] | undefined, options?: { placement: "aboveEditor" }): void;
    notify(message: string, type: "info" | "warning" | "error"): void;
  };
}
interface SessionIdTool {
  name: string;
  label: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, never>; additionalProperties: false };
  loadMode: "essential";
  execute(
    toolCallId: string,
    params: Record<string, never>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Context,
  ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, never> }>;
}
interface ExtensionAPI {
  on(event: "session_start" | "session_switch" | "session_shutdown", handler: (event: unknown, ctx: Context) => void): void;
  registerTool(tool: SessionIdTool): void;
  sendUserMessage(message: string, options: { deliverAs: "aside"; attribution: "agent" }): void;
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

async function runDetails(base: string, summary: RunDetails, signal: AbortSignal): Promise<RunDetails> {
  const dag = encodeURIComponent(summary.name);
  const run = encodeURIComponent(summary.dagRunId);
  const response = await fetch(`${base}/api/v1/dag-runs/${dag}/${run}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { dagRunDetails?: RunDetails };
  return { ...summary, ...payload.dagRunDetails };
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

async function observe(ctx: Context, signal: AbortSignal, wake: (message: string) => void): Promise<void> {
  const repo = await resolveRepository(ctx.cwd, signal);
  if (!repo || signal.aborted) return;
  const base = (process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
  const runs = new Map<string, RunDetails>();
  const transitions = new Transitions(ctx.agent.kind === "main" ? ctx.sessionManager.getSessionId() : undefined);
  const titles = new IssueTitles(ghIssueTitleResolver(ctx.cwd));
  const activities = new Map<string, string>();
  const activityWatches = new Map<string, { key: string; controller: AbortController }>();
  let sessionDir: string | undefined;
  try { sessionDir = ctx.sessionManager.getSessionDir?.(); } catch {}
  let initialSweep = true;
  const render = (): void => {
    if (!ctx.hasUI) return;
    const lines = [...runs.values()].slice(0, 10).map(run => {
      const issue = issueNumber(run);
      return renderRun(run, issue ? titles.get(issue) : undefined, activities.get(topicFor(run)));
    });
    ctx.ui.setWidget("dagu-status", lines.length ? lines : undefined, { placement: "aboveEditor" });
  };
  const stopActivity = (topic: string): void => {
    activityWatches.get(topic)?.controller.abort();
    activityWatches.delete(topic);
    activities.delete(topic);
  };
  const syncActivity = (run: RunDetails): void => {
    const topic = topicFor(run);
    const target = activityTarget(run);
    if (!ctx.hasUI) return;
    if (!target) {
      stopActivity(topic);
      return;
    }
    if (activityWatches.get(topic)?.key === target.key) return;
    stopActivity(topic);
    const controller = new AbortController();
    activityWatches.set(topic, { key: target.key, controller });
    const activitySignal = AbortSignal.any([signal, controller.signal]);
    void (async () => {
      while (!activitySignal.aborted) {
        const value = await readActivity(base, run, target, sessionDir ? { sessionDir } : {}, activitySignal);
        if (activitySignal.aborted || activityWatches.get(topic)?.key !== target.key) return;
        if (value) activities.set(topic, value);
        else activities.delete(topic);
        render();
        await delay(2000, undefined, { signal: activitySignal }).catch(() => {});
      }
    })().catch(() => {});
  };
  const apply = (run: RunDetails, baseline = false): void => {
    const issue = issueNumber(run);
    const slug = issue ? titles.get(issue) : undefined;
    const effects = transitions.observe(run, slug ? { baseline, slug } : { baseline });
    if (effects.notification && ctx.hasUI) {
      ctx.ui.notify(effects.notification.message, effects.notification.type);
    }
    if (effects.wakeMessage) wake(effects.wakeMessage);
    const key = topicFor(run);
    if (isActive(run)) {
      runs.set(key, run);
      syncActivity(run);
    } else {
      runs.delete(key);
      stopActivity(key);
    }
  };
  let backoff = 1000;
  while (!signal.aborted) {
    const round = new AbortController();
    const roundSignal = AbortSignal.any([signal, round.signal]);
    let refresh = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const discovered = await discover(base, repo, roundSignal);
      const snapshots = await Promise.all(discovered.map(async summary => {
        try {
          return await runDetails(base, summary, roundSignal);
        } catch {
          const previous = runs.get(topicFor(summary));
          return { ...previous, ...summary, ...(previous?.nodes ? { nodes: previous.nodes } : {}) };
        }
      }));
      const snapshotTopics = new Set<string>();
      for (const run of snapshots) snapshotTopics.add(topicFor(run));
      for (const topic of runs.keys()) {
        if (!snapshotTopics.has(topic)) {
          runs.delete(topic);
          stopActivity(topic);
        }
      }
      const unresolvedIssues = new Set<string>();
      for (const run of snapshots) {
        apply(run, initialSweep);
        const issue = issueNumber(run);
        if (issue && !titles.has(issue)) unresolvedIssues.add(issue);
      }
      initialSweep = false;
      render();
      for (const issue of unresolvedIssues) {
        void titles.load(issue, signal).then(success => {
          if (success && !signal.aborted) render();
        });
      }
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
        apply(run);
        if (!isActive(run)) {
          refresh = true;
          round.abort();
        }
        render();
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
        if (ctx.hasUI) {
          ctx.ui.setWidget("dagu-status", [`dagu · sin conexión · reintentando en ${backoff / 1000}s`],
            { placement: "aboveEditor" });
        }
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
  pi.registerTool({
    name: "dagu_session_id",
    label: "Dagu session ID",
    description: "Return the persistent OMP session ID to pass as OMP_SESSION_ID when enqueueing a Dagu run.",
    loadMode: "essential",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== "main") {
        throw new Error(`dagu_session_id rejected: agent.kind=${ctx.agent.kind}`);
      }
      return {
        content: [{ type: "text", text: ctx.sessionManager.getSessionId() }],
        details: {},
      };
    },
  });
  const stop = (): void => {
    controller?.abort();
    if (activeContext?.hasUI) activeContext.ui.setWidget("dagu-status", undefined);
    activeContext = undefined;
    controller = undefined;
  };
  const start = (_event: unknown, ctx: Context): void => {
    stop();
    if (!ctx.hasUI && ctx.agent.kind !== "main") return;
    activeContext = ctx;
    controller = new AbortController();
    // Every detached promise has an error boundary; shutdown aborts fetches and sleeps.
    void observe(ctx, controller.signal, message => {
      pi.sendUserMessage(message, { deliverAs: "aside", attribution: "agent" });
    }).catch(() => {});
  };
  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.on("session_shutdown", stop);
}
