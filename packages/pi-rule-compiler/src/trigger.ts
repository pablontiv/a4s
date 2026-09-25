import { estimateTokens, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateJevResponse } from "./jev.ts";
import { DEFAULT_JEV_MODEL, type JevClient, type JevRequest, type TriggerDecision, type TriggerMode } from "./types.ts";

export interface TriggerInput {
  mode: TriggerMode;
  interactive: boolean;
  idle: boolean;
  contextTokens: number;
  contextWindow: number;
  minimumContextRatio: number;
  compactableHistory: boolean;
  hasPendingWork: boolean;
  cooldownActive: boolean;
  editorHasText: boolean;
  credentialAvailable: boolean;
  autoAcknowledged: boolean;
  jevClient: JevClient;
  signal: AbortSignal;
}

type CompactableMessage = Parameters<typeof estimateTokens>[0];

export interface TriggerProjectionEntry {
  sourceType: string;
  messages: readonly CompactableMessage[];
}

const TRIGGER_QUESTION = {
  type: "choice" as const,
  instructions: "Should Pi compact now after deterministic readiness checks have passed?",
  criteria: {
    compact: "Compaction would usefully summarize the eligible conversation history now.",
    wait: "The eligible history should remain uncompressed for now.",
  },
};

function startsConversationTurn(entry: TriggerProjectionEntry): boolean {
  if (entry.sourceType === "compaction") return false;
  return entry.messages.some((message) =>
    message.role === "user" ||
    message.role === "bashExecution" ||
    message.role === "custom" ||
    message.role === "branchSummary" ||
    message.role === "compactionSummary"
  );
}

/**
 * Conservative readiness proof: after Pi keeps its configured recent tail,
 * at least one complete older turn must remain available for summarization.
 */
export function hasConservativeCompactableHistory(
  entries: readonly TriggerProjectionEntry[],
  keepRecentTokens: number,
  branchTipIsCompaction: boolean,
): boolean {
  if (branchTipIsCompaction || !Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 0) return false;

  const previousCompactionIndex = entries.findIndex(
    (entry) => entry.sourceType === "compaction" && entry.messages.length > 0,
  );
  const boundaryStart = previousCompactionIndex >= 0 ? previousCompactionIndex + 1 : 0;
  const activeEntries = entries.slice(boundaryStart);
  const turnStarts = activeEntries
    .map((entry, index) => startsConversationTurn(entry) ? index : -1)
    .filter((index) => index >= 0);
  if (turnStarts.length < 2) return false;

  const recentTailTokens = activeEntries
    .slice(turnStarts[1])
    .flatMap((entry) => entry.messages)
    .filter((message) => message.role !== "system")
    .reduce((total, message) => total + estimateTokens(message), 0);
  return recentTailTokens >= keepRecentTokens;
}

/** Evaluates local safety gates before making a deliberately text-free Jev request. */
export async function evaluateTrigger(input: TriggerInput): Promise<TriggerDecision> {
  if (!localTriggerGatesPass(input)) return { action: "none" };

  const request: JevRequest = {
    model: DEFAULT_JEV_MODEL,
    state: {
      schema: "a4s.compaction-trigger-state/v2",
      contextTokens: input.contextTokens,
      contextWindow: input.contextWindow,
      contextRatio: input.contextTokens / input.contextWindow,
      minimumContextRatio: input.minimumContextRatio,
      compactableHistory: input.compactableHistory,
    },
    questions: { compact_now: TRIGGER_QUESTION },
  };
  try {
    const response = validateJevResponse(
      await input.jevClient.evaluate(request, { signal: input.signal }),
      request.questions,
    );
    if (response.answers.compact_now?.type !== "choice" || response.answers.compact_now.choice !== "compact") {
      return { action: "none" };
    }
  } catch {
    return { action: "none" };
  }

  return input.mode === "auto"
    ? { action: "compact" }
    : { action: "hint", reason: "Jev recommends compaction" };
}

export function localTriggerGatesPass(input: Omit<TriggerInput, "jevClient" | "signal">): boolean {
  return (
    input.mode !== "off" &&
    input.interactive &&
    input.idle &&
    Number.isFinite(input.contextTokens) &&
    input.contextTokens >= 0 &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0 &&
    Number.isFinite(input.minimumContextRatio) &&
    input.minimumContextRatio > 0 &&
    input.minimumContextRatio <= 1 &&
    input.contextTokens / input.contextWindow >= input.minimumContextRatio &&
    input.compactableHistory &&
    !input.hasPendingWork &&
    !input.cooldownActive &&
    !input.editorHasText &&
    input.credentialAvailable &&
    (input.mode !== "auto" || input.autoAcknowledged)
  );
}

/** The trigger owns no compaction implementation; Pi's normal lifecycle remains authoritative. */
export async function applyTriggerDecision(decision: TriggerDecision, ctx: ExtensionContext): Promise<void> {
  if (decision.action === "hint") ctx.ui.notify(`Compaction suggested: ${decision.reason}`, "info");
  if (decision.action === "compact") await ctx.compact();
}
