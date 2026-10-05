// Part of @a4s/context-expert core (host-neutral Jev compaction).
// Derived from fast-jev-compaction (MIT, Copyright (c) 2025):
//   https://github.com/tamaratran/fast-jev-compaction  — see ../NOTICE
//
// The Jev-decided compaction TRIGGER: the "is this the ideal moment?" question.
// This is the host-neutral analog of pi-context-expert's trigger (trigger.ts
// `evaluateTrigger` + `TRIGGER_QUESTION`, state schema
// `a4s.compaction-trigger-state/v2`): after a local floor gate passes, it asks
// Jev — with a deliberately text-free state — whether compacting now is useful,
// and only reports `compact` when Jev chooses it. A host adapter wires its
// own cheap gates (mode, cooldown, credential, reentrancy) around this.

import type { ChoiceAnswer, ChoiceQuestion, JevAsker, JevState } from './types.js';

/** Default context fill (0..1) below which the trigger never bothers Jev. */
export const DEFAULT_MINIMUM_CONTEXT_RATIO = 0.5;

/**
 * The single trigger question. A `choice` so Jev commits to compact-or-wait
 * (mirrors pi-context-expert's TRIGGER_QUESTION), rather than a bare
 * probability the host would have to threshold itself.
 */
export const TRIGGER_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions: 'After deterministic readiness checks have passed, should the session compact its conversation now?',
  criteria: {
    compact: 'Compaction would usefully summarize the eligible conversation history now.',
    wait: 'The eligible history should remain uncompressed for now.',
  },
};

/** The trigger question name, used as the key in the Jev state and answers. */
export const TRIGGER_QUESTION_NAME = 'compact_now';

/** The deliberately text-free state sent with a trigger request. */
export interface TriggerState {
  schema: 'a4s.compaction-trigger-state/v2';
  contextTokens: number;
  contextWindow: number;
  contextRatio: number;
  minimumContextRatio: number;
}

export type TriggerDecision = 'compact' | 'wait';

/** Builds the text-free trigger state from the host's context-window reading. */
export function buildTriggerState(
  contextTokens: number,
  contextWindow: number,
  minimumContextRatio: number = DEFAULT_MINIMUM_CONTEXT_RATIO,
): TriggerState {
  const window = contextWindow > 0 ? contextWindow : 1;
  return {
    schema: 'a4s.compaction-trigger-state/v2',
    contextTokens,
    contextWindow,
    contextRatio: contextTokens / window,
    minimumContextRatio,
  };
}

/**
 * The local floor gate: do not spend a Jev call until the window is at least
 * `minimumContextRatio` full. Rejects non-finite or non-positive inputs.
 */
export function triggerFloorPasses(
  contextTokens: number,
  contextWindow: number,
  minimumContextRatio: number,
): boolean {
  return (
    Number.isFinite(contextTokens) &&
    contextTokens >= 0 &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    Number.isFinite(minimumContextRatio) &&
    minimumContextRatio > 0 &&
    minimumContextRatio <= 1 &&
    contextTokens / contextWindow >= minimumContextRatio
  );
}

/** Reads the trigger answer; accepts a `choice` or a `noul` probability form. */
function decisionFromAnswer(answer: ChoiceAnswer | { noul: number } | undefined): TriggerDecision {
  if (!answer) return 'wait';
  if ('choice' in answer && typeof answer.choice === 'string') {
    return answer.choice === 'compact' ? 'compact' : 'wait';
  }
  if ('noul' in answer && typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    // Fallback if Jev ever answers the trigger as a probability: >=0.5 compacts.
    return answer.noul >= 0.5 ? 'compact' : 'wait';
  }
  return 'wait';
}

/**
 * Asks Jev whether to compact now. Returns `wait` on any failure or malformed
 * answer, so the trigger is fail-safe: an error never forces a compaction.
 */
export async function evaluateTrigger(asker: JevAsker, state: TriggerState): Promise<TriggerDecision> {
  try {
    const response = await asker.ask(state as unknown as JevState, { [TRIGGER_QUESTION_NAME]: TRIGGER_QUESTION });
    return decisionFromAnswer(response.answers[TRIGGER_QUESTION_NAME] as ChoiceAnswer | undefined);
  } catch {
    return 'wait';
  }
}
