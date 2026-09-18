import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_JEV_MODEL,
  HttpJevClient,
  JevApiError,
  JevUnavailableError,
  TYPESAFE_API_KEY_ENV,
  type JevRequest,
} from "../src/index.ts";

test("HTTP Jev client pins the model contract, uses the configured API key, and forwards abort", async () => {
  const seen: Array<{ input: string; init: RequestInit | undefined }> = [];
  const client = new HttpJevClient({
    apiKey: "test-key-not-a-real-secret",
    fetchImpl: async (input, init) => {
      seen.push({ input: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const request: JevRequest = {
    state: { message: "sanitized" },
    model: DEFAULT_JEV_MODEL,
    questions: {
      candidate: { type: "noul", instructions: "Is this a reusable rule?" },
    },
  };
  const controller = new AbortController();
  await client.evaluate(request, { signal: controller.signal });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.input, "https://api.typesafe.ai/v1/systemone");
  assert.equal(new Headers(seen[0]?.init?.headers).get("authorization"), "Bearer test-key-not-a-real-secret");
  assert.equal(seen[0]?.init?.signal, controller.signal);
  assert.equal(JSON.parse(String(seen[0]?.init?.body)).model, "jev-1.13.0");
});

test("HTTP Jev client exposes bounded Retry-After metadata on 429", async () => {
  const request: JevRequest = {
    state: "sanitized",
    model: DEFAULT_JEV_MODEL,
    questions: { candidate: { type: "noul", instructions: "Candidate?" } },
  };
  for (const [header, expected] of [["retry-after-ms", "1250"], ["retry-after", "2"]] as const) {
    const client = new HttpJevClient({
      apiKey: "test-key-not-a-real-secret",
      fetchImpl: async () => new Response("rate limited", { status: 429, headers: { [header]: expected } }),
    });
    await assert.rejects(
      client.evaluate(request, { signal: new AbortController().signal }),
      (error: unknown) =>
        error instanceof JevApiError &&
        error.status === 429 &&
        error.retryAfterMs === (header === "retry-after-ms" ? 1_250 : 2_000),
    );
  }
});

test(`HTTP Jev client fails before fetch when ${TYPESAFE_API_KEY_ENV} is absent`, async () => {
  let called = false;
  const client = new HttpJevClient({
    apiKey: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  const request: JevRequest = {
    state: "sanitized",
    model: DEFAULT_JEV_MODEL,
    questions: { candidate: { type: "noul", instructions: "Candidate?" } },
  };

  await assert.rejects(
    client.evaluate(request, { signal: new AbortController().signal }),
    JevUnavailableError,
  );
  assert.equal(called, false);
});
