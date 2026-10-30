import { recordRunObservation, receiptCompatibility } from "./receipt.ts";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { activityTarget, readActivity } from "./activity.ts";
import { ghIssueTitleResolver, IssueTitles } from "./issue-title.ts";
import { isActive, issueNumber, renderOffline, renderWidget, TOGGLE_COMMAND, topicFor, Transitions } from "./progress.ts";
import { resolveRunPrimary, runParam } from "../run-primary.ts";
import type { RunDetails, WidgetTheme } from "./progress.ts";
import { readActiveProtection } from "../integration-protection.ts";
import { readCiDiagnostic, readEscalationDiagnostic, readStallNotices, resolveRepository } from "./repository.ts";
import { SSEParser } from "./sse.ts";
import type { SSEEvent } from "./sse.ts";
import { EventLog } from "./event-log.ts";
import { SESSION_ID_TOOL, WORKFLOWS_COMMAND } from "../registration.ts";
import type { GenerationScope } from "@a4s/hot-reload";
import type { TransitionStorage } from "./progress.ts";

interface NoticeStorage {
  transitions: TransitionStorage;
  uiTransitions: TransitionStorage;
  seen: Set<string>;
  tracked: Map<string, { summary: RunDetails; detailsBaseline: boolean; ledgerBaseline: boolean }>;
  completed: Set<string>;
  initialDiscovery: boolean;
}

function noticeStorage(): NoticeStorage {
  return { transitions: { states: new Map(), notices: new Set() },
    uiTransitions: { states: new Map(), notices: new Set() }, seen: new Set(),
    tracked: new Map(), completed: new Set(), initialDiscovery: true };
}

const REQUEST_TIMEOUT_MS = 15_000;
const exec = promisify(execFile);

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
  on(event: "session_start" | "session_switch" | "session_shutdown" | "agent_start" | "agent_end", handler: (event: unknown, ctx: Context) => void): void;
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
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json() as { dagRuns: RunDetails[]; nextCursor?: string };
    runs.push(...page.dagRuns.filter(run => (history || isActive(run)) && run.labels?.includes(`workspace=${repo}`)));
    if (!page.nextCursor) break;
    url.searchParams.set("cursor", page.nextCursor);
  } while (!signal.aborted);
  return runs;
}

class RunDetailsError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function runDetails(base: string, summary: RunDetails, signal: AbortSignal): Promise<RunDetails> {
  const dag = encodeURIComponent(summary.name);
  const run = encodeURIComponent(summary.dagRunId);
  const response = await fetch(`${base}/api/v1/dag-runs/${dag}/${run}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!response.ok) throw new RunDetailsError(response.status);
  const payload = await response.json() as { dagRunDetails?: RunDetails };
  const details = { ...summary, ...payload.dagRunDetails };
  const primary = await resolveRunPrimary(base, details, signal);
  if (primary) details.resolvedPrimary = primary;
  if (primary) {
    const unsupported = receiptCompatibility(primary, details);
    if (unsupported) details.artifactError = unsupported;
  }
  if (details.name === "poc" && primary && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(details.dagRunId)
    && details.nodes?.some(node => node.step.name === "run_poc"
      && node.statusLabel === "waiting" && (node.approvalIteration ?? 0) > 0)) {
    try {
      const { stdout } = await exec("git", ["-C", primary, "rev-parse", "--path-format=absolute",
        "--git-path", `poc/runs/${details.dagRunId}/scope-errors`], { signal, timeout: 5000 });
      const cause = (await readFile(stdout.trim(), "utf8")).split(/\r?\n/).find(line => line.trim());
      if (cause) details.scopeFailureCause = cause;
    } catch {
      // A remote or missing local primary cannot supply the durable diagnostic.
    }
  }
  return details;
}

async function streamTopics(base: string, topics: string[], signal: AbortSignal, emit: (event: SSEEvent) => void) {
  const url = new URL(`${base}/api/v1/events/stream`);
  for (const topic of topics) url.searchParams.append("topic", topic);
  const headers = new AbortController();
  const headerTimer = setTimeout(() => headers.abort(new DOMException("SSE headers timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);
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

async function watchNotices(base: string, repo: string, ctx: Context, signal: AbortSignal, wake: (message: string) => void, storage: NoticeStorage): Promise<void> {
  const transitions = new Transitions(ctx.sessionManager.getSessionId(), undefined, undefined, storage.transitions);
  const ledger = new EventLog(storage.seen);
  const { tracked, completed } = storage;
  while (!signal.aborted) {
    try {
      for (const summary of await discover(base, repo, signal, true)) {
        if (signal.aborted) return;
        if (runParam(summary, "OMP_SESSION_ID") !== ctx.sessionManager.getSessionId()) continue;
        const topic = topicFor(summary);
        if (completed.has(topic)) continue;
        if (storage.initialDiscovery && ["succeeded", "failed", "aborted"].includes(summary.statusLabel)) {
          completed.add(topic);
          continue;
        }
        const state = tracked.get(topic);
        if (state) state.summary = summary;
        else {
          const detailed = summary.nodes?.every(node => node.statusLabel !== "waiting" || node.step.humanTask !== undefined) ?? false;
          if (storage.initialDiscovery && detailed) transitions.observe(summary, { baseline: true });
          tracked.set(topic, { summary, detailsBaseline: storage.initialDiscovery && !detailed, ledgerBaseline: storage.initialDiscovery });
        }
      }
      // Freeze membership before reading any individual run. A failed first
      // detail or ledger read must not turn an existing run into a new one.
      if (signal.aborted) return;
      storage.initialDiscovery = false;
      for (const [topic, state] of tracked) {
        const { summary } = state;
        try {
          const run = await runDetails(base, summary, signal);
          if (signal.aborted) return;
          const primary = run.resolvedPrimary ?? runParam(run, "PRIMARY");
          if (primary) summary.resolvedPrimary = primary;
          try { await recordRunObservation(run, primary || ctx.cwd); }
          catch (error) { console.warn("DAGU_RECEIPT_OBSERVATION_REJECTED", error); }
          const ciDiagnostic = await readCiDiagnostic(primary, run.dagRunId,
            run.nodes?.some(node => node.statusLabel === "waiting" && (node.step.id ?? node.step.name) === "implement") ?? false, signal);
          const escalationDiagnostic = run.nodes?.some(node => node.statusLabel === "waiting"
            && ["escalation", "rebase_escalation"].includes(node.step.id ?? node.step.name))
            ? await readEscalationDiagnostic(primary, run.dagRunId, signal) : undefined;
          const stalls = await readStallNotices(primary, run.dagRunId, signal);
          if (signal.aborted) return;
          const integrationProtection = primary ? readActiveProtection(primary) : undefined;
          const terminal = ["succeeded", "failed", "aborted"].includes(run.statusLabel);
          let snapshots: RunDetails[] = [];
          let ledgerRead = false;
          if (!terminal) {
            try {
              snapshots = await ledger.read(base, run, signal, false);
              ledgerRead = true;
            } catch (error) {
              // Current details can still establish the baseline or report a
              // fresh opening while the historical ledger remains unbaselined.
              try {
                await recordRunObservation(run, primary || ctx.cwd, "observation-error",
                  error instanceof Error ? error.message : String(error));
              } catch (receiptError) { console.warn("DAGU_RECEIPT_OBSERVATION_FAILED", receiptError); }
            }
          }
          // Seed/deliver the current opening before baselining recovered history,
          // so a fresh current transition is not consumed by the silent ledger.
          if (signal.aborted) return;
          for (const snapshot of [run, ...snapshots]) {
            if (snapshot !== run) {
              void recordRunObservation(snapshot, primary || ctx.cwd, "persisted-transition")
                .catch(error => console.warn("DAGU_RECEIPT_OBSERVATION_REJECTED", error));
            }
            const baseline = snapshot === run
              ? state.detailsBaseline && !terminal
              : state.ledgerBaseline;
            const effects = transitions.observe(snapshot, { baseline, ...(ciDiagnostic ? { ciDiagnostic } : {}),
              ...(escalationDiagnostic ? { escalationDiagnostic } : {}), ...(stalls.length ? { stalls } : {}),
              ...(integrationProtection ? { integrationProtection } : {}) });
            for (const message of effects.wakeMessages ?? (effects.wakeMessage ? [effects.wakeMessage] : [])) wake(message);
            if (effects.warningMessage) ctx.ui.notify(effects.warningMessage, "warning");
          }
          ledger.commit();
          state.detailsBaseline = false;
          // An empty successful read establishes a baseline too. A failed read
          // keeps its own baseline without suppressing later current-state changes.
          if (ledgerRead) state.ledgerBaseline = false;
          if (terminal) {
            completed.add(topic);
            tracked.delete(topic);
          }
        } catch (error) {
          try { await recordRunObservation(summary, summary.resolvedPrimary ?? runParam(summary, "PRIMARY") ?? ctx.cwd, "observation-error", error instanceof Error ? error.message : String(error)); }
          catch (receiptError) { console.warn("DAGU_RECEIPT_OBSERVATION_FAILED", receiptError); }
        }
      }
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

async function observe(ctx: Context, signal: AbortSignal, wake: (message: string) => void, view: WidgetView, storage: NoticeStorage): Promise<void> {
  const repo = await resolveRepository(ctx.cwd, signal);
  if (!repo || signal.aborted) return;
  const base = (process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
  if (ctx.agent.kind === "main") void watchNotices(base, repo, ctx, signal, wake, storage).catch(() => {});
  const runs = new Map<string, RunDetails>();
  const transitions = new Transitions(ctx.agent.kind === "main" ? ctx.sessionManager.getSessionId() : undefined,
    undefined, undefined, storage.uiTransitions);
  const titles = new IssueTitles(ghIssueTitleResolver(ctx.cwd));
  const activities = new Map<string, string>();
  const activityWatches = new Map<string, { key: string; controller: AbortController }>();
  let sessionDir: string | undefined;
  try { sessionDir = ctx.sessionManager.getSessionDir?.(); } catch {}
  let initialSweep = true;
  let offlineRetrySeconds: number | undefined;
  let slow = false;
  const render = (): void => {
    if (!ctx.hasUI || signal.aborted) return;
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
    if (signal.aborted) return;
    const issue = issueNumber(run);
    const slug = issue ? titles.get(issue) : undefined;
    const effects = transitions.observe(run, slug ? { baseline, slug, checkpoints: false } : { baseline, checkpoints: false });
    if (effects.notification && ctx.hasUI) {
      ctx.ui.notify(effects.notification.message, effects.notification.type);
    }
    if (effects.wakeMessage) wake(effects.wakeMessage);
    if (effects.warningMessage) ctx.ui.notify(effects.warningMessage, "warning");
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
      // Dagu accepts 20 topics per SSE connection; 21 returns HTTP 503 `unable to open SSE stream`.
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

export default function daguStatus(pi: ExtensionAPI, scope?: GenerationScope): void {
  let controller: AbortController | undefined;
  let activeContext: Context | undefined;
  let pumpTimer: NodeJS.Timeout | undefined;
  const shared = scope?.state;
  const queues = (shared?.get("status.queues") as Map<string, {
    messages: string[]; claimed: boolean; alerts: { message: string; type: "info" | "warning" | "error" }[];
  }> | undefined) ?? new Map();
  const notices = (shared?.get("status.notices") as Map<string, NoticeStorage> | undefined) ?? new Map();
  shared?.set("status.queues", queues);
  shared?.set("status.notices", notices);
  const view: WidgetView = { expanded: false, hidden: false };
  const modes: Record<string, (view: WidgetView) => void> = {
    "": view => { view.hidden ? (view.hidden = false) : (view.expanded = !view.expanded); },
    expand: view => { view.hidden = false; view.expanded = true; },
    collapse: view => { view.hidden = false; view.expanded = false; },
    show: view => { view.hidden = false; },
    hide: view => { view.hidden = true; },
  };
  pi.registerCommand(TOGGLE_COMMAND, {
    description: WORKFLOWS_COMMAND.description,
    getArgumentCompletions(prefix) {
      const items = WORKFLOWS_COMMAND.completions.filter(mode => mode.startsWith(prefix.trim().toLowerCase()))
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
  const pump = (): void => {
    const ctx = activeContext;
    if (scope && !scope.ready) return;
    if (!ctx) return;
    const queue = queues.get(ctx.sessionManager.getSessionId());
    if (!queue) return;
    while (queue.alerts.length) {
      const alert = queue.alerts.shift()!;
      ctx.ui.notify(alert.message, alert.type);
    }
    if (ctx.agent.kind !== "main") return;
    while (queue.messages.length) {
      const idle = ctx.isIdle();
      if (idle && queue.claimed) break;
      // Reserve only an idle wake; an active turn accepts asides while claimed.
      if (idle) queue.claimed = true;
      const message = queue.messages.shift()!;
      pi.sendMessage({
        customType: "dagu-state", content: message,
        display: /^\[DAGU STATE\] .* status=waiting step=validation\b/.test(message),
      }, { deliverAs: "aside" });
      if (idle) break;
    }
  };
  scope?.onCommit(pump);
  pi.registerTool({
    ...SESSION_ID_TOOL,
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
    clearTimeout(pumpTimer);
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
    const activeController = controller;
    scope?.onAbort(stop);
    // Every detached promise has an error boundary; shutdown aborts fetches and sleeps.
    const session = ctx.sessionManager.getSessionId();
    let storage = notices.get(session);
    if (!storage) { storage = noticeStorage(); notices.set(session, storage); }
    const queue = queues.get(session) ?? { messages: [], claimed: false, alerts: [] };
    queues.set(session, queue);
    // A failed candidate must not consume transition deduplication while dropping
    // its UI notification. Queue both message kinds in switch-owned plain state.
    const observerContext: Context = Object.assign(Object.create(ctx), {
      ui: Object.assign(Object.create(ctx.ui), {
        notify(message: string, type: "info" | "warning" | "error") {
          if (activeController.signal.aborted) return;
          queue.alerts.push({ message, type });
          pump();
        },
      }),
    });
    void observe(observerContext, activeController.signal, message => {
      if (activeController.signal.aborted || activeContext !== ctx
        || ctx.sessionManager.getSessionId() !== session) return;
      queue.messages.push(message);
      pump();
    }, view, storage).catch(() => {});
  };
  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.on("session_shutdown", stop);
  // Idle sendMessage admission is asynchronous; drain the batch once its turn starts.
  pi.on("agent_start", pump);
  pi.on("agent_end", (_event, ctx) => {
    const queue = queues.get(ctx.sessionManager.getSessionId());
    if (queue) queue.claimed = false;
    // The host becomes idle after agent_end handlers have returned.
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, 0);
  });
}
