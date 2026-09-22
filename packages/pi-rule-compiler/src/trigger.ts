import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateJevResponse } from "./jev.ts";
import { DEFAULT_JEV_MODEL, type JevClient, type JevRequest, type TriggerDecision, type TriggerMode } from "./types.ts";

export interface TriggerInput {
  mode: TriggerMode;
  interactive: boolean;
  idle: boolean;
  contextTokens: number;
  minimumContextTokens: number;
  hasPendingWork: boolean;
  cooldownActive: boolean;
  editorHasText: boolean;
  credentialAvailable: boolean;
  autoAcknowledged: boolean;
  jevClient: JevClient;
  signal: AbortSignal;
}

const TRIGGER_QUESTION = {
  type: "choice" as const,
  instructions: "Should Pi compact now based only on the current context-token count?",
  criteria: {
    compact: "The context is large enough that compaction should start now.",
    wait: "Compaction is not needed yet.",
  },
};

/** Evaluates local safety gates before making a deliberately text-free Jev request. */
export async function evaluateTrigger(input: TriggerInput): Promise<TriggerDecision> {
  if (!localTriggerGatesPass(input)) return { action: "none" };

  const request: JevRequest = {
    model: DEFAULT_JEV_MODEL,
    state: {
      schema: "a4s.compaction-trigger-state/v1",
      contextTokens: input.contextTokens,
      minimumContextTokens: input.minimumContextTokens,
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
    Number.isFinite(input.minimumContextTokens) &&
    input.minimumContextTokens > 0 &&
    input.contextTokens >= input.minimumContextTokens &&
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
