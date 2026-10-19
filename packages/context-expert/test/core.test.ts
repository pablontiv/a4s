import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compact, reductionRatio } from '../core/index.js';
import type { JevAsker, Message } from '../core/index.js';

/** Six messages: one task prompt, two tool call/result pairs, one closing note. */
function fixture(): Message[] {
  const longResult = 'RESULT '.repeat(100); // ~700 chars, well over the truncate floor
  return [
    { role: 'user', text: 'start the task', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u_a', tool: 'Read', input: { path: 'a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u_a', text: longResult }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u_b', tool: 'Bash', input: { cmd: 'ls' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u_b', text: 'a.ts b.ts' }] },
    { role: 'assistant', text: 'done', toolUses: [] },
  ];
}

/** Deterministic asker: call t1 stays but its result does not; t2 goes entirely. */
const asker: JevAsker = {
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(questions)) answers[key] = { noul: key === 'call_t1' ? 0.9 : 0.1 };
    return { answers };
  },
};

test('core: Jev scores drive keep/truncate/drop per tool call', async () => {
  const messages = fixture();
  const result = await compact(messages, asker, { preserveRecentMessages: 0, truncateHeadChars: 50 });

  assert.equal(result.decisions.length, 2, 'two candidate calls scored');
  const byId = new Map(result.decisions.map((d) => [d.id, d]));
  assert.equal(byId.get('t1')?.action, 'drop_result', 't1 result truncated, call kept');
  assert.equal(byId.get('t2')?.action, 'drop_call', 't2 removed entirely');

  // t2's call+result messages collapse; t1's result is truncated in place.
  assert.ok(result.stats.messagesAfter < result.stats.messagesBefore, 'transcript shrank');
  assert.ok(reductionRatio(result) > 0, 'positive char reduction');
});

test('core: the first message is always pinned and kept verbatim', async () => {
  const messages = fixture();
  const result = await compact(messages, asker, { preserveRecentMessages: 0, truncateHeadChars: 50 });
  assert.equal(result.messages[0], messages[0], 'message 0 is the same object (kept verbatim)');
});

test('core: a classifier that keeps everything makes no change', async () => {
  const keepAll: JevAsker = {
    async ask(_state, questions) {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { noul: 1 };
      return { answers };
    },
  };
  const messages = fixture();
  const result = await compact(messages, keepAll, { preserveRecentMessages: 0 });
  assert.equal(result.stats.messagesAfter, result.stats.messagesBefore, 'nothing dropped');
  assert.equal(result.stats.callsDropped, 0);
  assert.equal(result.stats.resultsDropped, 0);
});
