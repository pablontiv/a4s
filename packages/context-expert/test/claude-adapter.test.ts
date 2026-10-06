import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCompaction } from '../core/index.js';
import type { JevAsker, Message } from '../core/index.js';
import { claudeBinding, register, toSessionMessages } from '../adapters/claude/hooks/register.js';

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
      usage: async () => ({ context: { window: 100_000, tokens: 90_000 }, rateLimits: [] }),
      compact: async () => ({}),
    },
    http: {
      fetch: async () => ({ status: 503, ok: false, text: bodyCanary }),
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
  assert.deepEqual(logs, [
    '[context-expert] diagnostic phase=trigger_response code=http_status status=503',
  ]);
  assert.doesNotMatch(logs.join('\n'), /REMOTE_HTTP_BODY_CANARY|TOKEN_CANARY|TURN_CONTENT_CANARY/);
});
