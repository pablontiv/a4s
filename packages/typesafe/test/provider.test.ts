import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AuthContext } from "@earendil-works/pi-ai";
import { createTypesafeProvider } from "../src/provider.ts";
import { TYPESAFE_PROVIDER_ID } from "../src/model.ts";

/** AuthContext that reveals nothing — resolve must depend only on the credential. */
const denyingCtx: AuthContext = {
  async env() {
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

test("provider is credential-only: right id, api-key auth, no oauth", () => {
  const provider = createTypesafeProvider();
  assert.equal(provider.id, TYPESAFE_PROVIDER_ID);
  assert.ok(provider.auth.apiKey, "provider must expose api-key auth");
  assert.equal(provider.auth.oauth, undefined, "credential-only provider has no oauth");
});

test("api-key auth resolves a stored credential and nothing else", async () => {
  const apiKeyAuth = createTypesafeProvider().auth.apiKey;
  assert.ok(apiKeyAuth);
  const signal = new AbortController().signal;

  const resolved = await apiKeyAuth.resolve({
    ctx: denyingCtx,
    credential: { type: "api_key", key: "sk-stored" },
    signal,
  });
  assert.deepEqual(resolved, { auth: { apiKey: "sk-stored" }, source: "stored API key" });

  const missing = await apiKeyAuth.resolve({ ctx: denyingCtx, signal });
  assert.equal(missing, undefined);
});
