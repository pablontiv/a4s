import type {
  ChoiceAnswer,
  JevAnswer,
  JevClient,
  JevQuestion,
  JevRequest,
  NoulAnswer,
  ScoreAnswer,
  ValidatedJevResponse,
} from "./types.ts";
import { DEFAULT_JEV_MODEL, TYPESAFE_API_KEY_ENV } from "./types.ts";

export class JevUnavailableError extends Error {
  readonly code = "missing_key" as const;

  constructor() {
    super(`${TYPESAFE_API_KEY_ENV} is not configured`);
    this.name = "JevUnavailableError";
  }
}

export class JevApiError extends Error {
  readonly code = "api_failure" as const;

  constructor(
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(status === undefined ? "TypeSafe request failed" : `TypeSafe request failed with status ${status}`);
    this.name = "JevApiError";
  }
}

const PROBABILITY_ROUNDING_TOLERANCE = 0.02;
const SCORE_ROUNDING_TOLERANCE = 0.05;

export class JevValidationError extends Error {
  readonly code = "malformed_response" as const;

  constructor(readonly path: string) {
    super(`invalid Jev response at ${path}`);
    this.name = "JevValidationError";
  }
}

export interface HttpJevClientOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export class HttpJevClient implements JevClient {
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpJevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env[TYPESAFE_API_KEY_ENV];
    this.endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown> {
    const apiKey = this.apiKey?.trim();
    if (!apiKey) throw new JevUnavailableError();
    if (request.model !== DEFAULT_JEV_MODEL) throw new TypeError(`Jev model must be ${DEFAULT_JEV_MODEL}`);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new JevApiError();
    }

    if (!response.ok) throw new JevApiError(response.status, parseRetryAfterMs(response.headers));
    try {
      return await response.json();
    } catch {
      throw new JevValidationError("$");
    }
  }
}

export function validateJevResponse(
  value: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
  expectedModel: string = DEFAULT_JEV_MODEL,
): ValidatedJevResponse {
  const response = requireRecord(value, "$");
  requireExactKeys(response, ["model", "answers", "usage"], "$");
  if (response.model !== expectedModel || response.model !== DEFAULT_JEV_MODEL) {
    throw new JevValidationError("$.model");
  }

  const answersRecord = requireRecord(response.answers, "$.answers");
  requireExactKeys(answersRecord, Object.keys(questions), "$.answers");
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = validateAnswer(answersRecord[id], question, `$.answers.${id}`);
  }

  const usage = requireRecord(response.usage, "$.usage");
  requireExactKeys(usage, ["input_tokens", "output_tokens"], "$.usage");
  const inputTokens = requireNonNegativeInteger(usage.input_tokens, "$.usage.input_tokens");
  const outputTokens = requireNonNegativeInteger(usage.output_tokens, "$.usage.output_tokens");

  return {
    model: DEFAULT_JEV_MODEL,
    answers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

export function parseScoreAnswer(
  value: unknown,
  criteria: readonly string[],
  path = "$",
): ScoreAnswer {
  const answer = requireRecord(value, path);
  requireExactKeys(answer, ["type", "score", "legend", "probabilities", "confidence"], path);
  if (answer.type !== "score") throw new JevValidationError(`${path}.type`);

  const levelKeys = criteria.map((_criterion, index) => String(index));
  const legend = requireRecord(answer.legend, `${path}.legend`);
  requireExactKeys(legend, levelKeys, `${path}.legend`);
  const parsedLegend: Record<string, string> = {};
  for (const [index, criterion] of criteria.entries()) {
    const key = String(index);
    if (legend[key] !== criterion) throw new JevValidationError(`${path}.legend.${key}`);
    parsedLegend[key] = criterion;
  }

  const probabilities = parseProbabilityMap(answer.probabilities, levelKeys, `${path}.probabilities`);
  const score = requireRange(answer.score, 0, criteria.length - 1, `${path}.score`);
  const confidence = requireRange(answer.confidence, 0, 1, `${path}.confidence`);
  const weightedScore = levelKeys.reduce(
    (total, key) => total + Number(key) * (probabilities[key] ?? 0),
    0,
  );
  if (Math.abs(weightedScore - score) > SCORE_ROUNDING_TOLERANCE) {
    throw new JevValidationError(`${path}.score`);
  }

  return {
    type: "score",
    score,
    legend: parsedLegend,
    probabilities,
    confidence,
  };
}

function validateAnswer(value: unknown, question: JevQuestion, path: string): JevAnswer {
  switch (question.type) {
    case "noul":
      return parseNoulAnswer(value, path);
    case "choice":
      return parseChoiceAnswer(value, Object.keys(question.criteria), path);
    case "score":
      return parseScoreAnswer(value, question.criteria, path);
    default: {
      const unsupported: never = question;
      throw new JevValidationError(`${path}.type:${String(unsupported)}`);
    }
  }
}

function parseNoulAnswer(value: unknown, path: string): NoulAnswer {
  const answer = requireRecord(value, path);
  requireExactKeys(answer, ["type", "noul"], path);
  if (answer.type !== "noul") throw new JevValidationError(`${path}.type`);
  return { type: "noul", noul: requireRange(answer.noul, 0, 1, `${path}.noul`) };
}

function parseChoiceAnswer(value: unknown, options: readonly string[], path: string): ChoiceAnswer {
  const answer = requireRecord(value, path);
  requireExactKeys(answer, ["type", "choice", "probabilities", "confidence"], path);
  if (answer.type !== "choice") throw new JevValidationError(`${path}.type`);
  if (typeof answer.choice !== "string" || !options.includes(answer.choice)) {
    throw new JevValidationError(`${path}.choice`);
  }

  const probabilities = parseProbabilityMap(answer.probabilities, options, `${path}.probabilities`);
  const confidence = requireRange(answer.confidence, 0, 1, `${path}.confidence`);
  const selectedProbability = probabilities[answer.choice];
  if (selectedProbability === undefined) throw new JevValidationError(`${path}.probabilities`);
  const maximum = Math.max(...Object.values(probabilities));
  if (selectedProbability + PROBABILITY_ROUNDING_TOLERANCE < maximum) {
    throw new JevValidationError(`${path}.choice`);
  }

  return {
    type: "choice",
    choice: answer.choice,
    probabilities,
    confidence,
  };
}

function parseProbabilityMap(value: unknown, keys: readonly string[], path: string): Record<string, number> {
  const probabilities = requireRecord(value, path);
  requireExactKeys(probabilities, keys, path);
  const parsed: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const probability = requireRange(probabilities[key], 0, 1, `${path}.${key}`);
    parsed[key] = probability;
    sum += probability;
  }
  if (Math.abs(sum - 1) > PROBABILITY_ROUNDING_TOLERANCE) throw new JevValidationError(path);
  return parsed;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const explicitMilliseconds = headers.get("retry-after-ms")?.trim();
  if (explicitMilliseconds && /^\d+$/.test(explicitMilliseconds)) {
    const parsed = Number(explicitMilliseconds);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(retryAfter);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JevValidationError(path);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new JevValidationError(path);
  }
}

function requireRange(value: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new JevValidationError(path);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new JevValidationError(path);
  }
  return value;
}
