import { setTimeout as delay } from "node:timers/promises";
import { activityTarget, readActivity } from "./activity.ts";
import { ghIssueTitleResolver, IssueTitles } from "./issue-title.ts";
import { isActive, issueNumber, renderOffline, renderWidget, runParam, TOGGLE_COMMAND, topicFor, Transitions } from "./progress.ts";
import type { RunDetails, WidgetTheme } from "./progress.ts";
import { resolveRepository } from "./repository.ts";
import { SSEParser } from "./sse.ts";
import type { SSEEvent } from "./sse.ts";
import { EventLog } from "./event-log.ts";

// OMP's structural surface avoids a runtime dependency on a provider-specific host.
interface Context {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  agent: { kind: "main" | "sub" };
  sessionManager: { getSessionId(): string; getSessionDir?(): string };
  ui: {
    readonly theme: WidgetTheme;
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
interface CustomMessage {
  customType?: string;
  content?: string;
  display?: boolean;
  details?: unknown;
  attribution?: string;
}
interface ExtensionAPI {
  on(event: "session_start" | "session_switch" | "session_shutdown" | "agent_end", handler: (event: unknown, ctx: Context) => void): void;
  registerTool(tool: SessionIdTool): void;
  registerCommand(name: string, options: {
    description?: string;
    getArgumentCompletions?(prefix: string): { label: string; value: string }[] | null;
    handler: (args: string, ctx: Context) => Promise<void>;
  }): void;
  sendMessage(message: CustomMessage, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" }): void;
}

/** Widget view state shared by the observer and the `/workflows` command. */
interface WidgetView {
  expanded: boolean;
  hidden: boolean;
  render?: () => void;
}

async function discover(base: string, repo: string, signal: AbortSignal, history = false): Promise<RunDetails[]> {
  const url = new URL(`${base}/api/v1/dag-runs`);
  if (!history) for (const status of [1, 5, 7]) url.searchParams.append("status", String(status));
  url.searchParams.set("labels", `workspace=${repo}`);
  url.searchParams.set("fromDate", String(Math.floor(Date.now() / 1000) - 48 * 60 * 60));
  url.searchParams.set("limit", "100");
  const runs: RunDetails[] = [];
  do {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json() as { dagRuns: RunDetails[]; nextCursor?: string };
    runs.push(...page.dagRuns.filter(run => (history || isActive(run)) && run.labels?.includes(`workspace=${repo}`)));
    if (!page.nextCursor) break;
    url.searchParams.set("cursor", page.nextCursor);
  } while (!signal.aborted);
  return runs;
}

class RunDetailsError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

async function runDetails(base: string, summary: RunDetails, signal: AbortSignal): Promise<RunDetails> {
  const dag = encodeURIComponent(summary.name);
  const run = encodeURIComponent(summary.dagRunId);
  const response = await fetch(`${base}/api/v1/dag-runs/${dag}/${run}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new RunDetailsError(response.status);
  const payload = await response.json() as { dagRunDetails?: RunDetails };
  return { ...summary, ...payload.dagRunDetails };
}

async function streamTopics(base: string, topics: string[], signal: AbortSignal, emit: (event: SSEEvent) => void) {
  const url = new URL(`${base}/api/v1/events/stream`);
  for (const topic of topics) url.searchParams.append("topic", topic);
  const headers = new AbortController();
  const headerTimer = setTimeout(() => headers.abort(new DOMException("SSE headers timed out", "TimeoutError")), 5000);
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

async function watchNotices(base: string, repo: string, ctx: Context, signal: AbortSignal, wake: (message: string) => void): Promise<void> {
  const transitions = new Transitions(ctx.sessionManager.getSessionId());
  const ledger = new EventLog();
  const tracked = new Map<string, RunDetails>();
  const completed = new Set<string>();
  let baseline = true;
  while (!signal.aborted) {
    try {
      for (const summary of await discover(base, repo, signal, true)) {
        if (runParam(summary, "OMP_SESSION_ID") !== ctx.sessionManager.getSessionId()) continue;
        if (!completed.has(topicFor(summary))) tracked.set(topicFor(summary), summary);
      }
      for (const [topic, summary] of tracked) {
        // A failed request leaves the run tracked, including terminal runs whose
        // final event has not reached the eventually consistent ledger yet.
        try {
          const run = await runDetails(base, summary, signal);
          for (const snapshot of await ledger.read(base, run, signal)) {
            const effects = transitions.observe(snapshot, { baseline });
            for (const message of effects.wakeMessages ?? (effects.wakeMessage ? [effects.wakeMessage] : [])) wake(message);
            if (snapshot.statusLabel === "succeeded") {
              completed.add(topic);
              tracked.delete(topic);
            }
          }
        } catch { /* Retry this run on the next head sweep. */ }
      }
      baseline = false;
    } catch { /* Discovery and ingestion recover independently of SSE. */ }
    await delay(1000, undefined, { signal }).catch(() => {});
  }
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { name?: string; code?: string; cause?: unknown };
  return failure.name === "TimeoutError"
    || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(failure.code ?? "")
    || (failure.cause !== error && isTimeout(failure.cause));
}

async function observe(ctx: Context, signal: AbortSignal, wake: (message: string) => void, view: WidgetView): Promise<void> {
  const repo = await resolveRepository(ctx.cwd, signal);
  if (!repo || signal.aborted) return;
  const base = (process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
  if (ctx.agent.kind === "main") void watchNotices(base, repo, ctx, signal, wake).catch(() => {});
  const runs = new Map<string, RunDetails>();
  const transitions = new Transitions(ctx.agent.kind === "main" ? ctx.sessionManager.getSessionId() : undefined);
  const titles = new IssueTitles(ghIssueTitleResolver(ctx.cwd));
  const activities = new Map<string, string>();
  const activityWatches = new Map<string, { key: string; controller: AbortController }>();
  let sessionDir: string | undefined;
  try { sessionDir = ctx.sessionManager.getSessionDir?.(); } catch {}
  let initialSweep = true;
  let offlineRetrySeconds: number | undefined;
  let slow = false;
  const render = (): void => {
    if (!ctx.hasUI) return;
    if (view.hidden) {
      ctx.ui.setWidget("dagu-status", undefined);
      return;
    }
    const runLines = renderWidget([...runs.values()].map(run => {
      const issue = issueNumber(run);
      const slug = issue ? titles.get(issue) : undefined;
      const activity = activities.get(topicFor(run));
      return { run, ...(slug ? { slug } : {}), ...(activity ? { activity } : {}) };
    }), ctx.ui.theme, view.expanded);
    const lines = offlineRetrySeconds === undefined ? runLines
      : slow
        ? [ctx.ui.theme.fg("dim", `dagu · lento · reintentando en ${offlineRetrySeconds}s`), ...(runLines ?? [])]
        : renderOffline(ctx.ui.theme, offlineRetrySeconds);
    ctx.ui.setWidget("dagu-status", lines, { placement: "aboveEditor" });
  };
  view.render = render;
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
    const effects = transitions.observe(run, slug ? { baseline, slug, checkpoints: false } : { baseline, checkpoints: false });
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
      offlineRetrySeconds = undefined;
      const snapshots = await Promise.all(discovered.map(summary => runDetails(base, summary, roundSignal)));
      const snapshotTopics = new Set<string>();
      for (const run of snapshots) snapshotTopics.add(topicFor(run));
      for (const [topic, previous] of runs) {
        if (snapshotTopics.has(topic)) continue;
        try {
          const run = await runDetails(base, previous, roundSignal);
          if (["failed", "aborted", "succeeded"].includes(run.statusLabel)) apply(run);
        } catch (error) {
          if (error instanceof RunDetailsError && error.status === 404) {
            runs.delete(topic);
            stopActivity(topic);
          }
          // Other failures leave the run tracked for the next discovery round.
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
      // Dagu 2.20.1 accepts 20 topics per SSE connection; 21 returns HTTP 503 `unable to open SSE stream`.
      const topics = [...runs.keys()];
      const streams: Promise<void>[] = [];
      let streamFailure: unknown;
      for (let index = 0; index < topics.length; index += 20) {
        streams.push(streamTopics(base, topics.slice(index, index + 20), roundSignal, emit)
          .catch(error => { streamFailure ??= error; round.abort(); throw error; }));
      }
      const results = await Promise.allSettled(streams);
      if (results.some(result => result.status === "rejected")) throw streamFailure;
    } catch (error) {
      if (!signal.aborted && !refresh) {
        offlineRetrySeconds = backoff / 1000;
        slow = isTimeout(error);
        render();
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
  const view: WidgetView = { expanded: false, hidden: false };
  const modes: Record<string, (view: WidgetView) => void> = {
    "": view => { view.hidden ? (view.hidden = false) : (view.expanded = !view.expanded); },
    expand: view => { view.hidden = false; view.expanded = true; },
    collapse: view => { view.hidden = false; view.expanded = false; },
    show: view => { view.hidden = false; },
    hide: view => { view.hidden = true; },
  };
  pi.registerCommand(TOGGLE_COMMAND, {
    description: "Toggle the Workflows widget fold, or pass expand / collapse / show / hide",
    getArgumentCompletions(prefix) {
      const items = Object.keys(modes).filter(mode => mode && mode.startsWith(prefix.trim().toLowerCase()))
        .map(mode => ({ label: mode, value: mode }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      const mode = modes[args.trim().toLowerCase()];
      if (!mode) {
        ctx.ui.notify(`/${TOGGLE_COMMAND}: use expand, collapse, show o hide`, "warning");
        return;
      }
      mode(view);
      view.render?.();
    },
  });
  const queues = new Map<string, { messages: string[]; claimed: boolean }>();
  const pump = (): void => {
    const ctx = activeContext;
    if (!ctx || ctx.agent.kind !== "main") return;
    const queue = queues.get(ctx.sessionManager.getSessionId());
    if (!queue || queue.claimed) return;
    while (queue.messages.length) {
      const idle = ctx.isIdle();
      // Reserve the autonomous turn before sendMessage can start it.
      if (idle) queue.claimed = true;
      const message = queue.messages.shift()!;
      pi.sendMessage({ customType: "dagu-state", content: message, display: false }, { deliverAs: "aside" });
      if (idle) break;
    }
  };
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
    delete view.render;
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
    const session = ctx.sessionManager.getSessionId();
    void observe(ctx, controller.signal, message => {
      if (controller?.signal.aborted || activeContext !== ctx
        || ctx.sessionManager.getSessionId() !== session) return;
      let queue = queues.get(session);
      if (!queue) { queue = { messages: [], claimed: false }; queues.set(session, queue); }
      queue.messages.push(message);
      pump();
    }, view).catch(() => {});
  };
  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.on("session_shutdown", stop);
  pi.on("agent_end", (_event, ctx) => {
    const queue = queues.get(ctx.sessionManager.getSessionId());
    if (queue) queue.claimed = false;
    // The host becomes idle after agent_end handlers have returned.
    setTimeout(pump, 0);
  });
}
