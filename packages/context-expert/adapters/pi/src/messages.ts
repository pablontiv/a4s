import { stableDigest, stableJson } from "./digest.ts";
import { redactPrivateData } from "./redaction.ts";
import type { JsonValue, NormalizedSessionMessage } from "./types.ts";

export interface CompactionPreparationMessages {
  previousSummary?: string;
  messagesToSummarize: readonly unknown[];
  turnPrefixMessages: readonly unknown[];
}

export function normalizeSessionMessages(
  messages: readonly unknown[],
  startingIndex = 0,
): NormalizedSessionMessage[] {
  return messages.map((message, offset) => normalizeSessionMessage(message, startingIndex + offset));
}

export function normalizeCompactionMessages(
  preparation: CompactionPreparationMessages,
): NormalizedSessionMessage[] {
  const coherentMessages: unknown[] = [];
  if (preparation.previousSummary?.trim()) {
    coherentMessages.push({ role: "compactionSummary", summary: preparation.previousSummary });
  }
  coherentMessages.push(...preparation.messagesToSummarize, ...preparation.turnPrefixMessages);
  return normalizeSessionMessages(coherentMessages);
}

export function digestNormalizedMessages(messages: readonly NormalizedSessionMessage[]): string {
  return stableDigest(
    messages.map((message) => ({
      index: message.index,
      role: message.role,
      text: message.text,
    })),
  );
}

function normalizeSessionMessage(message: unknown, index: number): NormalizedSessionMessage {
  const record = asRecord(message);
  const role = normalizeRole(record?.role);
  const rawText = extractMessageText(role, record);
  const redacted = redactPrivateData(rawText);
  const sourceDigest = stableDigest({ role, text: redacted.text });

  return {
    index,
    role,
    text: redacted.text,
    sourceDigest,
    redactionCount: redacted.redactionCount,
  };
}

function normalizeRole(role: unknown): string {
  if (typeof role !== "string") return "unknown";
  switch (role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return role;
    default:
      return "unknown";
  }
}

function extractMessageText(role: string, record: Record<string, unknown> | undefined): string {
  if (!record) return "[unsupported message omitted]";

  switch (role) {
    case "assistant":
      return extractContent(record.content, { includeToolCalls: true });
    case "toolResult": {
      const name = safeLabel(record.toolName, "tool");
      return `[tool result: ${name}]\n${extractContent(record.content)}`;
    }
    case "bashExecution": {
      const command = typeof record.command === "string" ? record.command : "";
      const output = typeof record.output === "string" ? record.output : "";
      const exitCode = typeof record.exitCode === "number" ? String(record.exitCode) : "unknown";
      return `[bash command]\n${command}\n[bash output; exit=${exitCode}]\n${output}`;
    }
    case "custom": {
      const customType = safeLabel(record.customType, "custom");
      return `[custom message: ${customType}]\n${extractContent(record.content)}`;
    }
    case "branchSummary":
    case "compactionSummary":
      return typeof record.summary === "string" ? record.summary : "[empty summary]";
    default:
      return extractContent(record.content);
  }
}

function extractContent(content: unknown, options: { includeToolCalls?: boolean } = {}): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "[unsupported content omitted]";

  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record || typeof record.type !== "string") {
      parts.push("[unsupported content omitted]");
      continue;
    }

    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }

    if (record.type === "image") {
      const mimeType = safeLabel(record.mimeType, "unknown");
      parts.push(`[image omitted: ${mimeType}]`);
      continue;
    }

    if (record.type === "thinking") {
      continue;
    }

    if (record.type === "toolCall" && options.includeToolCalls) {
      const name = safeLabel(record.name, "tool");
      const args = toJsonValue(record.arguments ?? {});
      parts.push(`[tool call: ${name}] ${stableJson(args)}`);
      continue;
    }

    parts.push(`[${safeLabel(record.type, "unsupported")} content omitted]`);
  }

  return parts.join("\n");
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.replaceAll(/[\r\n\t]/g, " ").slice(0, 80);
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) return "[nested value omitted]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item, depth + 1));
  const record = asRecord(value);
  if (!record) return String(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, toJsonValue(item, depth + 1)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
