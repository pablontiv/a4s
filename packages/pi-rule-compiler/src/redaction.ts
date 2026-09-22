export interface RedactionResult {
  text: string;
  redactionCount: number;
}

/** Corpus text is deliberately bounded only after redaction has completed. */
export const MAX_CORPUS_TEXT_CHARS = 2_400;

export function redactAndLimitCorpusText(input: string, maximum = MAX_CORPUS_TEXT_CHARS): RedactionResult {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError("maximum corpus text length must be a positive integer");
  }
  const redacted = redactPrivateData(input);
  return { text: redacted.text.slice(0, maximum), redactionCount: redacted.redactionCount };
}

interface RedactionPattern {
  expression: RegExp;
  replace(match: string, ...groups: string[]): string;
}

const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  {
    expression: /<private\b[^>]*>[\s\S]*?<\/private>/gi,
    replace: () => "[REDACTED:private]",
  },
  {
    expression: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replace: () => "[REDACTED:private-key]",
  },
  {
    expression: /(\bauthorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
    replace: (_match, prefix) => `${prefix}[REDACTED]`,
  },
  {
    expression:
      /((?:["']?\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|secret|client[_ -]?secret|password|passwd|private[_ -]?key)["']?\s*[:=]\s*))(?:(?:"[^"\r\n]*")|(?:'[^'\r\n]*')|[^\s,;]+)/gi,
    replace: (_match, prefix) => `${prefix}[REDACTED]`,
  },
  {
    expression: /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    replace: () => "[REDACTED:token]",
  },
  {
    expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => "[REDACTED:jwt]",
  },
  {
    expression: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replace: (_match, scheme) => `${scheme}[REDACTED]@`,
  },
  {
    expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replace: () => "[REDACTED:email]",
  },
  {
    expression: /\/(?:Users|home)\/[^/\s]+/g,
    replace: (match) => `${match.startsWith("/Users/") ? "/Users/" : "/home/"}[REDACTED]`,
  },
];

export function redactPrivateData(input: string): RedactionResult {
  let text = input;
  let redactionCount = 0;

  for (const pattern of REDACTION_PATTERNS) {
    text = text.replace(pattern.expression, (match: string, ...args: unknown[]) => {
      redactionCount += 1;
      const captureCount = Math.max(0, args.length - 2);
      const groups = args.slice(0, captureCount).map((value) => String(value));
      return pattern.replace(match, ...groups);
    });
  }

  return { text, redactionCount };
}

export function redactStrings<T>(value: T): T {
  if (typeof value === "string") return redactPrivateData(value).text as T;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item)) as T;
  if (value !== null && typeof value === "object") {
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item)]),
    );
    return redacted as T;
  }
  return value;
}
