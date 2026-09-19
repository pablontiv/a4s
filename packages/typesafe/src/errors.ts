/** Typed failures raised before any TypeSafe network call (ADR 0020, fail-closed). */

/** Raised when the resolved API key is absent or empty. Thrown before any request. */
export class MissingTypesafeKeyError extends Error {
  readonly code = "missing_key" as const;
  constructor(message = "TypeSafe API key is missing or empty") {
    super(message);
    this.name = "MissingTypesafeKeyError";
  }
}

/** Raised when a caller supplies a mobile model alias (e.g. `jev-latest`) instead of an exact id. */
export class MobileModelAliasError extends Error {
  readonly code = "mobile_model_alias" as const;
  constructor(model: string) {
    super(`Model "${model}" is a mobile alias; pin an exact model id (e.g. ${JSON.stringify("jev-1.13.0")})`);
    this.name = "MobileModelAliasError";
  }
}
