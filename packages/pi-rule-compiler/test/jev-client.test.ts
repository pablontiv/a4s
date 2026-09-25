import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_JEV_MODEL,
  JevApiError,
  JevUnavailableError,
  OperationAbortedError,
  ScheduledJevClient,
  TYPESAFE_API_KEY_ENV,
  TypesafeJevClient,
  validateJevResponse,
  type JevRequest,
} from "../src/index.ts";
import { validJevResponse } from "./fixtures.ts";

function request(): JevRequest {
  return {
    state: { message: "sanitized" },
    model: DEFAULT_JEV_MODEL,
    questions: {
      candidate: { type: "noul", instructions: "Is this a reusable rule?" },
    },
  };
}

test("canonical TypeSafe bridge pins the model, uses the SDK request shape, and remains strictly validatable", async () => {
  const seen: Array<{ input: string; init: RequestInit | undefined }> = [];
  const expected = validJevResponse(request());
  const client = new TypesafeJevClient({
    apiKey: "test-key-not-a-real-secret",
    timeoutMs: 180_000,
    fetch: async (input, init) => {
      seen.push({ input: String(input), init });
      return new Response(JSON.stringify(expected), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const controller = new AbortController();
  const result = await client.evaluate(request(), { signal: controller.signal });

  assert.deepEqual(validateJevResponse(result, request().questions), expected);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.input, "https://api.typesafe.ai/v1/systemone");
  assert.equal(new Headers(seen[0]?.init?.headers).get("authorization"), "Bearer test-key-not-a-real-secret");
  assert.equal(JSON.parse(String(seen[0]?.init?.body)).model, "jev-1.13.0");
  assert.equal(JSON.parse(String(seen[0]?.init?.body)).state.message, "sanitized");
});

test("canonical TypeSafe bridge preserves scheduler-visible rate-limit metadata without SDK retries", async () => {
  const secret = "test-key-not-a-real-secret";
  const content = "sanitized-content-sentinel";
  let calls = 0;
  const client = new TypesafeJevClient({
    apiKey: secret,
    timeoutMs: 180_000,
    fetch: async () => {
      calls += 1;
      return new Response(content, { status: 429, headers: { "retry-after-ms": "1250" } });
    },
  });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof JevApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 1_250);
      assert.doesNotMatch(String(error), new RegExp(`${secret}|${content}`));
      return true;
    },
  );
  assert.equal(calls, 1, "the existing rule-compiler scheduler owns retry policy");
});

test(`canonical TypeSafe bridge fails before fetch when ${TYPESAFE_API_KEY_ENV} is absent`, () => {
  let called = false;
  assert.throws(
    () => new TypesafeJevClient({
      apiKey: "   ",
      timeoutMs: 180_000,
      fetch: async () => {
        called = true;
        throw new Error("must not be called");
      },
    }),
    JevUnavailableError,
  );
  assert.equal(called, false);
});

test("canonical TypeSafe bridge rejects a non-pinned request model before fetch", async () => {
  let called = false;
  const client = new TypesafeJevClient({
    apiKey: "test-key-not-a-real-secret",
    timeoutMs: 180_000,
    fetch: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  const invalid = { ...request(), model: "jev-latest" } as unknown as JevRequest;
  await assert.rejects(
    client.evaluate(invalid, { signal: new AbortController().signal }),
    new TypeError(`Jev model must be ${DEFAULT_JEV_MODEL}`),
  );
  assert.equal(called, false);
});

test("canonical TypeSafe bridge preserves 529 Retry-After seconds without SDK retries", async () => {
  let calls = 0;
  const client = new TypesafeJevClient({
    apiKey: "test-key-not-a-real-secret",
    timeoutMs: 180_000,
    fetch: async () => {
      calls += 1;
      return new Response("overloaded", {
        status: 529,
        headers: { "retry-after": "2" },
      });
    },
  });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof JevApiError);
      assert.equal(error.status, 529);
      assert.equal(error.retryAfterMs, 2_000);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("canonical TypeSafe bridge maps a transport throw to a status-less JevApiError once", async () => {
  let calls = 0;
  const client = new TypesafeJevClient({
    apiKey: "test-key-not-a-real-secret",
    timeoutMs: 180_000,
    fetch: async () => {
      calls += 1;
      throw new Error("sanitized transport failure");
    },
  });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof JevApiError);
      assert.equal(error.status, undefined);
      assert.equal(error.retryAfterMs, undefined);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("configured bridge timeout aborts SDK transport without taking retry ownership", async () => {
  let calls = 0;
  let transportAborted = false;
  const client = new TypesafeJevClient({
    apiKey: "test-key-not-a-real-secret",
    timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      calls += 1;
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        transportAborted = true;
        reject(signal.reason);
      }, { once: true });
      setTimeout(() => reject(new Error("configured timeout did not reach transport")), 100);
    }),
  });

  await assert.rejects(
    client.evaluate(request(), { signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevApiError && error.status === undefined,
  );
  assert.equal(transportAborted, true);
  assert.equal(calls, 1);
});

test("caller abort reaches SDK transport and is not mapped to JevApiError", async () => {
  const caller = new AbortController();
  let transportSignal: AbortSignal | undefined;
  const client = new TypesafeJevClient({
    apiKey: "test-key-not-a-real-secret",
    timeoutMs: 180_000,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      transportSignal = init?.signal ?? undefined;
      transportSignal?.addEventListener("abort", () => reject(transportSignal?.reason), { once: true });
      queueMicrotask(() => caller.abort());
    }),
  });

  await assert.rejects(
    client.evaluate(request(), { signal: caller.signal }),
    (error: unknown) => {
      assert.equal(error instanceof JevApiError, false);
      assert.equal((error as Error).name, "APIUserAbortError");
      return true;
    },
  );
  assert.equal(transportSignal?.aborted, true);
});

test("scheduler normalizes an in-flight SDK caller abort to OperationAbortedError", async () => {
  const caller = new AbortController();
  let transportAborted = false;
  const scheduler = new ScheduledJevClient(new TypesafeJevClient({
    apiKey: "test-key-not-a-real-secret",
    timeoutMs: 180_000,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        transportAborted = true;
        reject(signal.reason);
      }, { once: true });
      queueMicrotask(() => caller.abort());
    }),
  }), { maxRetries: 3 });

  await assert.rejects(
    scheduler.evaluate(request(), { signal: caller.signal }),
    OperationAbortedError,
  );
  assert.equal(transportAborted, true);
  assert.deepEqual(scheduler.getStats(), {
    maxConcurrency: 1,
    maxRetries: 3,
    logicalRequests: 1,
    attempts: 1,
    retries: 0,
    maxObservedConcurrency: 1,
  });
});
