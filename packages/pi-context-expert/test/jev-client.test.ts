import assert from "node:assert/strict";
import test from "node:test";
import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  ModelsClassifierOptions,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_JEV_MODEL,
  JevApiError,
  JevUnavailableError,
  JevValidationError,
  OperationAbortedError,
  PiJevClient,
  ScheduledJevClient,
  validateJevResponse,
  type JevRequest,
} from "../src/index.ts";

const MODEL = {
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe-system-one",
  baseUrl: "https://api.typesafe.ai/v1/",
  input: ["text"],
  contextWindow: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as ClassifierModel<"typesafe-system-one">;

function request(): JevRequest {
  return {
    state: { message: "sanitized" },
    model: DEFAULT_JEV_MODEL,
    questions: {
      candidate: { type: "noul", instructions: "Is this a reusable rule?" },
      status: {
        type: "choice",
        instructions: "What is its status?",
        criteria: { current: "Current", superseded: "Superseded" },
      },
      continuity: {
        type: "score",
        instructions: "How much continuity does it provide?",
        criteria: ["None", "Minor", "Useful", "Essential"],
      },
    },
  };
}

function successfulResult(): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    stopReason: "stop",
    timestamp: 1,
    answers: {
      candidate: { type: "bool", probability: 0.9 },
      status: {
        type: "choice",
        choice: "current",
        probabilities: { current: 0.8, superseded: 0.2 },
        confidence: 0.7,
      },
      continuity: { type: "score", score: 2.5, confidence: 0.75 },
    },
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function registry(result: ClassifierResult | ((options: ModelsClassifierOptions | undefined) => Promise<ClassifierResult>)) {
  const calls: Array<{
    model: ClassifierModel<ClassifierApi>;
    context: ClassifierContext;
    options: ModelsClassifierOptions | undefined;
  }> = [];
  return {
    calls,
    findOfType(type: string, provider: string, id: string) {
      assert.equal(type, "classifier");
      assert.equal(provider, "typesafe");
      assert.equal(id, "jev-latest");
      return MODEL;
    },
    async classify(
      model: ClassifierModel<ClassifierApi>,
      context: ClassifierContext,
      options?: ModelsClassifierOptions,
    ): Promise<ClassifierResult> {
      calls.push({ model, context, options });
      return typeof result === "function" ? result(options) : result;
    },
  } as unknown as ConstructorParameters<typeof PiJevClient>[0]["modelRegistry"] & { calls: typeof calls };
}

test("Pi Jev bridge selects typesafe/jev-latest and converts Pi classifier answers", async () => {
  const native = registry(successfulResult());
  const client = new PiJevClient({ modelRegistry: native, timeoutMs: 180_000 });
  const signal = new AbortController().signal;

  const raw = await client.evaluate(request(), { signal });
  const result = validateJevResponse(raw, request().questions);

  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0]?.model, MODEL);
  assert.deepEqual(native.calls[0]?.context, {
    state: { message: "sanitized" },
    questions: {
      candidate: { type: "bool", instructions: "Is this a reusable rule?" },
      status: {
        type: "choice",
        instructions: "What is its status?",
        criteria: { current: "Current", superseded: "Superseded" },
      },
      continuity: {
        type: "score",
        instructions: "How much continuity does it provide?",
        criteria: ["None", "Minor", "Useful", "Essential"],
      },
    },
  });
  assert.equal(native.calls[0]?.options?.signal, signal);
  assert.equal(native.calls[0]?.options?.timeoutMs, 180_000);
  assert.equal(native.calls[0]?.options?.maxRetries, 0);
  assert.equal(result.model, "typesafe/jev-latest");
  assert.deepEqual(result.answers.candidate, { type: "noul", noul: 0.9 });
  assert.deepEqual(result.answers.status, successfulResult().answers.status);
  assert.deepEqual(result.answers.continuity, { type: "score", score: 2.5 / 3, confidence: 0.75 });
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 10 });
});

test("Pi Jev bridge rejects a stopped result from the wrong native model identity", async () => {
  const mismatched = successfulResult();
  mismatched.model = "jev-other";
  const client = new PiJevClient({ modelRegistry: registry(mismatched), timeoutMs: 180_000 });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevValidationError && error.path === "$.model",
  );
});

test("Pi Jev bridge rejects a stopped result without usage accounting", async () => {
  const withoutUsage = successfulResult();
  delete withoutUsage.usage;
  const client = new PiJevClient({ modelRegistry: registry(withoutUsage), timeoutMs: 180_000 });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevValidationError && error.path === "$.usage",
  );
});

test("Pi Jev bridge rejects a native score outside its criterion-index range", async () => {
  const outOfRange = successfulResult();
  outOfRange.answers.continuity = { type: "score", score: 4, confidence: 1 };
  const client = new PiJevClient({ modelRegistry: registry(outOfRange), timeoutMs: 180_000 });

  const raw = await client.evaluate(request(), { signal: new AbortController().signal });
  assert.throws(
    () => validateJevResponse(raw, request().questions),
    (error: unknown) => error instanceof JevValidationError && error.path === "$.answers.continuity.score",
  );
});

test("Pi Jev bridge fails closed when the native classifier model is unavailable", () => {
  const native = {
    findOfType() { return undefined; },
    async classify() { throw new Error("must not classify"); },
  };
  assert.throws(
    () => new PiJevClient({ modelRegistry: native, timeoutMs: 180_000 }),
    JevUnavailableError,
  );
});

test("Pi Jev bridge preserves scheduler-visible rate-limit metadata without Pi retries", async () => {
  let fetchCalls = 0;
  const native = registry(async (options) => {
    await options?.fetch?.("https://api.typesafe.ai/v1/systemone", {});
    return {
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-latest",
      answers: {},
      stopReason: "error",
      errorMessage: "System One API error",
      timestamp: 1,
    };
  });
  const client = new PiJevClient({
    modelRegistry: native,
    timeoutMs: 180_000,
    fetch: async () => {
      fetchCalls += 1;
      return new Response("overloaded", { status: 429, headers: { "retry-after-ms": "1250" } });
    },
  });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof JevApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 1_250);
      return true;
    },
  );
  assert.equal(fetchCalls, 1);
  assert.equal(native.calls[0]?.options?.maxRetries, 0);
});

test("Pi Jev bridge treats a successful HTTP response with invalid provider output as malformed", async () => {
  const native = registry(async (options) => {
    await options?.fetch?.("https://api.typesafe.ai/v1/systemone", {});
    return {
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-latest",
      answers: {},
      stopReason: "error",
      errorMessage: "System One API returned an unexpected response",
      timestamp: 1,
    };
  });
  const client = new PiJevClient({
    modelRegistry: native,
    timeoutMs: 180_000,
    fetch: async () => new Response("{}", { status: 200 }),
  });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    JevValidationError,
  );
});

test("Pi Jev bridge rejects a request for any non-native model selector", async () => {
  const native = registry(successfulResult());
  const client = new PiJevClient({ modelRegistry: native, timeoutMs: 180_000 });
  const invalid = { ...request(), model: "jev-1.13.0" } as unknown as JevRequest;

  await assert.rejects(
    client.evaluate(invalid, { signal: new AbortController().signal }),
    new TypeError(`Jev model must be ${DEFAULT_JEV_MODEL}`),
  );
  assert.equal(native.calls.length, 0);
});

test("scheduler normalizes a Pi classifier caller abort", async () => {
  const caller = new AbortController();
  const native = registry(async () => {
    caller.abort(new Error("caller aborted"));
    return {
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-latest",
      answers: {},
      stopReason: "aborted",
      errorMessage: "aborted",
      timestamp: 1,
    };
  });
  const scheduler = new ScheduledJevClient(
    new PiJevClient({ modelRegistry: native, timeoutMs: 180_000 }),
    { maxRetries: 3 },
  );

  await assert.rejects(
    scheduler.evaluate(request(), { signal: caller.signal }),
    OperationAbortedError,
  );
  assert.deepEqual(scheduler.getStats(), {
    maxConcurrency: 1,
    maxRetries: 3,
    logicalRequests: 1,
    attempts: 1,
    retries: 0,
    maxObservedConcurrency: 1,
  });
});
