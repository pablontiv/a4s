import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JevAsker, Message } from '../core/index.js';
import { compactForPi } from '../adapters/pi/adapter.js';

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

test('pi adapter: the SAME core decisions assemble into a Pi string-summary', async () => {
  const { result, output } = await compactForPi(fixture(), asker, {
    preserveRecentMessages: 0,
    truncateHeadChars: 50,
  });

  // Pi's contract returns a summary STRING (not a message array) — the key
  // difference from Claude, served by the identical core result.
  assert.equal(typeof output.summary, 'string');
  assert.match(output.summary, /Jev-authoritative compaction \(Pi\)/);
  assert.match(output.summary, /drop_call/, 'dropped call recorded in the summary');
  assert.equal(output.keptMessages, result.stats.messagesAfter, 'kept count matches core stats');
  assert.ok(result.stats.messagesAfter < result.stats.messagesBefore, 'core shrank the transcript');
});
