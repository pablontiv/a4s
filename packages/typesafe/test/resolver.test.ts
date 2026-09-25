import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "@earendil-works/pi-ai";
import { createTypesafeAuthResolver } from "../src/resolver.ts";
import { TYPESAFE_PROVIDER_ID } from "../src/model.ts";

/** Minimal ctx exposing only what the resolver reads, recording the provider asked for. */
function fakeCtx(auth: AuthResult | undefined): { ctx: ExtensionContext; asked: string[] } {
  const asked: string[] = [];
  const ctx = {
    modelRegistry: {
      async getProviderAuth(provider: string): Promise<AuthResult | undefined> {
        asked.push(provider);
        return auth;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, asked };
}

/** An env whose reads are recorded, to prove no env scraping when auth.json wins. */
function spyEnv(values: Record<string, string | undefined>): {
  env: Readonly<Record<string, string | undefined>>;
  reads: string[];
} {
  const reads: string[] = [];
  const env = new Proxy(values, {
    get(target, prop: string) {
      reads.push(prop);
      return target[prop];
    },
  }) as Readonly<Record<string, string | undefined>>;
  return { env, reads };
}

test("auth.json wins over env (precedence inverted from legacy)", async () => {
  const { ctx, asked } = fakeCtx({ auth: { apiKey: "sk-from-authjson" }, source: "stored API key" });
  const { env, reads } = spyEnv({ TYPESAFE_API_KEY: "sk-from-env" });
  const resolve = createTypesafeAuthResolver({ env });

  assert.equal(await resolve(ctx), "sk-from-authjson");
  assert.deepEqual(asked, [TYPESAFE_PROVIDER_ID]);
  assert.equal(reads.length, 0, "env must not be read when auth.json resolves a key");
});

test("env is the headless fallback only when auth.json has nothing", async () => {
  const { ctx } = fakeCtx(undefined);
  const { env, reads } = spyEnv({ TYPESAFE_API_KEY: "sk-headless" });
  const resolve = createTypesafeAuthResolver({ env });

  assert.equal(await resolve(ctx), "sk-headless");
  assert.deepEqual(reads, ["TYPESAFE_API_KEY"]);
});

test("whitespace auth.json key falls through to env without becoming sticky", async () => {
  let auth: AuthResult | undefined = { auth: { apiKey: "   " } };
  let calls = 0;
  const ctx = {
    modelRegistry: {
      async getProviderAuth(): Promise<AuthResult | undefined> {
        calls += 1;
        return auth;
      },
    },
  } as unknown as ExtensionContext;
  const { env } = spyEnv({ TYPESAFE_API_KEY: "sk-headless" });
  const resolve = createTypesafeAuthResolver({ env });

  assert.equal(await resolve(ctx), "sk-headless");
  auth = { auth: { apiKey: "sk-from-later-login" }, source: "stored API key" };
  assert.equal(await resolve(ctx), "sk-from-later-login");
  assert.equal(await resolve(ctx), "sk-from-later-login");
  assert.equal(calls, 2, "an unusable stored result is retried, then a usable login is cached");
});

test("returns undefined when neither source has a key (fail closed upstream)", async () => {
  const { ctx } = fakeCtx(undefined);
  const { env } = spyEnv({});
  const resolve = createTypesafeAuthResolver({ env });
  assert.equal(await resolve(ctx), undefined);
});
