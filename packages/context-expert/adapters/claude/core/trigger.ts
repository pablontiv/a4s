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

import { JevRequestError, type JevRequestErrorCode } from './request.js';
import type { ChoiceQuestion, JevAsker, JevState } from './types.js';

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
export type TriggerDiagnosticCode = JevRequestErrorCode | 'request_failed' | 'invalid_answer';
export type TriggerDiagnosticPhase = 'request' | 'response';

export interface TriggerDiagnostic {
  code: TriggerDiagnosticCode;
  phase: TriggerDiagnosticPhase;
  status?: number;
}

export type TriggerDiagnosticReporter = (diagnostic: TriggerDiagnostic) => void;

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

/** Lee una respuesta válida de tipo `choice` o `noul`. */
function decisionFromAnswer(answer: unknown): TriggerDecision | undefined {
  if (answer === null || typeof answer !== 'object') return undefined;
  if ('choice' in answer) {
    return answer.choice === 'compact' || answer.choice === 'wait' ? answer.choice : undefined;
  }
  if ('noul' in answer && typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    return answer.noul >= 0.5 ? 'compact' : 'wait';
  }
  return undefined;
}

function answerFromResponse(response: unknown): unknown {
  if (response === null || typeof response !== 'object' || !('answers' in response)) return undefined;
  const answers = response.answers;
  if (answers === null || typeof answers !== 'object') return undefined;
  return (answers as Record<string, unknown>)[TRIGGER_QUESTION_NAME];
}

function reportDiagnostic(reporter: TriggerDiagnosticReporter | undefined, diagnostic: TriggerDiagnostic): void {
  try {
    reporter?.(diagnostic);
  } catch {
    // El diagnóstico no cambia la decisión fail-open.
  }
}

/** Consulta a Jev. Un fallo conserva `wait` y emite un diagnóstico seguro. */
export async function evaluateTrigger(
  asker: JevAsker,
  state: TriggerState,
  reporter?: TriggerDiagnosticReporter,
): Promise<TriggerDecision> {
  let response: unknown;
  try {
    response = await asker.ask(state as unknown as JevState, { [TRIGGER_QUESTION_NAME]: TRIGGER_QUESTION });
  } catch (error) {
    if (error instanceof JevRequestError) {
      reportDiagnostic(
        reporter,
        error.status === undefined
          ? { code: error.code, phase: 'response' }
          : { code: error.code, phase: 'response', status: error.status },
      );
    } else {
      reportDiagnostic(reporter, { code: 'request_failed', phase: 'request' });
    }
    return 'wait';
  }

  try {
    const decision = decisionFromAnswer(answerFromResponse(response));
    if (decision) return decision;
  } catch {
    // Una respuesta hostil también es una respuesta inválida.
  }
  reportDiagnostic(reporter, { code: 'invalid_answer', phase: 'response' });
  return 'wait';
}
