import assert from "node:assert/strict";
import test from "node:test";
import {
  JevApiError,
  OperationAbortedError,
  ScheduledJevClient,
  observePreparedCompactionRules,
  prepareRuleObservationsWithMessages,
  stableDigest,
  type JevClient,
  type JevRequest,
} from "../src/index.ts";
import { validJevResponse } from "./fixtures.ts";

test("one scheduler bounds concurrency across every window and request", async () => {
  let active = 0;
  let maximumActive = 0;
  const delegate: JevClient = {
    async evaluate(request) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return validJevResponse(request);
    },
  };
  const scheduler = new ScheduledJevClient(delegate, { maxConcurrency: 3, maxRetries: 0 });
  const prepared = prepareRuleObservationsWithMessages(
    {
      messagesToSummarize: Array.from({ length: 80 }, (_, index) => ({
        role: "user",
        content: `Message ${index}: preserve bounded global scheduling.`,
      })),
      turnPrefixMessages: [],
    },
    { maxMessagesPerWindow: 10, maxQuestionsPerRequest: 5 },
  );
  const attemptId = stableDigest({ test: "global-scheduler" });

  await Promise.all(
    prepared.plans.map((plan, windowIndex) =>
      observePreparedCompactionRules(
        plan,
        {
          attemptId,
          reason: "manual",
          willRetry: false,
          observedAt: "2026-09-18T20:00:00.000Z",
          windowIndex,
          windowCount: prepared.plans.length,
          pins: prepared.pins,
        },
        scheduler,
        new AbortController().signal,
        { maxMessagesPerWindow: 10, maxQuestionsPerRequest: 5 },
      ),
    ),
  );

  const logicalRequests = prepared.plans.reduce((total, plan) => total + plan.requests.length, 0);
  assert.ok(prepared.plans.length > 1);
  assert.ok(logicalRequests > prepared.plans.length);
  assert.equal(maximumActive, 3);
  assert.deepEqual(scheduler.getStats(), {
    maxConcurrency: 3,
    maxRetries: 0,
    logicalRequests,
    attempts: logicalRequests,
    retries: 0,
    maxObservedConcurrency: 3,
  });
});

test("scheduler honors Retry-After and retries a 429 within its bounded policy", async () => {
  const request = sampleRequest();
  const delays: number[] = [];
  let attempts = 0;
  const delegate: JevClient = {
    async evaluate() {
      attempts += 1;
      if (attempts === 1) throw new JevApiError(429, 1_250);
      return { ok: true };
    },
  };
  const scheduler = new ScheduledJevClient(delegate, {
    maxConcurrency: 1,
    maxRetries: 2,
    sleep: async (milliseconds, signal) => {
      assert.equal(signal.aborted, false);
      delays.push(milliseconds);
    },
  });

  assert.deepEqual(
    await scheduler.evaluate(request, { signal: new AbortController().signal }),
    { ok: true },
  );
  assert.deepEqual(delays, [1_250]);
  assert.equal(attempts, 2);
  assert.equal(scheduler.getStats().retries, 1);
});

test("scheduler bounds repeated 429 retries and falls back from excessive Retry-After", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const expected = new JevApiError(429, 90_000);
  const scheduler = new ScheduledJevClient(
    {
      async evaluate() {
        attempts += 1;
        throw expected;
      },
    },
    {
      maxRetries: 2,
      backoffInitialMs: 400,
      backoffMaxMs: 800,
      maxRetryAfterMs: 30_000,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
  );

  await assert.rejects(
    scheduler.evaluate(sampleRequest(), { signal: new AbortController().signal }),
    (error: unknown) => error === expected,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [400, 800]);
});

test("scheduler aborts during 429 backoff and performs no further attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const scheduler = new ScheduledJevClient(
    {
      async evaluate() {
        attempts += 1;
        throw new JevApiError(429, 10_000);
      },
    },
    {
      maxRetries: 3,
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new OperationAbortedError()), { once: true });
          controller.abort();
        }),
    },
  );

  await assert.rejects(
    scheduler.evaluate(sampleRequest(), { signal: controller.signal }),
    OperationAbortedError,
  );
  assert.equal(attempts, 1);
});

function sampleRequest(): JevRequest {
  return {
    state: { message: "sanitized" },
    model: "jev-1.13.0",
    questions: {
      retain: {
        type: "choice",
        instructions: "Retain this message?",
        criteria: { keep: "Keep it", drop: "Drop it" },
      },
    },
  };
}
