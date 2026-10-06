// Claude adapter for @a4s/context-expert — a Claude Code function-hooks mod.
//
// It is the host-specific half of the dual-adapter design: the deterministic
// keep/truncate/drop compaction lives in ../core (host-neutral), and this file
// only (a) binds Claude's SessionMessage transcript to the core via a
// HostBinding, (b) registers the `session.compact` hook to replace the native
// summary with the core's rebuilt message array, and (c) registers a
// `turn.complete` trigger that, past a local context-fill floor, asks Jev
// whether now is the ideal moment to compact and acts only when Jev says so
// (the Claude analog of pi-context-expert's `trigger.mode: auto`).
//
// Jev runs over the engine's `$.http.fetch` against the TypeSafe System One
// endpoint; the API key resolves from userConfig, then TYPESAFE_API_KEY, then
// the plugin settings `env`, and finally Pi's native credential provider
// (~/.pi/agent/auth.json → typesafe.key), the source the way-of-working
// sanctions. On any error — missing key, Jev failure, or an
// under-threshold reduction — the hook falls back to the engine's native
// compaction via `next(event)`, so a failure never degrades the session.
//
// Derived from fast-jev-compaction (MIT) — see ../NOTICE.

import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { reductionRatio, resolveOptions } from '../core/compact.js';
import {
  buildJevRequest,
  DEFAULT_MODEL,
  JevRequestError,
  parseJevResponse,
  type JevRequestErrorCode,
} from '../core/request.js';
import { runCompaction, type HostBinding } from '../core/binding.js';
import {
  buildTriggerState,
  DEFAULT_MINIMUM_CONTEXT_RATIO,
  evaluateTrigger,
  MAX_REQUEST_BYTES,
  triggerFloorPasses,
  type TriggerDiagnostic,
  type TriggerDiagnosticCode,
} from '../core/trigger.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../core/types.js';

/** Pi-parity trigger modes: off disables it, hint suggests, auto compacts. */
export type TriggerMode = 'off' | 'hint' | 'auto';

const HOOK_DEFAULTS = {
  triggerMode: 'auto' as TriggerMode,
  minimumContextRatio: DEFAULT_MINIMUM_CONTEXT_RATIO,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

/** Minimum ms between auto-compactions, so the trigger never hammers Jev. */
const TRIGGER_COOLDOWN_MS = 60_000;
export const JEV_TIMEOUT_MS = 2_000;

export type HookFetchInit = { method?: string; headers?: Record<string, string>; body?: string };
export type HookFetchResponse = { status: number; ok: boolean; text: string };
/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;
export type HookSleep = (ms: number) => Promise<void>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  triggerMode: TriggerMode;
  minimumContextRatio: number;
  minReductionRatio: number;
  model: string;
};

function optionTriggerMode(options: PluginOptions, fallback: TriggerMode): TriggerMode {
  const value = options['triggerMode'];
  return value === 'off' || value === 'hint' || value === 'auto' ? value : fallback;
}

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    triggerMode: optionTriggerMode(options, HOOK_DEFAULTS.triggerMode),
    minimumContextRatio: optionNumber(options, 'minimumContextRatio', HOOK_DEFAULTS.minimumContextRatio),
    minReductionRatio: optionNumber(options, 'minReductionRatio', HOOK_DEFAULTS.minReductionRatio),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

const TIMED_OUT: unique symbol = Symbol('timeout');

/** Un `JevAsker` sobre `$.http.fetch` con un timeout opcional. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  maxBodyBytes?: number,
  sleepFn?: HookSleep,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, maxBodyBytes }, state, questions);
      const pending = fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      const response = sleepFn
        ? await Promise.race([
            pending,
            sleepFn(JEV_TIMEOUT_MS).then((): typeof TIMED_OUT => TIMED_OUT),
          ])
        : await pending;
      if (response === TIMED_OUT) throw new Error('El request de Jev excedió el timeout');
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return { tool_use_id: result.tool_use_id, text: result.text, isError: result.isError ?? false };
}

/**
 * Maps the core's output back onto session messages. Anything returned
 * unchanged is the engine's own object, HANDLE INCLUDED (a kept message);
 * anything rebuilt is a fresh message WITHOUT a handle, so the engine takes the
 * edited content (a truncated tool result). Dropped messages are simply absent.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message as unknown as Message, message);
    for (const tool of message.toolUses) uses.set(tool as unknown as ToolUse, tool);
    for (const result of message.toolResults ?? []) results.set(result as unknown as ToolResult, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map((result) => results.get(result) ?? toolResultSummary(result));
    }
    return rebuilt;
  });
}

export type ClaudeCompaction = { messages: SessionMessage[] };

/**
 * The Claude half of the HostBinding contract. A SessionMessage is a superset
 * of the core's neutral Message, so `toNeutral` passes the transcript through;
 * `assemble` maps the core decisions back to the engine's message array.
 */
export const claudeBinding: HostBinding<SessionMessage, ClaudeCompaction> = {
  toNeutral: (host) => host as unknown as readonly Message[],
  assemble: (host, result) => ({ messages: toSessionMessages(host, result.messages) }),
};

export type SessionCompaction = { result: CompactResult; messages: SessionMessage[] };

/** Runs the shared core over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const { result, output } = await runCompaction(
    messages,
    claudeBinding,
    jevAsker(fetchFn, config.apiKey, config.model),
    config,
  );
  return { result, messages: output.messages };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map((d) => `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`)
    .join(' ');
}

export function decisionLogLines(result: CompactResult, maxChars: number = UI_LOG_MAX_CHARS): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1 ? `decisions: ${chunk}` : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/**
 * Resolves the TypeSafe Jev key from Pi's native credential provider, the way
 * the way-of-working requires (`do_work.credentials`: "TypeSafe resolves
 * credentials only through Pi's native provider"). Pi persists it at
 * `~/.pi/agent/auth.json` under `typesafe.key`. Read in-process only; the key
 * is never logged, written to disk, or copied elsewhere.
 */
async function piTypeSafeKey($: {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: { read: (path: string) => Promise<string> };
}): Promise<string | undefined> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
    if (!home) return undefined;
    const raw = await $.fs.read(`${home}/.pi/agent/auth.json`);
    const key: unknown = (JSON.parse(raw) as { typesafe?: { key?: unknown } })?.typesafe?.key;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
    fs: { read: (path: string) => Promise<string> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  // Final fallback: Pi's native provider — the sanctioned credential source.
  return piTypeSafeKey($);
}

function notify(
  $: { ui: { log: (text: string) => void; toast: (text: string, options?: { timeoutMs?: number }) => void } },
  text: string,
): void {
  $.ui.log(`[context-expert] ${text}`);
  $.ui.toast(`context-expert: ${text}`, { timeoutMs: 15_000 });
}

function logCompactResult(
  $: { ui: { log: (text: string) => void } },
  result: CompactResult,
  outcome: 'applied' | 'fallback',
): void {
  const { stats } = result;
  $.ui.log(
    `[context-expert] event=compact code=compact_result outcome=${outcome}` +
      ` messages_before=${stats.messagesBefore} messages_after=${stats.messagesAfter}` +
      ` calls=${stats.calls} kept=${stats.kept}` +
      ` results_dropped=${stats.resultsDropped} calls_dropped=${stats.callsDropped}`,
  );
}

export type DiagnosticCode = TriggerDiagnosticCode | JevRequestErrorCode | 'operation_failed';
export type DiagnosticPhase = 'compact' | 'trigger_request' | 'trigger_response' | 'trigger_host';

export interface SafeDiagnostic {
  code: DiagnosticCode;
  phase: DiagnosticPhase;
  status?: number;
}

const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = [
  'http_status',
  'invalid_json',
  'invalid_response',
  'request_failed',
  'invalid_answer',
  'request_too_large',
  'operation_failed',
];
const DIAGNOSTIC_PHASES: readonly DiagnosticPhase[] = [
  'compact',
  'trigger_request',
  'trigger_response',
  'trigger_host',
];

/** Registra solo campos con valores permitidos. */
export function logDiagnostic(
  $: { ui: { log: (text: string) => void } },
  diagnostic: SafeDiagnostic,
): void {
  const code = DIAGNOSTIC_CODES.includes(diagnostic.code) ? diagnostic.code : 'operation_failed';
  const phase = DIAGNOSTIC_PHASES.includes(diagnostic.phase) ? diagnostic.phase : 'trigger_host';
  const status =
    Number.isInteger(diagnostic.status) && diagnostic.status! >= 100 && diagnostic.status! <= 599
      ? ` status=${diagnostic.status}`
      : '';
  $.ui.log(`[context-expert] diagnostic phase=${phase} code=${code}${status}`);
}

/** Convierte cualquier excepción en un diagnóstico sin contenido externo. */
export function logSafeError(
  $: { ui: { log: (text: string) => void } },
  phase: DiagnosticPhase,
  error: unknown,
): void {
  if (error instanceof JevRequestError) {
    logDiagnostic($, { code: error.code, phase, status: error.status });
    return;
  }
  logDiagnostic($, { code: 'operation_failed', phase });
}

function logTriggerDiagnostic(
  $: { ui: { log: (text: string) => void } },
  diagnostic: TriggerDiagnostic,
): void {
  logDiagnostic($, {
    code: diagnostic.code,
    phase: diagnostic.phase === 'request' ? 'trigger_request' : 'trigger_response',
    ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
  });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let lastCompactAt = 0;

  on('session.compact', async ($, event, next) => {
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      if (reductionRatio(result) < config.minReductionRatio) {
        logCompactResult($, result, 'fallback');
        $.ui.toast(
          `context-expert: fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
          { timeoutMs: 15_000 },
        );
        return next(event);
      }
      logCompactResult($, result, 'applied');
      $.ui.toast(
        `context-expert: kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
        { timeoutMs: 15_000 },
      );
      return { messages };
    } catch (error) {
      logSafeError($, 'compact', error);
      $.ui.toast('context-expert: fallback to built-in summary', { timeoutMs: 15_000 });
      return next(event);
    }
  });

  // The Jev-decided trigger: it does NOT compact at a fixed percentage. Past a
  // local floor it asks Jev "is now the ideal moment?" and acts only on
  // `compact` — the Claude analog of pi-context-expert's `trigger.mode: auto`.
  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (
      configured.triggerMode === 'off' ||
      compacting ||
      event.agentId !== undefined ||
      event.isAborted ||
      event.reason !== 'answer' ||
      event.answer.trim() === ''
    ) return next(event);
    try {
      if (Date.now() - lastCompactAt < TRIGGER_COOLDOWN_MS) return next(event);

      const { context } = await $.session.usage();
      const contextWindow = context.window;
      const contextTokens =
        context.tokens ?? (typeof context.percent === 'number' ? (context.percent / 100) * contextWindow : 0);

      // Local floor gate first — never spend a Jev call on a near-empty window.
      if (!triggerFloorPasses(contextTokens, contextWindow, configured.minimumContextRatio)) return next(event);

      const apiKey = await getApiKey($, configured);
      if (!apiKey) return next(event); // No credential → cannot ask Jev; stay quiet.

      const asker = jevAsker(
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        apiKey,
        configured.model,
        MAX_REQUEST_BYTES,
        (ms) => $.clock.sleep(ms, { signal: next.signal }),
      );
      const messages = await $.session.messages();
      let triggerDiagnostic: TriggerDiagnostic | undefined;
      const decision = await evaluateTrigger(
        asker,
        buildTriggerState(
          contextTokens,
          contextWindow,
          configured.minimumContextRatio,
          messages as unknown as readonly Message[],
          [apiKey],
        ),
        (diagnostic) => {
          triggerDiagnostic = diagnostic;
        },
      );
      if (triggerDiagnostic) {
        logTriggerDiagnostic($, triggerDiagnostic);
        return next(event);
      }
      if (decision !== 'compact') return next(event);

      if (configured.triggerMode === 'hint') {
        notify($, 'Jev suggests compacting now — run /compact');
        return next(event);
      }

      compacting = true;
      lastCompactAt = Date.now();
      await $.session.compact();
    } catch (error) {
      logSafeError($, 'trigger_host', error);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
