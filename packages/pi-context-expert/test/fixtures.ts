import type {
  AgentSettledEvent,
  ContextEventResult,
  ContextWithSystemEvent,
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import type { JevAnswer, JevQuestion, JevRequest } from "../src/types.ts";

type CompatiblePiContext = Pick<ExtensionContext, "compact">;
type CompatiblePiHandler<Event, Result = undefined> = (
  event: Parameters<ExtensionHandler<Event, Result>>[0],
  ctx: CompatiblePiContext,
) => ReturnType<ExtensionHandler<Event, Result>>;
type CompatiblePiOnArgs =
  | [event: "agent_settled", handler: CompatiblePiHandler<AgentSettledEvent>]
  | [
    event: "session_before_compact",
    handler: CompatiblePiHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
  ]
  | [
    event: "context_with_system",
    handler: CompatiblePiHandler<ContextWithSystemEvent, ContextEventResult>,
  ];
type CompatiblePiEmitArgs =
  | [event: "agent_settled"]
  | [event: "session_before_compact"]
  | [event: "context_with_system", payload: Pick<ContextWithSystemEvent, "messages">];

interface CompatiblePiFakeAPI {
  on(event: "agent_settled", handler: CompatiblePiHandler<AgentSettledEvent>): () => void;
  on(
    event: "session_before_compact",
    handler: CompatiblePiHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
  ): () => void;
  on(
    event: "context_with_system",
    handler: CompatiblePiHandler<ContextWithSystemEvent, ContextEventResult>,
  ): () => void;
}

export interface CompatiblePiFake {
  readonly pi: CompatiblePiFakeAPI;
  beforeCompactCalls: number;
  compactCalls: number;
  compactCallsWhileSettling: number;
  nativeFallbackCalls: number;
  emit(event: "agent_settled"): Promise<void>;
  emit(event: "session_before_compact"): Promise<SessionBeforeCompactResult | undefined>;
  emit(
    event: "context_with_system",
    payload: Pick<ContextWithSystemEvent, "messages">,
  ): Promise<ContextEventResult>;
}

/**
 * Minimal executable model of the supported Pi lifecycle boundary used by the
 * compatibility contract tests. `ctx.compact()` called from `agent_settled` is
 * queued until every settled hook has returned, then it traverses
 * `session_before_compact`.
 */
export function createCompatiblePiFake(): CompatiblePiFake {
  const settledHandlers: CompatiblePiHandler<AgentSettledEvent>[] = [];
  const beforeCompactHandlers: CompatiblePiHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>[] = [];
  const contextWithSystemHandlers: CompatiblePiHandler<ContextWithSystemEvent, ContextEventResult>[] = [];
  const runtime = {
    beforeCompactCalls: 0,
    compactCalls: 0,
    compactCallsWhileSettling: 0,
    nativeFallbackCalls: 0,
  };
  let settling = false;
  const queuedCompactions: Array<() => Promise<void>> = [];

  function on(...args: CompatiblePiOnArgs): () => void {
    const [event, handler] = args;
    switch (event) {
      case "agent_settled":
        settledHandlers.push(handler);
        return removeHandler(settledHandlers, handler);
      case "session_before_compact":
        beforeCompactHandlers.push(handler);
        return removeHandler(beforeCompactHandlers, handler);
      case "context_with_system":
        contextWithSystemHandlers.push(handler);
        return removeHandler(contextWithSystemHandlers, handler);
    }
  }
  const pi: CompatiblePiFakeAPI = { on };

  async function emit(event: "agent_settled"): Promise<void>;
  async function emit(event: "session_before_compact"): Promise<SessionBeforeCompactResult | undefined>;
  async function emit(
    event: "context_with_system",
    payload: Pick<ContextWithSystemEvent, "messages">,
  ): Promise<ContextEventResult>;
  async function emit(...args: CompatiblePiEmitArgs): Promise<void | SessionBeforeCompactResult | undefined | ContextEventResult> {
    const [event] = args;
    switch (event) {
      case "agent_settled":
        settling = true;
        try {
          for (const handler of settledHandlers) await handler({ type: "agent_settled" }, context);
        } finally {
          settling = false;
        }
        while (queuedCompactions.length > 0) {
          const next = queuedCompactions.shift();
          if (next) await next();
        }
        return;
      case "session_before_compact": {
        const emitted = createSessionBeforeCompactEvent();
        for (const handler of beforeCompactHandlers) {
          const result = await handler(emitted, context);
          if (result !== undefined) return result;
        }
        return undefined;
      }
      case "context_with_system": {
        const [, payload] = args;
        const emitted: ContextWithSystemEvent = { type: "context_with_system", messages: payload.messages };
        for (const handler of contextWithSystemHandlers) {
          try {
            const result = await handler(emitted, context);
            if (result !== undefined) return result;
          } catch {
            // Pi preserves the supplied context when an optional projection fails.
            return { messages: emitted.messages };
          }
        }
        return { messages: emitted.messages };
      }
    }
  }

  const runCompaction = async (): Promise<void> => {
    runtime.compactCalls += 1;
    const result = await emit("session_before_compact");
    if (result === undefined) runtime.nativeFallbackCalls += 1;
  };
  const context: CompatiblePiContext = {
    compact() {
      if (settling) {
        queuedCompactions.push(runCompaction);
        return;
      }
      runtime.compactCallsWhileSettling += 1;
      void runCompaction();
    },
  };
  return Object.assign(runtime, { pi, emit });
}

function createSessionBeforeCompactEvent(): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 0,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function removeHandler<Handler>(handlers: Handler[], handler: Handler): () => void {
  return () => {
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
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
