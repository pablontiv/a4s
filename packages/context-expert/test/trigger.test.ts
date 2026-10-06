import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildTriggerState,
  evaluateTrigger,
  TRIGGER_QUESTION_NAME,
  triggerFloorPasses,
} from '../core/index.js';
import type {
  JevAsker,
  JevQuestions,
  JevResponse,
  JevState,
  TriggerDecision,
  TriggerDiagnostic,
} from '../core/index.js';

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

test('trigger: conserva la API de decisión por cadena', async () => {
  const state = buildTriggerState(80_000, 100_000, 0.5);
  const { asker: yes, seen } = askerAnswering('compact');
  const compact: TriggerDecision = await evaluateTrigger(yes, state);
  assert.equal(compact, 'compact');
  // El estado omite el contenido del transcript.
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

test('trigger: un fallo conserva wait y emite un diagnóstico seguro', async () => {
  const canary = 'REMOTE_TRIGGER_CONTENT';
  const asker: JevAsker = {
    async ask() {
      throw new Error(canary);
    },
  };
  let diagnostic: TriggerDiagnostic | undefined;
  const decision = await evaluateTrigger(
    asker,
    buildTriggerState(90_000, 100_000, 0.5),
    (value) => {
      diagnostic = value;
    },
  );
  assert.equal(decision, 'wait');
  assert.deepEqual(diagnostic, { code: 'request_failed', phase: 'request' });
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(canary));
});

test('trigger: toda respuesta malformada conserva wait y emite invalid_answer', async () => {
  const responses: unknown[] = [
    7,
    null,
    {},
    { answers: null },
    { answers: {} },
    { answers: { [TRIGGER_QUESTION_NAME]: 'texto' } },
    { answers: { [TRIGGER_QUESTION_NAME]: { choice: 'otro' } } },
    { answers: { [TRIGGER_QUESTION_NAME]: { noul: Number.NaN } } },
  ];

  for (const response of responses) {
    const asker: JevAsker = { async ask() { return response as never; } };
    let diagnostic: TriggerDiagnostic | undefined;
    const decision = await evaluateTrigger(
      asker,
      buildTriggerState(90_000, 100_000, 0.5),
      (value) => {
        diagnostic = value;
      },
    );
    assert.equal(decision, 'wait');
    assert.deepEqual(diagnostic, { code: 'invalid_answer', phase: 'response' });
  }
});

test('trigger: the local floor gate holds back Jev until the window is full enough', () => {
  assert.equal(triggerFloorPasses(40_000, 100_000, 0.5), false); // 40% < 50% floor
  assert.equal(triggerFloorPasses(50_000, 100_000, 0.5), true); // exactly at floor
  assert.equal(triggerFloorPasses(90_000, 100_000, 0.5), true);
  assert.equal(triggerFloorPasses(90_000, 0, 0.5), false); // no window
  assert.equal(triggerFloorPasses(Number.NaN, 100_000, 0.5), false);
  assert.equal(triggerFloorPasses(90_000, 100_000, 0), false); // invalid floor
});
