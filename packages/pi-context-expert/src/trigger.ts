import { estimateTokens, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Message,
  type ToolUse,
  type TriggerDecision,
} from "@a4s/context-expert";
import { toNeutralPiMessages } from "./binding.ts";
import type { TriggerMode } from "./types.ts";

export {
  buildRecentConversation,
  buildTriggerState,
  evaluateTrigger,
  evaluateTriggerPolicy,
  triggerFloorPasses,
  triggerThresholds,
  type TriggerPolicyDecision,
} from "@a4s/context-expert";

export interface PiTriggerGateInput {
  mode: TriggerMode;
  interactive: boolean;
  idle: boolean;
  compactableHistory: boolean;
  hasPendingWork: boolean;
  cooldownActive: boolean;
  editorHasText: boolean;
}

type CompactableMessage = Parameters<typeof estimateTokens>[0];

export interface TriggerProjectionEntry {
  sourceType: string;
  messages: readonly CompactableMessage[];
}

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

/** Proves that Pi can summarize one complete older turn after it retains its recent tail. */
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

/** Applies only Pi lifecycle gates. The shared core owns the ratio floor and semantic decision. */
export function localTriggerGatesPass(input: PiTriggerGateInput): boolean {
  return (
    input.mode !== "off" &&
    input.interactive &&
    input.idle &&
    input.compactableHistory &&
    !input.hasPendingWork &&
    !input.cooldownActive &&
    !input.editorHasText
  );
}

/** Converts real Pi messages and associates each sanitized tool result with its tool call. */
export function toTriggerMessages(agentMessages: readonly unknown[]): Message[] {
  const messages = toNeutralPiMessages(agentMessages).map((message) => ({
    ...message,
    toolUses: message.toolUses.map((tool) => ({ ...tool })),
    ...(message.toolResults === undefined
      ? {}
      : { toolResults: message.toolResults.map((result) => ({ ...result })) }),
  }));
  const calls = new Map<string, ToolUse>();
  for (const message of messages) {
    for (const tool of message.toolUses) calls.set(tool.tool_use_id, tool);
    for (const result of message.toolResults ?? []) {
      const call = calls.get(result.tool_use_id);
      if (!call) continue;
      call.text = result.text;
      call.isError = result.isError === true;
    }
  }
  return messages;
}

/** Applies a positive decision. Hint notifies and returns. Auto enters Pi's compaction lifecycle. */
export async function applyTriggerDecision(
  decision: TriggerDecision,
  mode: Exclude<TriggerMode, "off">,
  ctx: ExtensionContext,
  options?: Parameters<ExtensionContext["compact"]>[0],
): Promise<"hinted" | "failed" | undefined> {
  if (decision === "wait") return undefined;
  if (mode === "hint") {
    try {
      ctx.ui.notify("Context Expert recommends compaction. Run /compact when you are ready.", "info");
      return "hinted";
    } catch {
      // Hint delivery is best-effort and must never start automatic compaction.
      return "failed";
    }
  }
  ctx.compact(options);
  return undefined;
}
