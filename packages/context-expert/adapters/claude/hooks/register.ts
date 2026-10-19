// Claude adapter for @a4s/context-expert — a Claude Code function-hooks mod.
//
// It is the host-specific half of the dual-adapter design: the deterministic
// keep/truncate/drop compaction lives in ../core (host-neutral), and this file
// only (a) binds Claude's SessionMessage transcript to the core via a
// HostBinding, (b) registers the `session.compact` hook to replace the native
// summary with the core's rebuilt message array, and (c) registers a
// `turn.complete` trigger that applies the shared adaptive policy. It asks the
// timing Jev only between the policy floor and ceiling. A positive decision in
// hint mode asks the user to run `/compact`; auto mode dispatches one host
// compaction.
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
  evaluateTriggerPolicy,
  MAX_REQUEST_BYTES,
  triggerFloorPasses,
  triggerThresholds,
  TRIGGER_POLICY_VERSION,
  type TriggerDiagnostic,
  type TriggerDiagnosticCode,
  type TriggerPolicyDecision,
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

/** Minimum ms between trigger compactions, so the trigger never hammers Jev. */
export const TRIGGER_COOLDOWN_MS = 300_000;
const TRIGGER_REARM_DELTA_TOKENS = 40_000;
export const JEV_TIMEOUT_MS = 2_000;
export const TRIGGER_DECISION_EVENT = 'a4s.claude-context-expert.trigger-decision.v1';

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

type TriggerDispatchOutcome = 'not_dispatched' | 'completed' | 'failed';
type TriggerGateReason = 'cooldown' | 'rearm';

interface TriggerDecisionLogInput {
  contextWindowTokens: number;
  nativeOverflowThreshold?: number;
  effectiveFloorTokens: number;
  effectiveCeilingTokens: number;
  preContextTokens: number;
  preRatio: number;
  postContextTokens?: number;
  actualReclaimTokens?: number;
  rearmTokens?: number;
  rearmStatus?: 'armed' | 'post_context_unavailable';
  cooldownRemainingMs?: number;
  mode: Exclude<TriggerMode, 'off'>;
  decision: 'wait' | 'compact';
  reason: TriggerPolicyDecision['reason'] | TriggerGateReason | 'adapter_failure';
  basis: TriggerPolicyDecision['basis'] | 'mechanical';
  score: number | null;
  floor: number | null;
  triggerOrigin: 'turn.complete';
  dispatchOutcome: TriggerDispatchOutcome;
  uiOutcome?: 'hinted' | 'failed';
}

function policyLogInput(
  decision: TriggerPolicyDecision,
  dispatchOutcome: TriggerDispatchOutcome,
): Pick<TriggerDecisionLogInput, 'decision' | 'reason' | 'basis' | 'score' | 'floor' | 'dispatchOutcome'> {
  return {
    decision: decision.decision,
    reason: decision.reason,
    basis: decision.basis,
    score: decision.score,
    floor: decision.floor,
    dispatchOutcome,
  };
}

function opaqueTriggerId(timestamp: string, turnId: string, sequence: number): string {
  let hash = 0x811c9dc5;
  for (const codePoint of `${timestamp}:${turnId}:${sequence}`) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `td-${(hash >>> 0).toString(16).padStart(8, '0')}-${sequence.toString(36)}`;
}

/** Emits only normalized policy metadata through Claude's existing UI/debug log. */
export function logTriggerDecision(
  $: { ui: { log: (text: string) => void } },
  timestamp: Date,
  turnId: string,
  sequence: number,
  model: string,
  input: TriggerDecisionLogInput,
): void {
  const timestampText = timestamp.toISOString();
  const record = {
    event: TRIGGER_DECISION_EVENT,
    schema: 'a4s.claude-context-expert.trigger-decision/v1',
    policyVersion: TRIGGER_POLICY_VERSION,
    adapter: 'claude',
    id: opaqueTriggerId(timestampText, turnId, sequence),
    timestamp: timestampText,
    model,
    ...input,
  };
  try {
    $.ui.log(`[context-expert] ${JSON.stringify(record)}`);
  } catch {
    // Trigger observability is best-effort and must not change dispatch.
  }
}

function compactedTokensAfter(result: unknown): number | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const tokensAfter = (result as { tokensAfter?: unknown }).tokensAfter;
  return typeof tokensAfter === 'number' && Number.isFinite(tokensAfter) && tokensAfter >= 0
    ? tokensAfter
    : undefined;
}

function compactWasSkipped(result: unknown): boolean {
  return !!result && typeof result === 'object' && !Array.isArray(result) &&
    typeof (result as { skip?: unknown }).skip === 'string';
}

/** The only positive-trigger dispatch path for auto mode. */
async function dispatchCompaction(
  $: { session: { compact: () => Promise<unknown> } },
): Promise<unknown> {
  return $.session.compact();
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let triggerEvaluationActive = false;
  let triggerRequestActive = false;
  let lastTriggerAt = 0;
  let triggerRearmTokens: number | undefined;
  let triggerDecisionSequence = 0;

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

  // The shared policy uses an adaptive floor and ceiling. It asks timing Jev
  // only in the semantic band. Hint notifies the user. Auto dispatches.
  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (
      configured.triggerMode === 'off' ||
      compacting ||
      triggerEvaluationActive ||
      triggerRequestActive ||
      event.agentId !== undefined ||
      event.isAborted ||
      event.reason !== 'answer' ||
      event.answer.trim() === ''
    ) return next(event);

    triggerEvaluationActive = true;
    try {
      const { context } = await $.session.usage({ breakdown: 'summary' });
      const contextWindow = context.window;
      const contextTokens = context.tokens;

      // Claude exposes exact input tokens after a response. Never derive them
      // from the rounded percentage when that exact metric is unavailable.
      if (
        contextTokens === undefined ||
        !triggerFloorPasses(contextTokens, contextWindow, configured.minimumContextRatio)
      ) return next(event);

      const thresholds = triggerThresholds(contextWindow);
      const nativeThreshold = context.breakdown?.autoCompactThreshold;
      const nativeOverflowThreshold =
        typeof nativeThreshold === 'number' && Number.isFinite(nativeThreshold)
          ? nativeThreshold
          : undefined;
      let model = event.usage?.model;
      if (!model) {
        try {
          model = await $.session.model();
        } catch {
          model = 'unknown';
        }
      }
      const mode: Exclude<TriggerMode, 'off'> =
        configured.triggerMode === 'hint' ? 'hint' : 'auto';
      const recordTrigger = (
        input: Omit<TriggerDecisionLogInput,
          | 'contextWindowTokens'
          | 'nativeOverflowThreshold'
          | 'effectiveFloorTokens'
          | 'effectiveCeilingTokens'
          | 'preContextTokens'
          | 'preRatio'
          | 'mode'
          | 'triggerOrigin'>,
      ): void => {
        logTriggerDecision($, new Date(), event.turnId, ++triggerDecisionSequence, model, {
          contextWindowTokens: contextWindow,
          effectiveFloorTokens: thresholds.floorTokens,
          effectiveCeilingTokens: thresholds.ceilingTokens,
          preContextTokens: contextTokens,
          preRatio: contextTokens / contextWindow,
          mode,
          triggerOrigin: 'turn.complete',
          ...(nativeOverflowThreshold === undefined ? {} : { nativeOverflowThreshold }),
          ...input,
        });
      };
      const block = (
        reason: TriggerGateReason,
        extra: Partial<Pick<TriggerDecisionLogInput, 'cooldownRemainingMs' | 'rearmTokens'>> = {},
      ): void => {
        recordTrigger({
          decision: 'wait',
          reason,
          basis: 'mechanical',
          score: null,
          floor: null,
          dispatchOutcome: 'not_dispatched',
          ...extra,
        });
      };

      const cooldownRemainingMs = Math.max(0, TRIGGER_COOLDOWN_MS - (Date.now() - lastTriggerAt));
      if (cooldownRemainingMs > 0) {
        block('cooldown', { cooldownRemainingMs });
        return next(event);
      }
      if (triggerRearmTokens !== undefined && contextTokens < triggerRearmTokens) {
        block('rearm', {
          ...(Number.isFinite(triggerRearmTokens) ? { rearmTokens: triggerRearmTokens } : {}),
        });
        return next(event);
      }
      if (triggerRearmTokens !== undefined) triggerRearmTokens = undefined;

      let policyDecision: TriggerPolicyDecision | undefined;
      try {
        const reportDiagnostic = (diagnostic: TriggerDiagnostic): void => {
          logTriggerDiagnostic($, diagnostic);
        };
        if (contextTokens >= thresholds.ceilingTokens) {
          policyDecision = await evaluateTriggerPolicy(
            { ask: async () => { throw new Error('ceiling must not call timing Jev'); } },
            buildTriggerState(contextTokens, contextWindow, configured.minimumContextRatio),
            reportDiagnostic,
          );
        } else {
          const apiKey = await getApiKey($, configured);
          if (!apiKey) {
            recordTrigger({
              decision: 'wait',
              reason: 'adapter_failure',
              basis: 'mechanical',
              score: null,
              floor: null,
              dispatchOutcome: 'failed',
            });
            return next(event);
          }
          const asker = jevAsker(
            async (url, init) => {
              triggerRequestActive = true;
              try {
                const response = await $.http.fetch(url, init);
                return { status: response.status, ok: response.ok, text: response.text };
              } finally {
                triggerRequestActive = false;
              }
            },
            apiKey,
            configured.model,
            MAX_REQUEST_BYTES,
            (ms) => $.clock.sleep(ms, { signal: next.signal }),
          );
          const messages = await $.session.messages();
          policyDecision = await evaluateTriggerPolicy(
            asker,
            buildTriggerState(
              contextTokens,
              contextWindow,
              configured.minimumContextRatio,
              messages as unknown as readonly Message[],
              [apiKey],
            ),
            reportDiagnostic,
          );
        }

        if (policyDecision.decision === 'wait') {
          recordTrigger(policyLogInput(policyDecision, 'not_dispatched'));
          return next(event);
        }

        if (mode === 'hint') {
          try {
            notify($, 'context policy recommends compaction; run /compact to compact now');
          } catch (error) {
            recordTrigger({
              ...policyLogInput(policyDecision, 'not_dispatched'),
              uiOutcome: 'failed',
            });
            logSafeError($, 'trigger_host', error);
            return next(event);
          }
          lastTriggerAt = Date.now();
          recordTrigger({
            ...policyLogInput(policyDecision, 'not_dispatched'),
            uiOutcome: 'hinted',
          });
          return next(event);
        }

        lastTriggerAt = Date.now();
        compacting = true;
        let compactResult: unknown;
        try {
          compactResult = await dispatchCompaction($);
        } finally {
          compacting = false;
        }
        if (compactWasSkipped(compactResult)) {
          recordTrigger(policyLogInput(policyDecision, 'failed'));
          return next(event);
        }

        const postContextTokens = compactedTokensAfter(compactResult);
        if (postContextTokens === undefined) {
          triggerRearmTokens = Number.POSITIVE_INFINITY;
          recordTrigger({
            ...policyLogInput(policyDecision, 'completed'),
            rearmStatus: 'post_context_unavailable',
          });
        } else {
          triggerRearmTokens = Math.max(thresholds.floorTokens, postContextTokens + TRIGGER_REARM_DELTA_TOKENS);
          recordTrigger({
            ...policyLogInput(policyDecision, 'completed'),
            postContextTokens,
            actualReclaimTokens: Math.max(0, contextTokens - postContextTokens),
            rearmTokens: triggerRearmTokens,
            rearmStatus: 'armed',
          });
        }
      } catch (error) {
        recordTrigger(
          policyDecision
            ? policyLogInput(policyDecision, 'failed')
            : {
              decision: 'wait',
              reason: 'adapter_failure',
              basis: 'mechanical',
              score: null,
              floor: null,
              dispatchOutcome: 'failed',
            },
        );
        logSafeError($, 'trigger_host', error);
      }
    } catch (error) {
      logSafeError($, 'trigger_host', error);
    } finally {
      triggerEvaluationActive = false;
    }
    return next(event);
  });
};

export { resolveOptions };
