# @a4s/typesafe

Canonical TypeSafe/Jev surface for A4S Pi extensions. Implements the frozen
surface decided in **ADR 0020** so the three consumers (pi-rule-compiler,
rpiv-mono, pi-auto-router) stop diverging on client, credential, model and
failure semantics.

## What it freezes

1. **SDK** — `@typesafe-ai/sdk` pinned to exactly `0.6.0`.
2. **Factory** — `createTypesafeClient({ apiKey, model?, baseURL?, fetch? })` builds
   a `TypeSafeClient` with `apiKey`, `baseURL` and `defaultModel` **always
   explicit**. The SDK never resolves `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` or
   its `jev-latest` default from the environment.
3. **Provider** — `createTypesafeProvider()` / `registerTypesafeProvider(pi)`: a
   credential-only Pi provider (`id: "typesafe"`, no models, no oauth) that stores
   and resolves the key via Pi's `auth.json` (0600).
4. **Resolver** — `createTypesafeAuthResolver({ env? })` resolves the key with
   **auth.json first** (`ctx.modelRegistry.getProviderAuth("typesafe")`), with
   `TYPESAFE_API_KEY` as a headless override only when auth.json has nothing. This
   inverts the legacy rule-compiler precedence (env over auth.json).
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
const client = createTypesafeClient({ apiKey: await resolveKey(ctx) });
// client.defaultModel === "jev-1.13.0"; missing key throws MissingTypesafeKeyError
```

## Tests

```
npm test --workspace @a4s/typesafe
```

Covers fail-closed before network, the pinned model and base URL, mobile-alias
rejection, no SDK env fallback, credential-only provider shape, and auth.json-first
resolver precedence with no env scraping.

## Pending (from ADR 0020)

- Distribution to vendor forks (private npm/tarball vs. optional peer dependency).
- `pi.registerProvider` behavior when several extensions register `typesafe`.
- SDK response compatibility with rule-compiler's strict `validateJevResponse`.
- PoC ran Pi 0.85.1; the workspace pins 0.84.4.
