import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compact, reductionRatio } from '@a4s/context-management';
import type { JevAsker, Message } from '@a4s/context-management';

/** Eight messages: one task prompt, three tool call/result pairs, one closing note. */
function fixture(): Message[] {
  const longResult = 'RESULT '.repeat(100); // ~700 chars, well over the truncate floor
  return [
    { role: 'user', text: 'start the task', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u_a', tool: 'Read', input: { path: 'a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u_a', text: longResult }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u_b', tool: 'Bash', input: { cmd: 'ls' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u_b', text: 'a.ts b.ts' }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u_c', tool: 'Read', input: { path: 'important.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u_c', text: 'required implementation details' }] },
    { role: 'assistant', text: 'done', toolUses: [] },
  ];
}

/** Deterministic scores: truncate t1's result, drop t2, keep t3 verbatim. */
const asker: JevAsker = {
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(questions)) {
      answers[key] = { noul: key === 'call_t1' || key.endsWith('_t3') ? 0.9 : 0.1 };
    }
    return { answers };
  },
};

test('core: Jev scores drive keep/truncate/drop per tool call', async () => {
  const messages = fixture();
  const result = await compact(messages, asker, { preserveRecentMessages: 0, truncateHeadChars: 50 });

  assert.equal(result.decisions.length, 3, 'three candidate calls scored');
  const byId = new Map(result.decisions.map((d) => [d.id, d]));
  assert.equal(byId.get('t1')?.action, 'drop_result', 't1 result truncated, call kept');
  assert.equal(byId.get('t2')?.action, 'drop_call', 't2 removed entirely');
  assert.equal(byId.get('t3')?.action, 'keep', 't3 call and result kept');
  assert.equal(result.messages[1], messages[1], 'truncated result retains the call object');
  const truncated = result.messages[2]?.toolResults?.[0]?.text ?? '';
  assert.ok(truncated.startsWith('RESULT '.repeat(100).slice(0, 50)));
  assert.ok(truncated.length < (messages[2]?.toolResults?.[0]?.text.length ?? 0));
  assert.equal(result.messages[3], messages[5], 'kept call remains verbatim');
  assert.equal(result.messages[4], messages[6], 'kept result remains verbatim');

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
  assert.deepEqual(result.messages, messages);
  assert.ok(result.messages.every((message, index) => message === messages[index]));
  assert.equal(reductionRatio(result), 0);
});
