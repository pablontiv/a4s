/**
 * @a4s/typesafe — canonical TypeSafe/Jev surface for A4S extensions (ADR 0020).
 *
 * One SDK pin, one client factory, one credential-only provider, one resolver,
 * one pinned model. Consumers never instantiate the SDK, read the environment,
 * or ride `jev-latest` on their own.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTypesafeProvider } from "./provider.ts";

export {
  JEV_MODEL,
  TYPESAFE_API_KEY_ENV,
  TYPESAFE_BASE_URL,
  TYPESAFE_PROVIDER_ID,
} from "./model.ts";
export { MissingTypesafeKeyError, MobileModelAliasError } from "./errors.ts";
export { createTypesafeClient, type CreateTypesafeClientOptions } from "./client.ts";
export { createTypesafeProvider } from "./provider.ts";
export {
  createTypesafeAuthResolver,
  type TypesafeAuthResolver,
  type TypesafeAuthResolverOptions,
} from "./resolver.ts";

/** Register the credential-only TypeSafe provider on a Pi extension host. */
export function registerTypesafeProvider(pi: ExtensionAPI): void {
  pi.registerProvider(createTypesafeProvider());
}
