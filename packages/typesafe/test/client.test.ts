import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTypesafeClient } from "../src/client.ts";
import { MissingTypesafeKeyError, MobileModelAliasError } from "../src/errors.ts";
import { JEV_MODEL, TYPESAFE_BASE_URL } from "../src/model.ts";

/** A fetch that fails the test if the client ever touches the network. */
function explodingFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  return () => {
    throw new Error("network must not be reached");
  };
}

test("fails closed with typed missing_key before any network call", () => {
  for (const apiKey of [undefined, "", "   "]) {
    let calledFetch = false;
    const fetch = () => {
      calledFetch = true;
      return Promise.reject(new Error("unreachable"));
    };
    assert.throws(
      () => createTypesafeClient({ apiKey, fetch }),
      (error: unknown) => {
        assert.ok(error instanceof MissingTypesafeKeyError);
        assert.equal((error as MissingTypesafeKeyError).code, "missing_key");
        return true;
      },
      `apiKey=${JSON.stringify(apiKey)} should fail closed`,
    );
    assert.equal(calledFetch, false, "fetch must not run when the key is missing");
  }
});

test("pins the Jev model and explicit base URL by default", () => {
  const client = createTypesafeClient({ apiKey: "sk-test", fetch: explodingFetch() });
  assert.equal(client.defaultModel, JEV_MODEL);
  assert.equal(client.defaultModel, "jev-1.13.0");
  assert.notEqual(client.defaultModel, "jev-latest");
  assert.equal(client.baseURL, TYPESAFE_BASE_URL);
});

test("accepts an exact model override", () => {
  const client = createTypesafeClient({
    apiKey: "sk-test",
    model: "jev-1.12.0",
    fetch: explodingFetch(),
  });
  assert.equal(client.defaultModel, "jev-1.12.0");
});

test("rejects mobile model aliases", () => {
  for (const model of ["jev-latest", "latest", "JEV-LATEST"]) {
    assert.throws(
      () => createTypesafeClient({ apiKey: "sk-test", model, fetch: explodingFetch() }),
      (error: unknown) => {
        assert.ok(error instanceof MobileModelAliasError);
        assert.equal((error as MobileModelAliasError).code, "mobile_model_alias");
        return true;
      },
      `model=${model} should be rejected`,
    );
  }
});

test("does not inherit the SDK env fallback for key or model", () => {
  const priorKey = process.env.TYPESAFE_API_KEY;
  const priorModel = process.env.TYPESAFE_DEFAULT_MODEL;
  process.env.TYPESAFE_API_KEY = "sk-from-env";
  process.env.TYPESAFE_DEFAULT_MODEL = "jev-latest";
  try {
    // Missing explicit key still fails closed even though env holds one.
    assert.throws(() => createTypesafeClient({ apiKey: undefined }), MissingTypesafeKeyError);
    // Explicit config wins; the env model alias is never adopted.
    const client = createTypesafeClient({ apiKey: "sk-explicit", fetch: explodingFetch() });
    assert.equal(client.defaultModel, JEV_MODEL);
  } finally {
    if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = priorKey;
    if (priorModel === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL;
    else process.env.TYPESAFE_DEFAULT_MODEL = priorModel;
  }
});
