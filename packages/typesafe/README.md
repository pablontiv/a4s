# @a4s/typesafe

Shared TypeSafe/Jev surface for A4S Pi extensions. It implements the canonical
contract accepted in **ADR 0020**.

## Canonical contract

1. **SDK** — `@typesafe-ai/sdk` pinned to exactly `0.6.0`.
2. **Factory** — `createTypesafeClient({ apiKey, timeoutMs, model?, baseURL?, fetch? })`
   builds a `TypeSafeClient` with `apiKey`, `baseURL`, `defaultModel`, the
   consumer-owned per-attempt timeout, and a safe non-debug log level **always
   explicit**. The SDK never resolves key, URL, model, or log-level behavior from
   the environment.
3. **Provider** — `createTypesafeProvider()` / `registerTypesafeProvider(pi)`: a
   credential-only Pi provider (`id: "typesafe"`, no models, no oauth) that stores
   and resolves the key via Pi's `auth.json` (0600).
4. **Resolver** — `createTypesafeAuthResolver({ env? })` resolves the key with
   **auth.json first** (`ctx.modelRegistry.getProviderAuth("typesafe")`), with
   `TYPESAFE_API_KEY` as a headless override only when auth.json has nothing. This
   inverts the legacy rule-compiler precedence (env over auth.json). Consumers use
   this canonical resolver instead of inspecting credential sources directly.
5. **Model** — `JEV_MODEL = "jev-1.13.0"`. A per-consumer override must be an exact
   id; mobile aliases (`jev-latest`) are rejected.
6. **Fail closed** — an absent or empty key throws a typed `MissingTypesafeKeyError`
   (`code: "missing_key"`) **before any network call**. The package never decides
   what happens after the failure; each consumer keeps its own policy.

## Usage

```ts
import {
  createTypesafeAuthResolver,
  createTypesafeClient,
  registerTypesafeProvider,
} from "@a4s/typesafe";

registerTypesafeProvider(pi); // once, at extension registration

const resolveKey = createTypesafeAuthResolver();
const client = createTypesafeClient({
  apiKey: await resolveKey(ctx),
  timeoutMs: configuredOperationBudgetMs,
});
// client.defaultModel === "jev-1.13.0"; missing key throws MissingTypesafeKeyError
```

## Tests

```
npm test --workspace @a4s/typesafe
```

Covers fail-closed before network, the pinned model and base URL, mobile-alias
rejection, explicit timeout behavior, safe logging despite SDK env configuration,
credential-only provider shape, and canonical credential resolution without
consumer-side credential-source inspection.
