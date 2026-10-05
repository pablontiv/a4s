import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCompaction } from '../core/index.js';
import type { JevAsker, Message } from '../core/index.js';
import { claudeBinding, toSessionMessages } from '../hooks/register.js';

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
