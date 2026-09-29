import { stableDigest } from "./digest.ts";
import { digestNormalizedMessages } from "./messages.ts";
import type {
  FittedSessionState,
  FittedStateMessage,
  NormalizedSessionMessage,
  RuleObservationState,
} from "./types.ts";

export class StateFitError extends Error {
  readonly code: "empty_state" | "oversized_state";

  constructor(code: "empty_state" | "oversized_state") {
    super(code === "empty_state" ? "session state is empty" : "session state cannot fit without dropping messages");
    this.name = "StateFitError";
    this.code = code;
  }
}

export interface StateFitOptions {
  maxSourceChars?: number;
  maxStateTokens?: number;
  maxExcerptChars?: number;
  minimumExcerptChars?: number;
}

const DEFAULT_MAX_SOURCE_CHARS = 8_000_000;
const DEFAULT_MAX_STATE_TOKENS = 25_000;
const DEFAULT_MAX_EXCERPT_CHARS = 2_400;
const DEFAULT_MINIMUM_EXCERPT_CHARS = 48;
const TRUNCATION_MARKER = " …[truncated]… ";

export function fitWholeSessionState(
  messages: readonly NormalizedSessionMessage[],
  options: StateFitOptions = {},
): FittedSessionState {
  if (messages.length === 0) throw new StateFitError("empty_state");

  const maxSourceChars = positiveInteger(options.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS, "maxSourceChars");
  if (messages.reduce((total, message) => total + message.text.length, 0) > maxSourceChars) {
    throw new StateFitError("oversized_state");
  }
  const maxStateTokens = positiveInteger(options.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS, "maxStateTokens");
  const maxExcerptChars = positiveInteger(options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS, "maxExcerptChars");
  const minimumExcerptChars = positiveInteger(
    options.minimumExcerptChars ?? DEFAULT_MINIMUM_EXCERPT_CHARS,
    "minimumExcerptChars",
  );
  if (minimumExcerptChars > maxExcerptChars) {
    throw new RangeError("minimumExcerptChars cannot exceed maxExcerptChars");
  }

  const sourceDigest = digestNormalizedMessages(messages);
  const buildState = (excerptLimit: number): RuleObservationState => ({
    schema: "a4s.rule-observation-state/v1",
    sourceDigest,
    messages: messages.map((message) => ({
      index: message.index,
      role: message.role,
      sourceDigest: message.sourceDigest,
      excerpt: truncateExcerpt(message.text, excerptLimit),
    })),
  });

  const minimumState = buildState(minimumExcerptChars);
  if (estimateJevTokens(JSON.stringify(minimumState)) > maxStateTokens) {
    throw new StateFitError("oversized_state");
  }

  let lower = minimumExcerptChars;
  let upper = maxExcerptChars;
  let fitted = minimumState;
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = buildState(midpoint);
    if (estimateJevTokens(JSON.stringify(candidate)) <= maxStateTokens) {
      fitted = candidate;
      lower = midpoint + 1;
    } else {
      upper = midpoint - 1;
    }
  }

  return {
    state: fitted,
    stateDigest: stableDigest(fitted),
    sourceDigest,
    messages: fitted.messages,
    redactionCount: messages.reduce((total, message) => total + message.redactionCount, 0),
  };
}

export function truncateExcerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= TRUNCATION_MARKER.length) return text.slice(0, limit);

  const available = limit - TRUNCATION_MARKER.length;
  const headLength = Math.ceil(available * 0.75);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${TRUNCATION_MARKER}${tailLength > 0 ? text.slice(-tailLength) : ""}`;
}

export function fittedMessageByDigest(
  messages: readonly FittedStateMessage[],
  digest: string,
): FittedStateMessage | undefined {
  return messages.find((message) => message.sourceDigest === digest);
}

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/** Conservative estimator for JSON-heavy Jev state, adapted from fast-jev-compaction (MIT). */
export function estimateJevTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else {
      tokens += 0.9;
    }
  }
  return Math.ceil(tokens);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
