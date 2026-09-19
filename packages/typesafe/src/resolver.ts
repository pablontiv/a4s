import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "@earendil-works/pi-ai";
import { TYPESAFE_API_KEY_ENV, TYPESAFE_PROVIDER_ID } from "./model.ts";

export interface TypesafeAuthResolverOptions {
  /** Environment source for the headless override. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Resolves the TypeSafe API key for a request, or `undefined` when none is stored. */
export type TypesafeAuthResolver = (ctx: ExtensionContext) => Promise<string | undefined>;

/**
 * Single credential resolver for TypeSafe (ADR 0020). Precedence is auth.json
 * first — `ctx.modelRegistry.getProviderAuth("typesafe")` — with
 * `TYPESAFE_API_KEY` acting only as a headless override when auth.json has
 * nothing. No consumer reads the environment on its own. This inverts the
 * legacy rule-compiler order, where env won over auth.json.
 */
export function createTypesafeAuthResolver(
  options: TypesafeAuthResolverOptions = {},
): TypesafeAuthResolver {
  let cached: AuthResult | undefined;
  return async (ctx: ExtensionContext): Promise<string | undefined> => {
    if (!cached) cached = await ctx.modelRegistry.getProviderAuth(TYPESAFE_PROVIDER_ID);
    const stored = cached?.auth.apiKey?.trim();
    if (stored) return stored;
    const envKey = (options.env ?? process.env)[TYPESAFE_API_KEY_ENV]?.trim();
    return envKey ? envKey : undefined;
  };
}
