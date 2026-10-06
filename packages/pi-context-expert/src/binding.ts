import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  runCompaction,
  type CompactOptions,
  type CompactResult,
  type HostBinding,
  type JevAsker,
  type JevResponse,
  type Message,
  type ToolResult,
  type ToolUse,
} from "@a4s/context-expert";
import { stableDigest } from "./digest.ts";
import { validateJevResponse } from "./jev.ts";
import { redactPrivateData } from "./redaction.ts";
import { truncateExcerpt } from "./state.ts";
import {
  DEFAULT_JEV_MODEL,
  type CoreCompactionDetails,
  type JevClient,
  type JevCompactionResult,
  type JevQuestion,
  type JevRequest,
  type PersistedCoreCallDecision,
} from "./types.ts";

export const CORE_DETAILS_KEY = "fastJev";
export const CORE_DETAILS_VERSION = 1;
export const DEFAULT_MAX_COMPACTION_CHARS = 160_000;
export const DEFAULT_MINIMUM_COMPACTION_EXCERPT_CHARS = 24;

export class PiCompactionBuildError extends Error {
  constructor() {
    super("compaction summary or persisted details cannot fit the configured limit");
    this.name = "PiCompactionBuildError";
  }
}

export interface PreviousCoreCompaction {
  messages?: Message[];
  summaryText?: string;
  readFiles: string[];
  modifiedFiles: string[];
}

export interface PiCompactionBindingInput {
  attemptId: string;
  sourceDigest: string;
  createdAt: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  previous?: PreviousCoreCompaction;
  fileOps?: unknown;
  maxSummaryChars?: number;
  minimumSummaryExcerptChars?: number;
}

export interface CompactionPreparationProtection {
  turnPrefixMessages: readonly unknown[];
}

interface AssistantBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

export function piContentToText(content: unknown): string {
  if (typeof content === "string") return redactPrivateData(content).text;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(redactPrivateData(part).text);
      continue;
    }
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    parts.push(redactPrivateData(part.text).text);
  }
  return parts.join("\n");
}

/** Converts real Pi messages to the host-neutral transcript used by the shared core. */
export function toNeutralPiMessages(agentMessages: readonly unknown[]): Message[] {
  const converted = convertToLlm(agentMessages as never) ?? [];
  const messages: Message[] = [];
  for (const message of converted) {
    if (message.role === "user") {
      messages.push({ role: "user", text: piContentToText(message.content), toolUses: [] });
      continue;
    }
    if (message.role === "assistant") {
      const text: string[] = [];
      const toolUses: ToolUse[] = [];
      for (const candidate of (message.content ?? []) as AssistantBlock[]) {
        if (!candidate || typeof candidate !== "object") continue;
        if (candidate.type === "text" && typeof candidate.text === "string") {
          text.push(redactPrivateData(candidate.text).text);
          continue;
        }
        if (candidate.type !== "toolCall" || typeof candidate.id !== "string" || typeof candidate.name !== "string") {
          continue;
        }
        toolUses.push({
          tool_use_id: candidate.id,
          tool: safeLabel(candidate.name, "tool"),
          input: safeInput(candidate.arguments),
        });
      }
      messages.push({ role: "assistant", text: text.join("\n"), toolUses });
      continue;
    }
    if (message.role === "toolResult") {
      const toolResults: ToolResult[] = [{
        tool_use_id: typeof message.toolCallId === "string" ? message.toolCallId : "",
        text: piContentToText(message.content),
        isError: message.isError === true,
      }];
      messages.push({ role: "user", text: "", toolUses: [], toolResults });
    }
  }
  return messages;
}

/** Protects every converted split-turn prefix message. Pi keeps the canonical recent tail outside the summarized span. */
export function coreOptionsForPreparation(
  preparation: CompactionPreparationProtection,
  options: CompactOptions = {},
): CompactOptions {
  return {
    ...options,
    preserveRecentMessages: toNeutralPiMessages(preparation.turnPrefixMessages).length,
  };
}

export function renderCoreSummary(messages: readonly Message[]): string {
  const blocks: string[] = [];
  let shown = 0;
  for (const message of messages) {
    const results = message.toolResults ?? [];
    if (message.text.trim().length === 0 && message.toolUses.length === 0 && results.length === 0) continue;
    shown += 1;
    const label = results.length > 0 && message.toolUses.length === 0
      ? results.length === 1 ? "tool result" : "tool results"
      : message.role;
    const lines = [`--- [${shown}] ${label} ---`];
    if (message.text.trim().length > 0) lines.push(message.text);
    for (const call of message.toolUses) {
      lines.push("", `[tool call ${call.tool}] ${safeJson(call.input)}`);
    }
    for (const result of results) {
      lines.push("", `[tool result ${result.tool_use_id}${result.isError ? "; error" : ""}]`);
      lines.push(result.text.length > 0 ? result.text : "(empty result)");
    }
    blocks.push(lines.join("\n"));
  }
  const body = blocks.length > 0 ? blocks.join("\n\n") : "(no messages)";
  return [
    '<compacted-conversation engine="a4s-context-expert">',
    "The block below replaces the earlier conversation.",
    "It preserves sanitized user and assistant text in chronological order.",
    "It removes stale tool calls and truncates stale tool results according to the shared core decisions.",
    "Re-run a tool when its full result is required.",
    "",
    body,
    "</compacted-conversation>",
  ].join("\n");
}

export function findPreviousCoreCompaction(branchEntries: readonly unknown[]): PreviousCoreCompaction | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (!isRecord(entry) || entry.type !== "compaction") continue;
    const details = isRecord(entry.details) ? entry.details : undefined;
    const readFiles = stringList(details?.readFiles);
    const modifiedFiles = stringList(details?.modifiedFiles);
    const current = details?.[CORE_DETAILS_KEY];
    if (isStoredCoreDetails(current)) return { messages: current.messages, readFiles, modifiedFiles };
    return {
      summaryText: typeof entry.summary === "string" ? entry.summary : "",
      readFiles,
      modifiedFiles,
    };
  }
  return undefined;
}

export function buildCoreTranscript(
  previous: PreviousCoreCompaction | undefined,
  currentMessages: readonly unknown[],
): unknown[] {
  const base: unknown[] = [];
  if (previous?.messages) base.push(...previous.messages.flatMap(neutralToPiMessages));
  else if (previous?.summaryText?.trim()) {
    base.push({ role: "user", content: `[Previous compaction summary]\n\n${previous.summaryText}` });
  }
  return [...base, ...currentMessages];
}

export function createCoreAsker(client: JevClient, signal: AbortSignal): JevAsker {
  return {
    async ask(state, questions) {
      if (typeof state === "string") throw new TypeError("shared core state must be structured");
      const nativeQuestions: Record<string, JevQuestion> = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "noul") {
          nativeQuestions[id] = { type: "noul", instructions: question.instructions };
        } else if (question.type === "choice") {
          nativeQuestions[id] = question;
        } else {
          nativeQuestions[id] = { type: "score", instructions: question.instructions, criteria: question.criteria };
        }
      }
      const request: JevRequest = { state, model: DEFAULT_JEV_MODEL, questions: nativeQuestions };
      const raw = await client.evaluate(request, { signal });
      const validated = validateJevResponse(raw, nativeQuestions);
      return validated as unknown as JevResponse;
    },
  };
}

export function createPiCompactionBinding(
  input: PiCompactionBindingInput,
): HostBinding<unknown, JevCompactionResult> {
  return {
    toNeutral: toNeutralPiMessages,
    assemble(_host, result) {
      return fitCompactionOutput(result, input);
    },
  };
}

export async function runPiCoreCompaction(
  hostMessages: readonly unknown[],
  input: PiCompactionBindingInput,
  client: JevClient,
  signal: AbortSignal,
  options: CompactOptions,
): Promise<{ result: CompactResult; output: JevCompactionResult }> {
  return runCompaction(
    hostMessages,
    createPiCompactionBinding(input),
    createCoreAsker(client, signal),
    options,
  );
}

interface BoundedOutput {
  output: JevCompactionResult;
  detailsChars: number;
}

function fitCompactionOutput(
  result: CompactResult,
  input: PiCompactionBindingInput,
): JevCompactionResult {
  const maximumChars = positiveInteger(
    input.maxSummaryChars ?? DEFAULT_MAX_COMPACTION_CHARS,
    "maxSummaryChars",
  );
  const minimumExcerptChars = positiveInteger(
    input.minimumSummaryExcerptChars ?? DEFAULT_MINIMUM_COMPACTION_EXCERPT_CHARS,
    "minimumSummaryExcerptChars",
  );
  const decisions = result.decisions.map(persistDecision);
  const files = computeFileLists(input.previous, input.fileOps);
  const build = (excerptChars: number): BoundedOutput => {
    const bounded = boundMessages(result.messages, excerptChars);
    const summary = renderCoreSummary(bounded.messages);
    const details: CoreCompactionDetails = {
      attemptId: input.attemptId,
      sourceDigest: input.sourceDigest,
      jevModel: DEFAULT_JEV_MODEL,
      createdAt: new Date(input.createdAt).toISOString(),
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      summary: {
        digest: stableDigest(summary),
        chars: summary.length,
        budgetChars: maximumChars,
        retainedMessages: bounded.messages.length,
        budgetTruncatedMessages: bounded.truncatedMessages,
      },
      readFiles: files.readFiles,
      modifiedFiles: files.modifiedFiles,
      [CORE_DETAILS_KEY]: {
        version: CORE_DETAILS_VERSION,
        messages: bounded.messages,
        stats: result.stats,
        decisions,
      },
    };
    return {
      output: {
        summary,
        firstKeptEntryId: input.firstKeptEntryId,
        tokensBefore: input.tokensBefore,
        details,
      },
      detailsChars: JSON.stringify(details).length,
    };
  };
  const fits = (candidate: BoundedOutput): boolean =>
    candidate.output.summary.length <= maximumChars && candidate.detailsChars <= maximumChars;
  const upper = Math.max(minimumExcerptChars, maximumMessageFieldChars(result.messages));
  const full = build(upper);
  if (fits(full)) return full.output;
  const minimum = build(minimumExcerptChars);
  if (!fits(minimum)) throw new PiCompactionBuildError();

  let best = minimum;
  let lower = minimumExcerptChars + 1;
  let higher = upper - 1;
  while (lower <= higher) {
    const midpoint = Math.floor((lower + higher) / 2);
    const candidate = build(midpoint);
    if (fits(candidate)) {
      best = candidate;
      lower = midpoint + 1;
    } else {
      higher = midpoint - 1;
    }
  }
  return best.output;
}

function persistDecision(decision: CompactResult["decisions"][number]): PersistedCoreCallDecision {
  if (decision.reason === "pinned") {
    return {
      id: decision.id,
      tool: decision.tool,
      action: decision.action,
      reason: decision.reason,
      source: "pinned",
    };
  }
  return { ...decision, source: "jev" };
}

function boundMessages(
  messages: readonly Message[],
  excerptChars: number,
): { messages: Message[]; truncatedMessages: number } {
  let truncatedMessages = 0;
  const bounded = messages.map((message) => {
    const next = boundMessage(message, excerptChars);
    if (next !== message) truncatedMessages += 1;
    return next;
  });
  return { messages: bounded, truncatedMessages };
}

function boundMessage(message: Message, excerptChars: number): Message {
  const text = truncateExcerpt(message.text, excerptChars);
  let changed = text !== message.text;
  const toolUses = message.toolUses.map((tool) => {
    const input = boundInput(tool.input, excerptChars);
    const toolText = tool.text === undefined ? undefined : truncateExcerpt(tool.text, excerptChars);
    if (input === tool.input && toolText === tool.text) return tool;
    changed = true;
    return {
      tool_use_id: tool.tool_use_id,
      tool: tool.tool,
      input,
      ...(toolText === undefined ? {} : { text: toolText }),
      ...(tool.isError === undefined ? {} : { isError: tool.isError }),
    };
  });
  const originalResults = message.toolResults ?? [];
  const toolResults = originalResults.map((result) => {
    const resultText = truncateExcerpt(result.text, excerptChars);
    if (resultText === result.text) return result;
    changed = true;
    return {
      tool_use_id: result.tool_use_id,
      text: resultText,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
  });
  if (!changed) return message;
  return {
    role: message.role,
    text,
    toolUses,
    ...(toolResults.length === 0 ? {} : { toolResults }),
  };
}

function boundInput(input: Record<string, unknown>, excerptChars: number): Record<string, unknown> {
  const json = safeJson(input);
  if (json.length <= excerptChars) return input;
  return { "[truncated input]": truncateExcerpt(json, excerptChars) };
}

function maximumMessageFieldChars(messages: readonly Message[]): number {
  let maximum = 0;
  for (const message of messages) {
    maximum = Math.max(maximum, message.text.length);
    for (const tool of message.toolUses) {
      maximum = Math.max(maximum, safeJson(tool.input).length, tool.text?.length ?? 0);
    }
    for (const result of message.toolResults ?? []) maximum = Math.max(maximum, result.text.length);
  }
  return maximum;
}

function neutralToPiMessages(message: Message): unknown[] {
  const converted: unknown[] = [];
  const content: unknown[] = [];
  if (message.text.length > 0) content.push({ type: "text", text: message.text });
  for (const call of message.toolUses) {
    content.push({ type: "toolCall", id: call.tool_use_id, name: call.tool, arguments: call.input });
  }
  if (content.length > 0) converted.push({ role: message.role, content: message.role === "user" && message.toolUses.length === 0 ? message.text : content });
  for (const result of message.toolResults ?? []) {
    converted.push({
      role: "toolResult",
      toolCallId: result.tool_use_id,
      toolName: "tool",
      content: [{ type: "text", text: result.text }],
      isError: result.isError === true,
    });
  }
  return converted;
}

function computeFileLists(
  previous: PreviousCoreCompaction | undefined,
  fileOps: unknown,
): { readFiles: string[]; modifiedFiles: string[] } {
  const readFiles = new Set(previous?.readFiles ?? []);
  const modifiedFiles = new Set(previous?.modifiedFiles ?? []);
  const operations = isRecord(fileOps) ? fileOps : {};
  for (const path of iterableStrings(operations.read)) readFiles.add(path);
  for (const key of ["written", "edited", "modified"] as const) {
    for (const path of iterableStrings(operations[key])) modifiedFiles.add(path);
  }
  for (const path of modifiedFiles) readFiles.delete(path);
  return { readFiles: [...readFiles].sort(), modifiedFiles: [...modifiedFiles].sort() };
}

function isStoredCoreDetails(value: unknown): value is { messages: Message[] } {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  return value.messages.every((message) =>
    isRecord(message) &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string" &&
    Array.isArray(message.toolUses) &&
    (message.toolResults === undefined || Array.isArray(message.toolResults))
  );
}

function safeInput(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value) || depth > 12) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    safeLabel(key, "field"),
    isSecretKey(key) ? "[REDACTED]" : safeValue(item, depth + 1),
  ]));
}

function isSecretKey(key: string): boolean {
  return /^(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|secret|client[_ -]?secret|password|passwd|private[_ -]?key)$/i.test(key);
}

function safeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactPrivateData(value).text;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (depth > 12) return "[nested value omitted]";
  if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
  if (isRecord(value)) return safeInput(value, depth + 1);
  return String(value);
}

function safeLabel(value: string, fallback: string): string {
  const redacted = redactPrivateData(value).text.replaceAll(/[\r\n\t]/g, " ").slice(0, 80);
  return redacted.length > 0 ? redacted : fallback;
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable input]";
  }
}

function iterableStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (value instanceof Set) return [...value].filter((item): item is string => typeof item === "string");
  return [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
