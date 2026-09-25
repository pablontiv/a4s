import { TypeSafeClient, type TypeSafeClientConfig } from "@typesafe-ai/sdk";
import { JEV_MODEL, TYPESAFE_BASE_URL } from "./model.ts";
import { MissingTypesafeKeyError, MobileModelAliasError } from "./errors.ts";

/** Options for the canonical client factory. The key is resolved by the caller. */
export interface CreateTypesafeClientOptions {
  /** Resolved API key. `undefined`, empty, or whitespace-only fails closed. */
  apiKey: string | undefined;
  /** Exact model id override. Defaults to the pinned {@link JEV_MODEL}. Aliases are rejected. */
  model?: string;
  /** API root override. Defaults to {@link TYPESAFE_BASE_URL}. */
  baseURL?: string;
  /** Per-attempt timeout supplied by the consumer's deadline authority. */
  timeoutMs: number;
  /** Custom fetch for transport configuration or tests. */
  fetch?: TypeSafeClientConfig["fetch"];
}

/** Reject mobile aliases so production never rides `jev-latest`. */
function assertPinnedModel(model: string): void {
  if (/latest/i.test(model)) throw new MobileModelAliasError(model);
}

/**
 * Build a {@link TypeSafeClient} with `apiKey`, `baseURL` and `defaultModel` always
 * explicit, so the SDK never reads `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` or the
 * `jev-latest` default from the environment. Fails closed with a typed
 * {@link MissingTypesafeKeyError} before any network call when the key is absent.
 */
export function createTypesafeClient(options: CreateTypesafeClientOptions): TypeSafeClient {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new MissingTypesafeKeyError();
  const model = options.model ?? JEV_MODEL;
  assertPinnedModel(model);
  return new TypeSafeClient({
    apiKey,
    baseURL: options.baseURL ?? TYPESAFE_BASE_URL,
    defaultModel: model,
    timeout: options.timeoutMs,
    // SDK debug logs include unredacted request bodies. Never inherit this from env.
    logLevel: "off",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
