import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCompaction } from '../core/index.js';
import type { JevAsker, Message } from '../core/index.js';
import {
  claudeBinding,
  JEV_TIMEOUT_MS,
  register,
  toSessionMessages,
} from '../adapters/claude/hooks/register.js';

function fixture(): Message[] {
  const longResult = 'RESULT '.repeat(100);
  return [
    { role: 'user', text: 'start the task', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u_a', tool: 'Read', input: { path: 'a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u_a', text: longResult }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u_b', tool: 'Bash', input: { cmd: 'ls' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u_b', text: 'a.ts b.ts' }] },
    { role: 'assistant', text: 'done', toolUses: [] },
  ];
}

const asker: JevAsker = {
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(questions)) answers[key] = { noul: key === 'call_t1' ? 0.9 : 0.1 };
    return { answers };
  },
};

// SessionMessage is a superset of the neutral Message; the PoC fixtures only
// set the fields the core reads, so the cast is sound for the adapter contract.
const asSession = (messages: Message[]) => messages as unknown as Parameters<typeof claudeBinding.toNeutral>[0];

function triggerRecords(logs: readonly string[]): Array<Record<string, unknown>> {
  const prefix = '[context-expert] {';
  return logs
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice('[context-expert] '.length)) as Record<string, unknown>);
}

function timingResponse(finished: number, handsOn: number): string {
  return JSON.stringify({
    model: 'jev-test',
    answers: {
      done: {
        type: 'choice',
        choice: finished >= 0.5 ? 'finished' : 'not_finished',
        confidence: 0.9,
        probabilities: { finished, not_finished: 1 - finished, unclear: 0 },
      },
      shape: {
        type: 'choice',
        choice: handsOn >= 0.5 ? 'hands_on' : 'coordinating',
        confidence: 0.9,
        probabilities: { hands_on: handsOn, coordinating: 1 - handsOn, unclear: 0 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  });
}

test('claude adapter: kept messages keep their identity (engine handle), edited ones are rebuilt', async () => {
  const input = fixture();
  const { output } = await runCompaction(asSession(input), claudeBinding, asker, {
    preserveRecentMessages: 0,
    truncateHeadChars: 50,
  });

  // The pinned first message and the closing note are untouched → same objects.
  assert.ok(output.messages.includes(input[0] as never), 'message 0 returned as the same object');
  assert.ok(output.messages.includes(input[5] as never), 'closing note returned as the same object');

  // t2 (call + result) was dropped entirely → those messages are gone.
  assert.ok(!output.messages.includes(input[3] as never), 'dropped tool-call message is absent');
  assert.ok(!output.messages.includes(input[4] as never), 'dropped tool-result message is absent');

  // t1's result was truncated → that message is a NEW object (no engine handle).
  assert.ok(!output.messages.includes(input[2] as never), 'truncated message is rebuilt, not the original');
  assert.ok(output.messages.length < input.length, 'fewer messages after compaction');
});

test('claude adapter: toSessionMessages returns untouched messages unchanged and omits dropped ones', () => {
  const input = fixture();
  // A trivial "output" that keeps only messages 0 and 5 (as the same objects).
  const kept = toSessionMessages(asSession(input), [input[0]!, input[5]!]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], input[0], 'kept object identity preserved');
  assert.equal(kept[1], input[5], 'kept object identity preserved');
});

test('claude adapter: el log de compactación omite herramienta y respuesta Jev', async () => {
  const hooks = new Map<string, unknown>();
  const on = (pattern: string, hook: unknown) => {
    hooks.set(pattern, hook);
    return {};
  };
  register(on as never, {
    apiKey: 'TOKEN_CANARY',
    preserveRecentMessages: 0,
    minReductionRatio: 0,
  });

  const messages = fixture();
  messages[1]!.toolUses[0]!.tool = 'TOOL_NAME_CANARY';
  const logs: string[] = [];
  const host = {
    ui: {
      log: (text: string) => logs.push(text),
      toast: () => undefined,
    },
    http: {
      fetch: async (_url: string, init?: { body?: string }) => {
        const request = JSON.parse(init?.body ?? '{}') as { questions?: Record<string, unknown> };
        const answers: Record<string, { noul: number }> = {};
        for (const name of Object.keys(request.questions ?? {})) {
          answers[name] = { noul: name.startsWith('call_') ? 0.873421 : 0.932145 };
        }
        return {
          status: 200,
          ok: true,
          text: JSON.stringify({ model: 'MODEL_OUTPUT_CANARY', answers }),
        };
      },
    },
  };
  const event = { messages: asSession(messages) };
  const compactHook = hooks.get('session.compact') as (
    $: typeof host,
    input: typeof event,
    next: (input: typeof event) => Promise<{ fallback: true }>,
  ) => Promise<unknown>;

  const result = await compactHook(host, event, async () => ({ fallback: true }));

  assert.ok(result && typeof result === 'object' && 'messages' in result);
  assert.deepEqual(logs, [
    '[context-expert] event=compact code=compact_result outcome=applied' +
      ' messages_before=6 messages_after=6 calls=2 kept=2 results_dropped=0 calls_dropped=0',
  ]);
  assert.doesNotMatch(
    logs.join('\n'),
    /TOOL_NAME_CANARY|MODEL_OUTPUT_CANARY|keepCall|keepResult|0\.87|0\.93/,
  );
});

test('claude adapter: el host registra el fallo del trigger sin contenido externo', async () => {
  const hooks = new Map<string, unknown>();
  const on = (pattern: string, hook: unknown) => {
    hooks.set(pattern, hook);
    return {};
  };
  register(on as never, {
    apiKey: 'TOKEN_CANARY',
    triggerMode: 'auto',
    minimumContextRatio: 0.5,
  });

  const logs: string[] = [];
  const bodyCanary = 'REMOTE_HTTP_BODY_CANARY';
  const host = {
    ui: {
      log: (text: string) => logs.push(text),
      toast: () => undefined,
    },
    session: {
      usage: async () => ({ context: { window: 100_000, tokens: 62_000 }, rateLimits: [] }),
      messages: async () => fixture(),
      compact: async () => ({}),
    },
    http: {
      fetch: async () => ({ status: 503, ok: false, text: bodyCanary }),
    },
    clock: {
      sleep: async () => new Promise<void>(() => undefined),
    },
  };
  const event = { reason: 'answer', answer: 'TURN_CONTENT_CANARY', durationMs: 1 };
  const expected = { text: 'unchanged' };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: (input: typeof event) => Promise<typeof expected>,
  ) => Promise<typeof expected>;

  const result = await turnHook(host, event, async () => expected);

  assert.equal(result, expected);
  assert.equal(logs[0], '[context-expert] diagnostic phase=trigger_response code=http_status status=503');
  const records = triggerRecords(logs);
  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      policyVersion: records[0]?.policyVersion,
      adapter: records[0]?.adapter,
      decision: records[0]?.decision,
      reason: records[0]?.reason,
      basis: records[0]?.basis,
      dispatchOutcome: records[0]?.dispatchOutcome,
    },
    {
      policyVersion: 'a4s.compaction-trigger-policy/v1',
      adapter: 'claude',
      decision: 'wait',
      reason: 'request_failed',
      basis: 'semantic',
      dispatchOutcome: 'not_dispatched',
    },
  );
  assert.doesNotMatch(logs.join('\n'), /REMOTE_HTTP_BODY_CANARY|TOKEN_CANARY|TURN_CONTENT_CANARY/);
});

test('claude adapter: popula conversación con $.session.messages y excluye system, reasoning e imágenes', async () => {
  const hooks = new Map<string, unknown>();
  const on = (pattern: string, hook: unknown) => {
    hooks.set(pattern, hook);
    return {};
  };
  const apiKey = 'known-api-key-canary';
  register(on as never, {
    apiKey,
    triggerMode: 'auto',
    minimumContextRatio: 0.5,
  });

  let requestBody = '';
  let compactCalls = 0;
  const transcript = [
    { role: 'system', text: 'SYSTEM_PROMPT_CANARY', toolUses: [] },
    { role: 'user', text: `Use ${apiKey} and API_KEY=hidden-value`, toolUses: [], images: ['IMAGE_CANARY'] },
    {
      role: 'assistant',
      text: 'Visible result.',
      toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'echo ok' }, text: 'tool output' }],
      reasoning: 'REASONING_CANARY',
    },
  ];
  const host = {
    ui: { log: () => undefined, toast: () => undefined },
    session: {
      usage: async () => ({ context: { window: 100_000, tokens: 62_000 }, rateLimits: [] }),
      messages: async () => transcript,
      compact: async () => { compactCalls++; return {}; },
    },
    http: {
      fetch: async (_url: string, init?: { body?: string }) => {
        requestBody = init?.body ?? '';
        return {
          status: 200,
          ok: true,
          text: JSON.stringify({
            model: 'jev-test',
            answers: {
              done: {
                type: 'choice',
                choice: 'not_finished',
                confidence: 0.9,
                probabilities: { finished: 0.1, not_finished: 0.9, unclear: 0 },
              },
              shape: {
                type: 'choice',
                choice: 'coordinating',
                confidence: 0.9,
                probabilities: { hands_on: 0.1, coordinating: 0.9, unclear: 0 },
              },
            },
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
        };
      },
    },
    clock: {
      sleep: async () => new Promise<void>(() => undefined),
    },
  };
  const event = { reason: 'answer', answer: 'answer', durationMs: 1 };
  const expected = { text: 'unchanged' };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: (input: typeof event) => Promise<typeof expected>,
  ) => Promise<typeof expected>;

  assert.equal(await turnHook(host, event, async () => expected), expected);
  const body = JSON.parse(requestBody) as {
    state: { schema: string; recent: { role: string; text: string; tools?: unknown[] }[] };
    questions: Record<string, unknown>;
  };
  assert.equal(body.state.schema, 'a4s.compaction-trigger-state/v3');
  assert.deepEqual(Object.keys(body.questions), ['done', 'shape']);
  assert.deepEqual(body.state.recent.map((message) => message.role), ['user', 'assistant']);
  assert.equal(body.state.recent[1]?.tools?.length, 1);
  assert.doesNotMatch(
    requestBody,
    /SYSTEM_PROMPT_CANARY|REASONING_CANARY|IMAGE_CANARY|known-api-key-canary|hidden-value/,
  );
  assert.equal(compactCalls, 0);
});

async function runIgnoredTurn(event: {
  reason: string;
  answer: string;
  isAborted: boolean;
  durationMs: number;
  turnId: string;
  agentId?: string;
}): Promise<{ result: unknown; expected: object; hostCalls: number; nextCalls: number }> {
  const hooks = new Map<string, unknown>();
  const on = (pattern: string, hook: unknown) => {
    hooks.set(pattern, hook);
    return {};
  };
  register(on as never, { apiKey: 'TOKEN_CANARY', triggerMode: 'auto' });
  let hostCalls = 0;
  let nextCalls = 0;
  const host = {
    session: {
      usage: async () => { hostCalls++; return { context: { window: 100_000, tokens: 62_000 } }; },
      messages: async () => { hostCalls++; return fixture(); },
      compact: async () => { hostCalls++; return {}; },
    },
    http: {
      fetch: async () => { hostCalls++; return { status: 500, ok: false, text: '' }; },
    },
    clock: {
      sleep: async () => { hostCalls++; },
    },
    ui: { log: () => undefined, toast: () => undefined },
  };
  const expected = { text: 'unchanged' };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: (input: typeof event) => Promise<typeof expected>,
  ) => Promise<typeof expected>;
  const result = await turnHook(host, event, async () => {
    nextCalls++;
    return expected;
  });
  return { result, expected, hostCalls, nextCalls };
}

test('claude adapter: ignora eventos de subagente', async () => {
  const outcome = await runIgnoredTurn({
    reason: 'answer',
    answer: 'done',
    isAborted: false,
    durationMs: 1,
    turnId: 'turn-1',
    agentId: 'agent-1',
  });
  assert.equal(outcome.result, outcome.expected);
  assert.equal(outcome.hostCalls, 0);
  assert.equal(outcome.nextCalls, 1);
});

test('claude adapter: ignora turnos con isAborted', async () => {
  const outcome = await runIgnoredTurn({
    reason: 'answer',
    answer: 'partial',
    isAborted: true,
    durationMs: 1,
    turnId: 'turn-2',
  });
  assert.equal(outcome.result, outcome.expected);
  assert.equal(outcome.hostCalls, 0);
  assert.equal(outcome.nextCalls, 1);
});

test('claude adapter: ignora razones distintas de answer', async () => {
  const outcome = await runIgnoredTurn({
    reason: 'error',
    answer: 'failed',
    isAborted: false,
    durationMs: 1,
    turnId: 'turn-3',
  });
  assert.equal(outcome.result, outcome.expected);
  assert.equal(outcome.hostCalls, 0);
  assert.equal(outcome.nextCalls, 1);
});

test('claude adapter: ignora respuestas vacías', async () => {
  const outcome = await runIgnoredTurn({
    reason: 'answer',
    answer: '  \n ',
    isAborted: false,
    durationMs: 1,
    turnId: 'turn-4',
  });
  assert.equal(outcome.result, outcome.expected);
  assert.equal(outcome.hostCalls, 0);
  assert.equal(outcome.nextCalls, 1);
});

test('claude adapter: el timeout de 2,000 ms abandona el request y conserva next', async () => {
  const hooks = new Map<string, unknown>();
  const on = (pattern: string, hook: unknown) => {
    hooks.set(pattern, hook);
    return {};
  };
  const apiKey = 'TIMEOUT_SECRET_CANARY';
  register(on as never, {
    apiKey,
    triggerMode: 'auto',
    minimumContextRatio: 0.5,
  });

  const logs: string[] = [];
  const sleepValues: number[] = [];
  let fetchCalls = 0;
  let compactCalls = 0;
  const host = {
    ui: { log: (text: string) => logs.push(text), toast: () => undefined },
    session: {
      usage: async () => ({ context: { window: 100_000, tokens: 62_000 }, rateLimits: [] }),
      messages: async () => fixture(),
      compact: async () => { compactCalls++; return {}; },
    },
    http: {
      fetch: async () => {
        fetchCalls++;
        return new Promise<{ status: number; ok: boolean; text: string }>(() => undefined);
      },
    },
    clock: {
      sleep: async (ms: number) => { sleepValues.push(ms); },
    },
  };
  const event = {
    reason: 'answer',
    answer: 'TIMEOUT_ANSWER_CANARY',
    isAborted: false,
    durationMs: 1,
    turnId: 'turn-timeout',
  };
  const expected = { text: 'unchanged' };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: (input: typeof event) => Promise<typeof expected>,
  ) => Promise<typeof expected>;

  assert.equal(JEV_TIMEOUT_MS, 2_000);
  assert.equal(await turnHook(host, event, async () => expected), expected);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(sleepValues, [2_000]);
  assert.equal(compactCalls, 0);
  assert.deepEqual(
    logs.filter((line) => line.includes('diagnostic phase=')),
    ['[context-expert] diagnostic phase=trigger_request code=request_failed'],
  );
  assert.equal(triggerRecords(logs)[0]?.reason, 'request_failed');
  assert.doesNotMatch(logs.join('\n'), /TIMEOUT_SECRET_CANARY|TIMEOUT_ANSWER_CANARY|state|questions/);
});

test('claude adapter: mantiene cerrado el gate hasta que termina el fetch pendiente', async () => {
  const hooks = new Map<string, unknown>();
  const on = (pattern: string, hook: unknown) => {
    hooks.set(pattern, hook);
    return {};
  };
  register(on as never, {
    apiKey: 'PENDING_SECRET_CANARY',
    triggerMode: 'auto',
    minimumContextRatio: 0.5,
  });

  type Response = { status: number; ok: boolean; text: string };
  let rejectFirst: (error: Error) => void = () => undefined;
  const firstFetch = new Promise<Response>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const logs: string[] = [];
  const sleepValues: number[] = [];
  let fetchCalls = 0;
  let usageCalls = 0;
  const host = {
    ui: { log: (text: string) => logs.push(text), toast: () => undefined },
    session: {
      usage: async () => {
        usageCalls++;
        return { context: { window: 100_000, tokens: 62_000 }, rateLimits: [] };
      },
      messages: async () => fixture(),
      compact: async () => ({}),
    },
    http: {
      fetch: async () => {
        fetchCalls++;
        if (fetchCalls === 1) return firstFetch;
        return { status: 503, ok: false, text: 'LATER_BODY_CANARY' };
      },
    },
    clock: {
      sleep: async (ms: number) => {
        sleepValues.push(ms);
        if (sleepValues.length > 1) return new Promise<void>(() => undefined);
      },
    },
  };
  const expected = { text: 'unchanged' };
  const event = (turnId: string) => ({
    reason: 'answer',
    answer: `answer-${turnId}`,
    isAborted: false,
    durationMs: 1,
    turnId,
  });
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: ReturnType<typeof event>,
    next: (input: ReturnType<typeof event>) => Promise<typeof expected>,
  ) => Promise<typeof expected>;
  let nextCalls = 0;
  const next = async () => {
    nextCalls++;
    return expected;
  };

  assert.equal(await turnHook(host, event('turn-1'), next), expected);
  assert.equal(fetchCalls, 1);
  assert.equal(nextCalls, 1);

  assert.equal(await turnHook(host, event('turn-2'), next), expected);
  assert.equal(fetchCalls, 1);
  assert.equal(usageCalls, 1);
  assert.equal(nextCalls, 2);

  rejectFirst(new Error('LATE_FETCH_REJECTION_CANARY'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(await turnHook(host, event('turn-3'), next), expected);
  assert.equal(fetchCalls, 2);
  assert.equal(usageCalls, 2);
  assert.equal(nextCalls, 3);
  assert.deepEqual(sleepValues, [2_000, 2_000]);
  assert.deepEqual(
    logs.filter((line) => line.includes('diagnostic phase=')),
    [
      '[context-expert] diagnostic phase=trigger_request code=request_failed',
      '[context-expert] diagnostic phase=trigger_response code=http_status status=503',
    ],
  );
  assert.equal(triggerRecords(logs).length, 2);
  assert.doesNotMatch(
    logs.join('\n'),
    /PENDING_SECRET_CANARY|LATE_FETCH_REJECTION_CANARY|LATER_BODY_CANARY|state|questions/,
  );
});

test('claude adapter: mode=off no consulta al host', async () => {
  const hooks = new Map<string, unknown>();
  register(((pattern: string, hook: unknown) => { hooks.set(pattern, hook); return {}; }) as never, {
    triggerMode: 'off',
  });
  let hostCalls = 0;
  const host = {
    session: { usage: async () => { hostCalls++; return { context: { window: 100_000, tokens: 90_000 } }; } },
  };
  const event = {
    reason: 'answer', answer: 'done', isAborted: false, durationMs: 1, turnId: 'off',
  };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: () => Promise<{ text: string }>,
  ) => Promise<{ text: string }>;

  assert.deepEqual(await turnHook(host, event, async () => ({ text: 'unchanged' })), { text: 'unchanged' });
  assert.equal(hostCalls, 0);
});

test('claude adapter: bajo F no resuelve credenciales ni llama al Jev de timing', async () => {
  const hooks = new Map<string, unknown>();
  register(((pattern: string, hook: unknown) => { hooks.set(pattern, hook); return {}; }) as never, {
    triggerMode: 'auto',
  });
  let protectedCalls = 0;
  const host = {
    ui: { log: () => undefined, toast: () => undefined },
    session: {
      usage: async () => ({ context: { window: 200_000, tokens: 59_999 }, rateLimits: [] }),
      model: async () => { protectedCalls++; return 'claude-test'; },
      messages: async () => { protectedCalls++; return fixture(); },
      compact: async () => { protectedCalls++; return {}; },
    },
    env: { get: async () => { protectedCalls++; return undefined; } },
    settings: { read: async () => { protectedCalls++; return {}; } },
    fs: { read: async () => { protectedCalls++; return ''; } },
    http: { fetch: async () => { protectedCalls++; return { status: 500, ok: false, text: '' }; } },
    clock: { sleep: async () => undefined },
  };
  const event = {
    reason: 'answer', answer: 'done', isAborted: false, durationMs: 1, turnId: 'below-floor',
  };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: (input: typeof event) => Promise<{ text: string }>,
  ) => Promise<{ text: string }>;

  assert.deepEqual(await turnHook(host, event, async () => ({ text: 'unchanged' })), { text: 'unchanged' });
  assert.equal(protectedCalls, 0);
});

test('claude adapter: la banda semántica conserva score y floor para wait', async () => {
  const hooks = new Map<string, unknown>();
  register(((pattern: string, hook: unknown) => { hooks.set(pattern, hook); return {}; }) as never, {
    apiKey: 'SEMANTIC_SECRET_CANARY',
    triggerMode: 'auto',
  });
  const logs: string[] = [];
  let compactCalls = 0;
  const host = {
    ui: { log: (text: string) => logs.push(text), toast: () => undefined },
    session: {
      usage: async () => ({ context: { window: 100_000, tokens: 62_000 }, rateLimits: [] }),
      messages: async () => fixture(),
      compact: async () => { compactCalls++; return {}; },
    },
    http: { fetch: async () => ({ status: 200, ok: true, text: timingResponse(0.6, 0.6) }) },
    clock: { sleep: async () => new Promise<void>(() => undefined) },
  };
  const event = {
    reason: 'answer', answer: 'PRIVATE_CONVERSATION_CANARY', isAborted: false, durationMs: 1,
    turnId: 'semantic-wait', usage: { model: 'claude-test' },
  };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: () => Promise<{ text: string }>,
  ) => Promise<{ text: string }>;

  await turnHook(host, event, async () => ({ text: 'unchanged' }));
  assert.equal(compactCalls, 0);
  const record = triggerRecords(logs)[0];
  assert.equal(record?.decision, 'wait');
  assert.equal(record?.reason, 'semantic_score_below_floor');
  assert.equal(record?.basis, 'semantic');
  assert.equal(record?.score, 0.48);
  assert.equal(typeof record?.floor, 'number');
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_CONVERSATION_CANARY|SEMANTIC_SECRET_CANARY/);
});

for (const mode of ['hint', 'auto'] as const) {
  test(`claude adapter: mode=${mode} compacta exactamente una vez tras una decisión semántica positiva`, async () => {
    const hooks = new Map<string, unknown>();
    register(((pattern: string, hook: unknown) => { hooks.set(pattern, hook); return {}; }) as never, {
      apiKey: 'key',
      triggerMode: mode,
    });
    const logs: string[] = [];
    let compactCalls = 0;
    const host = {
      ui: { log: (text: string) => logs.push(text), toast: () => undefined },
      session: {
        usage: async () => ({ context: { window: 100_000, tokens: 62_000 }, rateLimits: [] }),
        messages: async () => fixture(),
        compact: async () => { compactCalls++; return { messages: [], tokensAfter: 20_000 }; },
      },
      http: { fetch: async () => ({ status: 200, ok: true, text: timingResponse(0.95, 0.95) }) },
      clock: { sleep: async () => new Promise<void>(() => undefined) },
    };
    const event = {
      reason: 'answer', answer: 'done', isAborted: false, durationMs: 1,
      turnId: `positive-${mode}`, usage: { model: 'claude-test' },
    };
    const turnHook = hooks.get('turn.complete') as (
      $: typeof host,
      input: typeof event,
      next: () => Promise<{ text: string }>,
    ) => Promise<{ text: string }>;

    await turnHook(host, event, async () => ({ text: 'unchanged' }));
    assert.equal(compactCalls, 1);
    const completed = triggerRecords(logs).find((record) => record.dispatchOutcome === 'completed');
    assert.equal(completed?.decision, 'compact');
    assert.equal(completed?.reason, 'semantic_score_meets_floor');
    assert.equal(completed?.mode, mode);
    assert.equal(completed?.postContextTokens, 20_000);
    assert.equal(completed?.actualReclaimTokens, 42_000);
    assert.equal(completed?.rearmTokens, 60_000);
  });
}

test('claude adapter: C fuerza compactación sin credenciales ni Jev de timing', async () => {
  const hooks = new Map<string, unknown>();
  register(((pattern: string, hook: unknown) => { hooks.set(pattern, hook); return {}; }) as never, {
    triggerMode: 'auto',
  });
  const logs: string[] = [];
  let credentialCalls = 0;
  let timingCalls = 0;
  let messageCalls = 0;
  let compactCalls = 0;
  const host = {
    ui: { log: (text: string) => logs.push(text), toast: () => undefined },
    session: {
      usage: async () => ({
        context: {
          window: 100_000,
          tokens: 65_000,
          breakdown: { autoCompactThreshold: 90_000 },
        },
        rateLimits: [],
      }),
      messages: async () => { messageCalls++; return fixture(); },
      compact: async () => { compactCalls++; return { messages: [], tokensAfter: 21_000 }; },
    },
    env: { get: async () => { credentialCalls++; return undefined; } },
    settings: { read: async () => { credentialCalls++; return {}; } },
    fs: { read: async () => { credentialCalls++; return ''; } },
    http: { fetch: async () => { timingCalls++; return { status: 500, ok: false, text: '' }; } },
    clock: { sleep: async () => undefined },
  };
  const event = {
    reason: 'answer', answer: 'done', isAborted: false, durationMs: 1,
    turnId: 'ceiling', usage: { model: 'claude-test' },
  };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: () => Promise<{ text: string }>,
  ) => Promise<{ text: string }>;

  await turnHook(host, event, async () => ({ text: 'unchanged' }));
  assert.equal(credentialCalls, 0);
  assert.equal(timingCalls, 0);
  assert.equal(messageCalls, 0);
  assert.equal(compactCalls, 1);
  const record = triggerRecords(logs)[0];
  assert.equal(record?.reason, 'adaptive_ceiling');
  assert.equal(record?.basis, 'ceiling');
  assert.equal(record?.nativeOverflowThreshold, 90_000);
});

test('claude adapter: aplica cooldown, exclusión mutua y rearme', async () => {
  const hooks = new Map<string, unknown>();
  register(((pattern: string, hook: unknown) => { hooks.set(pattern, hook); return {}; }) as never, {
    triggerMode: 'auto',
  });
  const logs: string[] = [];
  let contextTokens = 70_000;
  let usageCalls = 0;
  let compactCalls = 0;
  let resolveFirst: (value: { messages: never[]; tokensAfter: number }) => void = () => undefined;
  const firstCompact = new Promise<{ messages: never[]; tokensAfter: number }>((resolve) => {
    resolveFirst = resolve;
  });
  const host = {
    ui: { log: (text: string) => logs.push(text), toast: () => undefined },
    session: {
      usage: async () => { usageCalls++; return { context: { window: 100_000, tokens: contextTokens }, rateLimits: [] }; },
      compact: async () => {
        compactCalls++;
        if (compactCalls === 1) return firstCompact;
        return { messages: [], tokensAfter: 30_000 };
      },
    },
  };
  const event = (turnId: string) => ({
    reason: 'answer' as const, answer: 'done', isAborted: false, durationMs: 1,
    turnId, usage: { model: 'claude-test' },
  });
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: ReturnType<typeof event>,
    next: () => Promise<{ text: string }>,
  ) => Promise<{ text: string }>;
  const next = async () => ({ text: 'unchanged' });
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const active = turnHook(host, event('first'), next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(compactCalls, 1);
    assert.deepEqual(await turnHook(host, event('concurrent'), next), { text: 'unchanged' });
    assert.equal(usageCalls, 1);
    assert.equal(compactCalls, 1);
    resolveFirst({ messages: [], tokensAfter: 30_000 });
    await active;

    await turnHook(host, event('cooldown'), next);
    assert.equal(compactCalls, 1);
    assert.equal(triggerRecords(logs).at(-1)?.reason, 'cooldown');

    now += 300_001;
    contextTokens = 65_000;
    await turnHook(host, event('rearm-block'), next);
    assert.equal(compactCalls, 1);
    assert.equal(triggerRecords(logs).at(-1)?.reason, 'rearm');
    assert.equal(triggerRecords(logs).at(-1)?.rearmTokens, 70_000);

    contextTokens = 70_000;
    await turnHook(host, event('rearmed'), next);
    assert.equal(compactCalls, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('claude adapter: el hook de compactación ejecuta FastJev una vez por dispatch', async () => {
  const hooks = new Map<string, unknown>();
  register(((pattern: string, hook: unknown) => { hooks.set(pattern, hook); return {}; }) as never, {
    apiKey: 'key',
    triggerMode: 'auto',
    preserveRecentMessages: 0,
    minReductionRatio: 0,
  });
  const logs: string[] = [];
  let fastJevCalls = 0;
  let compactDispatches = 0;
  const host: Record<string, any> = {
    ui: { log: (text: string) => logs.push(text), toast: () => undefined },
    session: {
      usage: async () => ({ context: { window: 100_000, tokens: 65_000 }, rateLimits: [] }),
    },
    http: {
      fetch: async (_url: string, init?: { body?: string }) => {
        fastJevCalls++;
        const request = JSON.parse(init?.body ?? '{}') as { questions?: Record<string, unknown> };
        const answers: Record<string, { noul: number }> = {};
        for (const name of Object.keys(request.questions ?? {})) answers[name] = { noul: 0.9 };
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    },
  };
  const compactHook = hooks.get('session.compact') as (
    $: typeof host,
    input: { messages: ReturnType<typeof asSession> },
    next: (input: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  host.session.compact = async () => {
    compactDispatches++;
    return compactHook(host, { messages: asSession(fixture()) }, async () => ({ skip: 'fallback' }));
  };
  const event = {
    reason: 'answer', answer: 'done', isAborted: false, durationMs: 1,
    turnId: 'fast-jev', usage: { model: 'claude-test' },
  };
  const turnHook = hooks.get('turn.complete') as (
    $: typeof host,
    input: typeof event,
    next: () => Promise<{ text: string }>,
  ) => Promise<{ text: string }>;

  await turnHook(host, event, async () => ({ text: 'unchanged' }));
  assert.equal(compactDispatches, 1);
  assert.equal(fastJevCalls, 1);
  assert.equal(triggerRecords(logs)[0]?.reason, 'adaptive_ceiling');
});
