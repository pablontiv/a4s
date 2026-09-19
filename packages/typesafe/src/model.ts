/**
 * Frozen identifiers for the canonical TypeSafe surface (ADR 0020).
 *
 * The model is pinned to an exact id; mobile aliases such as `jev-latest` are
 * rejected in production routes. The base URL is passed explicitly so the SDK
 * never resolves it from the environment.
 */

/** Credential-only Pi provider id. Single source of the stored TypeSafe key. */
export const TYPESAFE_PROVIDER_ID = "typesafe";

/** Headless override env var, read only inside the resolver, after auth.json. */
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";

/** Explicit API root; never inherit the SDK's env fallback. */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

/** Pinned Jev model. A per-consumer override must be an exact id, never an alias. */
export const JEV_MODEL = "jev-1.13.0";
