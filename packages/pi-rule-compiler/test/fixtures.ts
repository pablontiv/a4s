import type {
  ContextEditEntry,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { JevAnswer, JevQuestion, JevRequest } from "../src/types.ts";

export type Pi087ContextEdit = Pick<ContextEditEntry, "type" | "targetId" | "replacement">;

type Pi087Event =
  | { type: "agent_settled" }
  | { type: "session_before_compact"; signal: AbortSignal }
  | { type: "context_with_system"; messages: unknown[] };

type Pi087Handler = (event: Pi087Event, ctx: Pi087Context) => unknown | Promise<unknown>;

interface Pi087Context {
  compact(options?: { customInstructions?: string }): void;
}

export interface Pi087Fake {
  readonly pi: Pick<ExtensionAPI, "on">;
  beforeCompactCalls: number;
  compactCalls: number;
  compactCallsWhileSettling: number;
  nativeFallbackCalls: number;
  emit(event: "agent_settled"): Promise<void>;
  emit(
    event: "session_before_compact",
    payload?: Omit<Extract<Pi087Event, { type: "session_before_compact" }>, "type">,
  ): Promise<unknown>;
  emit(
    event: "context_with_system",
    payload: Omit<Extract<Pi087Event, { type: "context_with_system" }>, "type">,
  ): Promise<{ messages: unknown[] }>;
}

/**
 * Minimal executable model of the Pi 0.87 lifecycle boundary used by the
 * contract tests. `ctx.compact()` called from `agent_settled` is queued until
 * every settled hook has returned, then it traverses `session_before_compact`.
 */
export function createPi087Fake(): Pi087Fake {
  const handlers = new Map<Pi087Event["type"], Pi087Handler[]>();
  const runtime = {
    beforeCompactCalls: 0,
    compactCalls: 0,
    compactCallsWhileSettling: 0,
    nativeFallbackCalls: 0,
  };
  let settling = false;
  const queuedCompactions: Array<() => Promise<void>> = [];

  async function emit(event: "agent_settled"): Promise<void>;
  async function emit(
    event: "session_before_compact",
    payload?: Omit<Extract<Pi087Event, { type: "session_before_compact" }>, "type">,
  ): Promise<unknown>;
  async function emit(
    event: "context_with_system",
    payload: Omit<Extract<Pi087Event, { type: "context_with_system" }>, "type">,
  ): Promise<{ messages: unknown[] }>;
  async function emit(event: Pi087Event["type"], payload?: object): Promise<unknown> {
    const registered = handlers.get(event) ?? [];
    if (event === "agent_settled") {
      settling = true;
      try {
        for (const handler of registered) await handler({ type: event }, context);
      } finally {
        settling = false;
      }
      while (queuedCompactions.length > 0) await queuedCompactions.shift()?.();
      return;
    }
    if (event === "context_with_system") {
      const supplied = payload as Omit<Extract<Pi087Event, { type: "context_with_system" }>, "type">;
      const emitted: Extract<Pi087Event, { type: "context_with_system" }> = { type: event, ...supplied };
      for (const handler of registered) {
        try {
          const result = await handler(emitted, context);
          if (result && typeof result === "object" && "messages" in result) {
            return result as { messages: unknown[] };
          }
        } catch {
          // Pi preserves the supplied context when an optional projection fails.
          return { messages: emitted.messages };
        }
      }
      return { messages: emitted.messages };
    }
    const supplied = payload as Omit<Extract<Pi087Event, { type: "session_before_compact" }>, "type"> | undefined;
    const emitted: Extract<Pi087Event, { type: "session_before_compact" }> = {
      type: event,
      signal: supplied?.signal ?? new AbortController().signal,
    };
    for (const handler of registered) {
      const result = await handler(emitted, context);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  const runCompaction = async (): Promise<void> => {
    runtime.compactCalls += 1;
    const result = await emit("session_before_compact");
    if (result === undefined) runtime.nativeFallbackCalls += 1;
  };
  const context: Pi087Context = {
    compact() {
      if (settling) {
        queuedCompactions.push(runCompaction);
        return;
      }
      runtime.compactCallsWhileSettling += 1;
      void runCompaction();
    },
  };
  const pi = {
    on(event: Pi087Event["type"], handler: Pi087Handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
      return () => {
        const index = registered.indexOf(handler);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  } as unknown as Pick<ExtensionAPI, "on">;
  return Object.assign(runtime, { pi, emit });
}

export function validJevResponse(
  request: JevRequest,
  override?: (id: string, question: JevQuestion) => JevAnswer | undefined,
): Record<string, unknown> {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    answers[id] = override?.(id, question) ?? validAnswer(question);
  }
  return {
    model: request.model,
    answers,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

export function validAnswer(question: JevQuestion): JevAnswer {
  if (question.type === "noul") return { type: "noul", noul: 0.9 };

  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const selected = options[0];
    if (!selected) throw new Error("choice fixture needs an option");
    return {
      type: "choice",
      choice: selected,
      probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])),
      confidence: 1,
    };
  }

  const top = question.criteria.length - 1;
  return {
    type: "score",
    score: top,
    legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])),
    probabilities: Object.fromEntries(question.criteria.map((_criterion, index) => [String(index), index === top ? 1 : 0])),
    confidence: 1,
  };
}

export function choiceAnswer(options: readonly string[], selected: string, confidence = 1): JevAnswer {
  if (!options.includes(selected)) throw new Error("selected choice is absent");
  return {
    type: "choice",
    choice: selected,
    probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])),
    confidence,
  };
}

export function scoreAnswer(criteria: readonly string[], selectedLevel: number, confidence = 1): JevAnswer {
  if (!Number.isInteger(selectedLevel) || selectedLevel < 0 || selectedLevel >= criteria.length) {
    throw new Error("invalid score fixture level");
  }
  return {
    type: "score",
    score: selectedLevel,
    legend: Object.fromEntries(criteria.map((criterion, index) => [String(index), criterion])),
    probabilities: Object.fromEntries(
      criteria.map((_criterion, index) => [String(index), index === selectedLevel ? 1 : 0]),
    ),
    confidence,
  };
}
