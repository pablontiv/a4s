import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildTriggerState,
  evaluateTrigger,
  TRIGGER_QUESTION_NAME,
  triggerFloorPasses,
} from '../core/index.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../core/index.js';

function askerAnswering(choice: string): { asker: JevAsker; seen: { state?: JevState; questions?: JevQuestions } } {
  const seen: { state?: JevState; questions?: JevQuestions } = {};
  const asker: JevAsker = {
    async ask(state, questions) {
      seen.state = state;
      seen.questions = questions;
      const response: JevResponse = {
        answers: { [TRIGGER_QUESTION_NAME]: { type: 'choice', choice, confidence: 0.9, probabilities: {} } },
      };
      return response;
    },
  };
  return { asker, seen };
}

test('trigger: Jev choosing "compact" yields compact; "wait" yields wait', async () => {
  const state = buildTriggerState(80_000, 100_000, 0.5);
  const { asker: yes, seen } = askerAnswering('compact');
  assert.equal(await evaluateTrigger(yes, state), 'compact');
  // The state is text-free: only the ratio shape, never transcript content.
  assert.deepEqual(seen.state, {
    schema: 'a4s.compaction-trigger-state/v2',
    contextTokens: 80_000,
    contextWindow: 100_000,
    contextRatio: 0.8,
    minimumContextRatio: 0.5,
  });
  const { asker: no } = askerAnswering('wait');
  assert.equal(await evaluateTrigger(no, state), 'wait');
});

test('trigger: a thrown Jev call is fail-safe (wait, never a forced compaction)', async () => {
  const asker: JevAsker = {
    async ask() {
      throw new Error('network down');
    },
  };
  assert.equal(await evaluateTrigger(asker, buildTriggerState(90_000, 100_000, 0.5)), 'wait');
});

test('trigger: the local floor gate holds back Jev until the window is full enough', () => {
  assert.equal(triggerFloorPasses(40_000, 100_000, 0.5), false); // 40% < 50% floor
  assert.equal(triggerFloorPasses(50_000, 100_000, 0.5), true); // exactly at floor
  assert.equal(triggerFloorPasses(90_000, 100_000, 0.5), true);
  assert.equal(triggerFloorPasses(90_000, 0, 0.5), false); // no window
  assert.equal(triggerFloorPasses(Number.NaN, 100_000, 0.5), false);
  assert.equal(triggerFloorPasses(90_000, 100_000, 0), false); // invalid floor
});
