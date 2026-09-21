# A4S Pi Rule Compiler

Private Pi extension that uses Jev as the semantic authority for compaction while extracting reviewable `RuleSignal` evidence in the same pass. Successful compaction automatically turns those signals into review-only rule proposals; `/retro-rules` is an idempotent retry/recovery command.

## Runtime contract

- `session_before_compact` returns a deterministic custom compaction assembled from Jev `keep`, `truncate`, and `drop` decisions.
- There is no native or generative summary fallback. Missing credentials, timeout, malformed response, oversized state/summary, abort, or API failure returns `{ cancel: true }`.
- The newest and true preparation-boundary messages are pinned. A selected durable rule candidate is always retained even when its immediate-continuity score is low.
- Large inputs are split into chronological windows; every compacted message receives one retention judgment. Rule-candidate questions are added only for roles that can originate authority from intent or an explicit decision (`user`, `custom`). `toolResult` and `bashExecution` still receive retention judgments but never enter the rule-candidate pool: their content is evidence, not authority. Generated assistant/summary roles likewise receive only retention judgments.
- Every window shares one global scheduler: default concurrency is 1, `429`/`529` retries are bounded, `Retry-After` is honored up to 30 seconds, and the whole compaction remains abortable under a 180-second deadline.
- Requests are packed up to 120 questions only while verified below Jev 1.13's guarded budgets: 60k estimated tokens per request and 30k for state plus the longest question.
- RuleSignal batches are embedded in sanitized compaction details, then published as namespaced custom entries only after `session_compact` succeeds. Reload reconciliation recovers a batch if the process stopped after Pi persisted compaction but before publication.
- Successful compaction also appends a durable retro-pending marker. Manual/threshold compaction runs current-model synthesis plus Jev stage 2 directly from `session_compact`; overflow recovery with `willRetry=true` defers that work until `agent_settled` so Pi's retry is not delayed.
- Proposal receipts make duplicate success, reload, `agent_settled`, and `/retro-rules` replay idempotent. Retro stage 2 uses the same bounded scheduler. Retro failure never rolls back compaction and leaves signals plus pending state available for retry.
- Jev uses the pinned model `jev-1.13.0`. The extension registers a credential-only `typesafe` provider so `/login typesafe` stores an API key via Pi's own auth storage; the resolved credential is cached for the session. `TYPESAFE_API_KEY` in the environment takes precedence when set and bypasses stored-credential resolution entirely.
- Automatic retro and `/retro-rules` store proposals only. They never write Rootline documents or activate rules; `/retro-rules` exists solely for manual retry/recovery.
- Review is store-only. `/rules-review` lists stored proposals with their acceptance state, `/rules-show <id>` shows one candidate, and `/rules-accept <id>` records a manual acceptance receipt for a `propose` candidate. When no proposal is stored, `/rules-review` reports whether the latest session-local compaction had no eligible `user`/`custom` sources, filtered all eligible candidates, or retained signals awaiting retro; it never displays message content. Acceptance still writes nothing to Rootline or AGENTS.md; the durable apply of an accepted rule is deferred to the decision in ADR 0020.
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

## RPC callers must hold stdin open through `compact`

If you drive this extension over `pi --mode rpc` and issue a `compact`
command, **do not close the child process's stdin (EOF) until you have
received the matching `compact` response.** Closing stdin early — e.g.
piping a fixed command file with `< input.jsonl`, or any writer that ends
the pipe right after writing its commands — races the vendored RPC
transport's shutdown path and kills the in-flight compaction before Jev's
real HTTP round trip (15-50+ seconds) can finish.

### What actually happens (bead a4s-6ak.7/`.8`)

- `pi --mode rpc`'s stdin handling (`dist/modes/rpc/rpc-mode.js`) registers
  an unconditional `process.stdin.on("end", () => void shutdown())`. This
  fires the moment stdin closes, independent of whether a command is
  mid-flight.
- `shutdown()` immediately unsubscribes the session-event → RPC-output
  forwarder (the channel `extension_ui_request`/`compaction_end`/
  `entry_appended` events and this extension's own `ctx.ui.notify()` calls
  depend on), disposes the runtime, and calls `process.exit()` — all before
  waiting for any command already in progress.
- `AgentSession.compact()` (`dist/core/agent-session.js`) throws
  `"Compaction cancelled"` when this extension's `session_before_compact`
  hook returns `{cancel: true}`. Under the stdin-close race, that "aborted"
  classification (see `classifyCompactionError` in `src/extension.ts`) is
  the ordinary outcome — but the forwarder that would carry this
  extension's own diagnostic notify to the RPC client is often already
  torn down, so the RPC caller only sees a fast, generic
  `{"success":false,"error":"Compaction cancelled"}` with no subcode.
- This is vendored `@earendil-works/pi-coding-agent` RPC lifecycle behavior,
  not a defect in this package or something A4S patches in place (AGENTS.md
  scopes vendored runtimes as external providers). The correction is a
  usage/harness fix: keep stdin open until the response arrives.

### Detecting it

- **Reference driver**: `scripts/run-rpc-compact.ts` sends `compact` and
  awaits the correlated response (via `src/rpc-stdin-guard.ts`) before
  ending the child's stdin — the correct pattern to copy into your own RPC
  client. Run it with `npm run rpc:compact-driver --workspace
  @a4s/pi-rule-compiler -- --pi <path-to-pi> [-- <extra pi args>]`.
- **Best-effort extension diagnostic**: when this extension classifies a
  compaction or retro failure as `"aborted"` while `ctx.mode === "rpc"`, it
  writes a single line to stderr prefixed
  `[a4s-pi-rule-compiler:rpc-stdin-guard]` (stderr is outside the RPC JSONL
  stdout protocol, so it can't corrupt framing, and it never changes
  cancel/notify semantics). Grep an RPC caller's captured stderr for that
  prefix to confirm this failure mode even when the client-facing response
  is the generic `"Compaction cancelled"` message.

## Development

```sh
npm test --workspace @a4s/pi-rule-compiler
npm run typecheck --workspace @a4s/pi-rule-compiler
```

Tests use fake Jev and model gateways; they make no live TypeSafe calls.

## Design provenance

Whole-session fitting, repeated-state batching, and the conservative token estimator follow demonstrated patterns from [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) (MIT). This package implements its own Pi-specific schemas, deterministic summary assembler, privacy boundary, success-gated signal lifecycle, and recovery contract.

[`pi-jev`](https://github.com/TheoOliveira/pi-jev) (MIT) was evaluated but is not a dependency: its public package entrypoint and current internal client do not provide this package's pinned-model, strict-validation, window coverage, provenance, or success-only persistence contracts.
