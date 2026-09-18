# A4S Pi Rule Compiler

Private Pi extension that uses Jev as the semantic authority for compaction while extracting reviewable `RuleSignal` evidence in the same pass. Successful compaction automatically turns those signals into review-only rule proposals; `/retro-rules` is an idempotent retry/recovery command.

## Runtime contract

- `session_before_compact` returns a deterministic custom compaction assembled from Jev `keep`, `truncate`, and `drop` decisions.
- There is no native or generative summary fallback. Missing credentials, timeout, malformed response, oversized state/summary, abort, or API failure returns `{ cancel: true }`.
- The newest and true preparation-boundary messages are pinned. A selected durable rule candidate is always retained even when its immediate-continuity score is low.
- Large inputs are split into chronological windows; every compacted message receives one retention judgment. Rule questions are added only for roles that can carry direct authority (`user`, `toolResult`, `bashExecution`, `custom`), while generated assistant/summary roles still receive retention judgments.
- Every window shares one global scheduler: default concurrency is 1, `429`/`529` retries are bounded, `Retry-After` is honored up to 30 seconds, and the whole compaction remains abortable under a 180-second deadline.
- Requests are packed up to 120 questions only while verified below Jev 1.13's guarded budgets: 60k estimated tokens per request and 30k for state plus the longest question.
- RuleSignal batches are embedded in sanitized compaction details, then published as namespaced custom entries only after `session_compact` succeeds. Reload reconciliation recovers a batch if the process stopped after Pi persisted compaction but before publication.
- Successful compaction also appends a durable retro-pending marker. Manual/threshold compaction runs current-model synthesis plus Jev stage 2 directly from `session_compact`; overflow recovery with `willRetry=true` defers that work until `agent_settled` so Pi's retry is not delayed.
- Proposal receipts make duplicate success, reload, `agent_settled`, and `/retro-rules` replay idempotent. Retro stage 2 uses the same bounded scheduler. Retro failure never rolls back compaction and leaves signals plus pending state available for retry.
- Jev uses the pinned model `jev-1.13.0`. The extension registers a credential-only `typesafe` provider so `/login typesafe` stores an API key via Pi's own auth storage; the resolved credential is cached for the session. `TYPESAFE_API_KEY` in the environment takes precedence when set and bypasses stored-credential resolution entirely.
- Automatic retro and `/retro-rules` store proposals only. They never write Rootline documents or activate rules; `/retro-rules` exists solely for manual retry/recovery.
- The extension does not read, write, or replace gentle-engram entries.

## Use

From the repository root:

```sh
npm install
pi -e packages/pi-rule-compiler/src/index.ts
# then, inside Pi:
/login typesafe
```

Alternatively, set `TYPESAFE_API_KEY` in the environment before starting Pi to skip `/login`.

If Jev is unavailable, Pi compaction is deliberately cancelled and can be retried after restoring the dependency. Retro runs automatically after success; use `/retro-rules` only to retry preserved pending work after a model, Jev, or storage failure.

## Development

```sh
npm test --workspace @a4s/pi-rule-compiler
npm run typecheck --workspace @a4s/pi-rule-compiler
```

Tests use fake Jev and model gateways; they make no live TypeSafe calls.

## Design provenance

Whole-session fitting, repeated-state batching, and the conservative token estimator follow demonstrated patterns from [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) (MIT). This package implements its own Pi-specific schemas, deterministic summary assembler, privacy boundary, success-gated signal lifecycle, and recovery contract.

[`pi-jev`](https://github.com/TheoOliveira/pi-jev) (MIT) was evaluated but is not a dependency: its public package entrypoint and current internal client do not provide this package's pinned-model, strict-validation, window coverage, provenance, or success-only persistence contracts.
