import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import {
  DEFAULT_JEV_MODEL,
  JEV_MODEL_ID,
  TYPESAFE_PROVIDER_ID,
} from "./types.ts";

export class JevUnavailableError extends Error {
  readonly code = "missing_key" as const;

  constructor() {
    super(`Pi classifier ${DEFAULT_JEV_MODEL} is unavailable`);
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

type PiModelRegistry = Pick<ExtensionContext["modelRegistry"], "findOfType" | "classify">;
type PiClassifierContext = Parameters<PiModelRegistry["classify"]>[1];

export class JevValidationError extends Error {
  readonly code = "malformed_response" as const;

  constructor(readonly path: string) {
    super(`invalid Jev response at ${path}`);
    this.name = "JevValidationError";
  }
}

export interface PiJevClientOptions {
  modelRegistry: PiModelRegistry;
  /** Per-attempt timeout derived from the owning hook/operation budget. */
  timeoutMs: number;
  /** Injectable transport observer for tests; Pi still owns request construction and auth. */
  fetch?: typeof globalThis.fetch;
}

/** Adapts Pi's native classifier runtime to Context Expert's JevClient seam. */
export class PiJevClient implements JevClient {
  private readonly model;

  constructor(private readonly options: PiJevClientOptions) {
    const model = options.modelRegistry.findOfType("classifier", TYPESAFE_PROVIDER_ID, JEV_MODEL_ID);
    if (!model) throw new JevUnavailableError();
    this.model = model;
  }

  async evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown> {
    if (request.model !== DEFAULT_JEV_MODEL) throw new TypeError(`Jev model must be ${DEFAULT_JEV_MODEL}`);

    let responseMetadata: { status: number; headers: Headers } | undefined;
    const requestFetch = this.options.fetch ?? globalThis.fetch;
    const observedFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await requestFetch(input, init);
      responseMetadata = { status: response.status, headers: response.headers };
      return response;
    };
    const result = await this.options.modelRegistry.classify(
      this.model,
      {
        state: request.state as PiClassifierContext["state"],
        questions: classifierQuestions(request.questions),
      },
      {
        signal: options.signal,
        timeoutMs: this.options.timeoutMs,
        maxRetries: 0,
        fetch: observedFetch,
      },
    );
    if (result.stopReason !== "stop") {
      if (options.signal.aborted) throw options.signal.reason ?? new Error("Jev request aborted");
      if (responseMetadata && responseMetadata.status >= 200 && responseMetadata.status < 300) {
        throw new JevValidationError("$.native");
      }
      throw new JevApiError(
        responseMetadata?.status,
        responseMetadata === undefined ? undefined : parseRetryAfterMs(responseMetadata.headers),
      );
    }
    if (
      result.provider !== TYPESAFE_PROVIDER_ID ||
      result.model !== JEV_MODEL_ID ||
      result.api !== "typesafe-system-one"
    ) {
      throw new JevValidationError("$.model");
    }
    if (!result.usage) throw new JevValidationError("$.usage");

    const answers: Record<string, JevAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = result.answers[id];
      if (!answer) throw new JevValidationError(`$.answers.${id}`);
      if (question.type === "noul") {
        if (answer.type !== "bool") throw new JevValidationError(`$.answers.${id}.type`);
        answers[id] = { type: "noul", noul: answer.probability };
      } else if (question.type === "choice") {
        if (answer.type !== "choice") throw new JevValidationError(`$.answers.${id}.type`);
        answers[id] = {
          type: "choice",
          choice: answer.choice,
          probabilities: answer.probabilities,
          confidence: answer.confidence,
        };
      } else {
        if (answer.type !== "score") throw new JevValidationError(`$.answers.${id}.type`);
        const maximum = question.criteria.length - 1;
        if (maximum <= 0) throw new JevValidationError(`$.questions.${id}.criteria`);
        // Pi reports classifier scores on the criterion-index scale 0..N-1.
        // Normalize exactly once at this bridge so A4S keeps its 0..1 contract.
        answers[id] = { type: "score", score: answer.score / maximum, confidence: answer.confidence };
      }
    }
    return {
      model: DEFAULT_JEV_MODEL,
      answers,
      usage: { input_tokens: result.usage.input, output_tokens: result.usage.output },
    };
  }
}

function classifierQuestions(questions: Readonly<Record<string, JevQuestion>>) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type !== "noul") return [id, question];
    return [id, { ...question, type: "bool" as const }];
  }));
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
  if (criteria.length < 2) throw new JevValidationError(`${path}.criteria`);
  const answer = requireRecord(value, path);
  requireExactKeys(answer, ["type", "score", "confidence"], path);
  if (answer.type !== "score") throw new JevValidationError(`${path}.type`);
  return {
    type: "score",
    score: requireRange(answer.score, 0, 1, `${path}.score`),
    confidence: requireRange(answer.confidence, 0, 1, `${path}.confidence`),
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
