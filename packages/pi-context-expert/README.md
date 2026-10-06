# A4S Pi Context Expert

Private Pi extension that uses Jev as the semantic authority for deterministic compaction. Evidence is disabled by default; Ladder retrieval and Ladder-backed Evidence are explicit opt-ins.

This release supports Pi 1.0.3 and Pion 1.0.4. The extension uses the canonical `@earendil-works/pi-coding-agent` API for both hosts.

## Runtime contract

- `session_before_compact` uses a thin Pi `HostBinding` over `runCompaction()` from `@a4s/context-expert`.
- The binding converts real Pi messages to the neutral core type. It removes thinking and image blocks. It applies the existing private-data sanitization to text and tool input.
- The shared core preserves the first boundary and the configured recent tail. It keeps each tool call with its result for `keep`, `drop_result`, and `drop_call` decisions.
- The binding returns a Pi `CompactionResult` with the rendered summary, the original kept boundary, the original token count, cumulative file lists, and the upstream-compatible `fastJev` continuity details.
- Missing credentials, timeout, abort, HTTP failure, invalid response, rejection, or an unprocessable state returns `undefined`. Pi then runs its native compaction fallback once.
- The shared core fits state to 25,000 estimated tokens by default. It batches tool questions within a 30,000 estimated token request limit.
- Compaction details never contain RuleSignals. With Evidence off, successful compaction publishes only the sanitized corpus and its receipt; `basic` does not extract, publish, or synthesize rules.
- Evidence runs only when both `compaction.strategy=ladder` and `evidence.strategy=ladder`. After Pi confirms compaction and corpus publication, it issues its own fixed conservative Ladder query over the current branch corpus. It never consumes the projection made for an ordinary user query.
- Only full chunks or validated `short`/`long` source spans selected by that Evidence query enter extraction. The existing candidate-probability, generality, authority-probability, authority-confidence, and allowed-authority gates remain unchanged.
- Validated signal batches, retro-pending markers, and an Evidence receipt are appended only after selection and extraction both succeed. Batch digests, attempt markers, proposal receipts, and the final Evidence receipt make replay idempotent. Any selection/extraction failure publishes no Evidence artifact and never removes corpus.
- Manual/threshold Evidence success may run current-model synthesis plus Jev stage 2 from `session_compact`; overflow recovery with `willRetry=true` defers that review-only work until `agent_settled`. Retro failure never rolls back compaction and leaves signals plus pending state available for `/retro-rules` retry.
- Jev runs through Pi's native classifier runtime: Context Expert resolves the built-in `typesafe/jev-latest` catalog model and calls `ctx.modelRegistry.classify()`. Pi owns provider registration, `/login typesafe`, stored-credential precedence, the `TYPESAFE_API_KEY` headless fallback, request construction, and transport. Context Expert keeps its bounded scheduler, disables Pi's per-call retries so retry accounting remains deterministic, validates Pi-normalized answers, and fails closed. New artifacts record `typesafe/jev-latest`; persisted `jev-1.13.0` artifacts remain readable.
- Automatic retro and `/retro-rules` store proposals only. They never write Rootline documents or activate rules; `/retro-rules` exists solely for manual retry/recovery.
- Review is store-only. `/rules-review` lists stored proposals with their acceptance state, `/rules-show <id>` shows one candidate, and `/rules-accept <id>` records a manual acceptance receipt for a `propose` candidate. When no proposal is stored, `/rules-review` reports whether the latest session-local compaction had no eligible `user`/`custom` sources, filtered all eligible candidates, or retained signals awaiting retro; it never displays message content. Acceptance still writes nothing to Rootline or AGENTS.md; the durable apply of an accepted rule is deferred to the decision in ADR 0020.
- The extension does not read, write, or replace gentle-engram entries.
- With `compaction.strategy=ladder`, `context_with_system` derives a concrete sanitized user query from the pending request. Large branch corpora are first reduced by a deterministic lexical-plus-recency shortlist capped at 48 chunks and 20,000 estimated state tokens. The shortlist preserves durable append chronology across compaction attempts and rejects interleaved attempts rather than inventing an order. In one request, Jev classifies every candidate as `current`, `superseded`, `historical`, or `irrelevant` after checking explicit later-source indexes; ordinary retrieval deterministically hides superseded, irrelevant, or insufficiently confident evidence and renders accepted current or query-requested historical evidence in full. The validated result is reused from a bounded session-local cache keyed by the full corpus and query digests, so every model request in the same turn receives the identical projection without another Jev call. It validates complete candidate coverage, ids, spans, and both candidate and full-corpus consistency before rendering; the renderer still supports validated bounded source spans, and corpus entries are never changed. The request-local projection is a hidden custom message immediately after the latest user message, leaving Pi's leading system prompt and earlier cacheable transcript unchanged. Rendered sources carry explicit boundaries, are ordered oldest to newest, state that later sources supersede conflicting earlier sources, and warn that mutable repository state requires current-checkout verification. A successful non-empty-corpus evaluation appends a content-free projection receipt with cache status, full-corpus/query/projection digests, source/candidate/selected chunk counts, shortlist strategy, estimated state tokens, and rendered status. A failed evaluation is cached for the same corpus/query pair and appends one deduplicated content-free failure receipt containing only stage, category, digests, and counts. Any missing query or projection failure returns Pi's original context without additional omission. `basic` does not register this hook or spend Ladder quota.

## Receipts de fallo operativo

Pi guarda cada receipt con `appendEntry()`. El tipo es
`a4s.pi-context-expert.operational-failure.v1`. El esquema es
`a4s.operational-failure/v1`.

El receipt cubre fallos observados por callbacks propios en compactación,
corpus, Evidence, retro y Trigger. Solo contiene `timestamp`, `phase`, `code`,
`reason`, `willRetry` y el `attemptId` disponible. No contiene texto, rutas,
entorno, credenciales ni datos del error. La escritura es best-effort. Un fallo
de escritura no cambia la semántica del flujo.

`session_compact_failed` no identifica la extensión ni el intento. Context
Expert no atribuye ese evento. Pi o Pion conservan la observabilidad de ese
fallo terminal.

## Opt-in Trigger

The default configuration remains `compaction.strategy=basic`,
`trigger.mode=hint`, and `evidence.strategy=off`. The extension API accepts
flat `config` values for `compaction.strategy` (`basic|ladder`),
`trigger.mode` (`off|hint|auto`), and `evidence.strategy` (`off|ladder`);
invalid combinations preserve the prior safe configuration.

Run `/pi-context-expert-settings` in Pi or Pion to change these settings. The command shows the current Compaction, Trigger, and Evidence values. It also provides reset and cancel actions. The command confirms coupled Ladder changes, automatic Trigger, and reset. A successful change writes the file, reports the complete configuration, and reloads the extension once.

The entry point reads the persisted global file once at startup. It uses
`$PI_CODING_AGENT_DIR/pi-context-expert.json` when `PI_CODING_AGENT_DIR` is not
empty. Otherwise, it uses `~/.pi/agent/pi-context-expert.json`. It also reads
the former fixed path as a fallback when the configured path does not exist.
The file may contain only the same three flat, non-secret mode keys:

```json
{
  "compaction.strategy": "ladder",
  "trigger.mode": "off",
  "evidence.strategy": "off"
}
```

You can edit this JSON format manually. Run `/reload` in an active Pi or Pion
session after a manual change. You can also restart the host. The settings
command runs the reload for you. Reload replaces the extension runtime and its
in-memory Ladder projection caches. It preserves the session and persisted
corpus. A request that is already active keeps the prior runtime.

The command creates the directory when necessary. It publishes the JSON file
with an atomic rename and mode `0600`. A write failure leaves the active
configuration unchanged. A missing file, malformed JSON, non-object value,
unknown field, invalid mode, or invalid combination fails closed to the
complete basic configuration (`basic`, `hint`, `off`). The extension does not
read or write Pi `settings.json`. Provider credentials remain separate.

On `agent_settled`, an enabled Trigger first requires interactive UI, idle
state, at least 20% use of the active model's context window, no pending
messages, no cooldown, and an empty editor. It then resolves Pi's effective
`keepRecentTokens` for the active model and inspects the current projected
session. The Trigger fails closed unless retaining that recent tail still
leaves at least one complete older turn for compaction. This conservative gate
is recalculated after model changes and may omit a valid hint rather than show
one that `/compact` cannot execute.

Only after those deterministic gates pass does Trigger resolve a credential and
send Jev a text-free request with token count, context window, ratio, and
compactable-history state. `hint` displays a notification. Persisting
`trigger.mode=auto` is the operator's durable consent for automatic compaction;
no per-session acknowledgement or additional command is required. `auto` calls
only `ctx.compact()`, which enters the existing `session_before_compact`
handler. Trigger persistence contains only hint/compact cooldown metadata.

Supported Pi versions expose the editor text in TUI mode. The production Trigger uses that
value unless an embedding supplies the `trigger.editorHasText` runtime gate;
an editor-read failure or a non-TUI mode is treated as non-empty, so the
trigger fails closed.

## Use

From the repository root:

```sh
npm install
pion -e packages/pi-context-expert/src/index.ts
# then, inside Pi:
/login typesafe
```

Alternatively, when no stored `typesafe` credential exists, set `TYPESAFE_API_KEY` in the environment before starting Pi for headless use.

If Jev is unavailable, the hook returns `undefined` and Pi runs native compaction once. With both Ladder flags enabled, retro may run after successful Evidence extraction; use `/retro-rules` only to retry preserved pending work after a model, Jev, or storage failure.

## RPC callers must hold stdin open through `compact`

If you drive this extension over `pion --mode rpc` and issue a `compact`
command, **do not close the child process's stdin (EOF) until you have
received the matching `compact` response.** Closing stdin early — e.g.
piping a fixed command file with `< input.jsonl`, or any writer that ends
the pipe right after writing its commands — races the vendored RPC
transport's shutdown path and kills the in-flight compaction before Jev's
real HTTP round trip (15-50+ seconds) can finish.

### What actually happens (bead a4s-6ak.7/`.8`)

- `pion --mode rpc`'s stdin handling (`dist/modes/rpc/rpc-mode.js`) registers
  an unconditional `process.stdin.on("end", () => void shutdown())`. This
  fires the moment stdin closes, independent of whether a command is
  mid-flight.
- `shutdown()` immediately unsubscribes the session-event → RPC-output
  forwarder (the channel `extension_ui_request`/`compaction_end`/
  `entry_appended` events and this extension's own `ctx.ui.notify()` calls
  depend on), disposes the runtime, and calls `process.exit()` — all before
  waiting for any command already in progress.
- Under the stdin-close race, this extension classifies the interrupted request as `aborted` and returns `undefined`. Pi owns the native fallback. The closed RPC transport can prevent the extension notification and the final command response from reaching the client.
- This is vendored `@earendil-works/pi-coding-agent` RPC lifecycle behavior,
  not a defect in this package or something A4S patches in place (AGENTS.md
  scopes vendored runtimes as external providers). The correction is a
  usage/harness fix: keep stdin open until the response arrives.

### Detecting it

- **Reference driver**: `scripts/run-rpc-compact.ts` sends `compact` and
  awaits the correlated response (via `src/rpc-stdin-guard.ts`) before
  ending the child's stdin — the correct pattern to copy into your own RPC
  client. Run it with `npm run rpc:compact-driver --workspace
  @a4s/pi-context-expert -- --pi "$(command -v pion)" [-- <extra Pion args>]`.
- **Best-effort extension diagnostic**: when this extension classifies a
  compaction or retro failure as `"aborted"` while `ctx.mode === "rpc"`, it
  writes a single line to stderr prefixed
  `[a4s-pi-context-expert:rpc-stdin-guard]` (stderr is outside the RPC JSONL
  stdout protocol, so it cannot corrupt framing, and it never changes
  fallback or notification behavior). Grep an RPC caller's captured stderr
  for that prefix to confirm this failure mode.

## Development

```sh
npm test --workspace @a4s/pi-context-expert
npm run typecheck --workspace @a4s/pi-context-expert
```

Tests use fake Pi classifier and model gateways; they make no live TypeSafe calls.

The fixture-only Evidence eval is also offline:

```sh
npm run eval:evidence --workspace @a4s/pi-context-expert
```

It reports precision, recall, selected-boundary coverage, and false negatives for the checked-in true-rule, non-rule, and uncertain-candidate fixtures. Local session/corpus/result captures stay in ignored eval paths.

### Product E2E

```sh
npm run e2e --workspace @a4s/pi-context-expert -- --mode basic
npm run e2e --workspace @a4s/pi-context-expert -- --mode ladder
npm run e2e --workspace @a4s/pi-context-expert -- --mode evidence
```

This is a headless product test, not an E0 or fixture run. It starts the
installed `pion` binary in RPC mode with this extension, uses the configured Pion
model and real TypeSafe/Jev provider, sends four distinct benign non-secret
prompts generated for that run whose total exceeds Pi's production 20k
retained-token threshold, compacts, and verifies persisted corpus chunks plus
their receipt across a Pi restart. It can therefore incur real provider cost
and requires both providers to be configured. It neither prints RPC/session
content nor supplies a model, credential, fake, replay, or fork input.

The runner defaults to expecting `basic`. `--mode` is an assertion, not a
configuration override: before starting Pi, the runner reads the same fixed
global file and refuses to continue unless its resolved compaction strategy
matches the requested mode. For a deterministic Ladder run, save the example
configuration above before running the command; each child process reads that
persisted file at startup. In `ladder` mode, after real Pi/Jev compaction
and reload, the runner sends a subsequent real provider request and requires
the content-free rendered-projection receipt produced only after a successful
`context_with_system` Ladder evaluation.

`--mode evidence` requires the persisted file to set both
`compaction.strategy=ladder` and `evidence.strategy=ladder`, with Trigger set to
`off` or the headless-inert `hint`. It creates a real compactable session with
an explicit benign durable policy, then requires a valid signal batch,
review-only proposal, retro-pending marker, and Evidence receipt. After
restarting Pi against that session, it requires the same artifact ids and also
exercises the Ladder projection path. The runner stores session artifacts but
never prints prompts, proposal content, provider bodies, or credentials.

Every run intentionally preserves its evidence directory under
`artifacts/pi-context-expert-e2e/<timestamp>/`, including Pi's session artifact,
on both success and failure; the runner never deletes it automatically. Before
any cleanup, the task that invokes the run must record the exact run directory
and classify it as `retained local evidence` or `reproducible-disposable`. The
raw session is not durable task evidence; durable evidence is a sanitized result
recorded in the task. Retained local evidence remains preserved.
Reproducible-disposable output may be removed only after verified integration,
after confirming the exact recorded resource and all cleanup preconditions. A
matching artifacts pathname alone never authorizes deletion.

## Design provenance

Whole-session fitting, repeated-state batching, and the conservative token estimator follow demonstrated patterns from [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) (MIT). This package implements its own Pi-specific schemas, deterministic summary assembler, privacy boundary, success-gated signal lifecycle, and recovery contract.

[`pi-jev`](https://github.com/TheoOliveira/pi-jev) (MIT) was evaluated but is not a dependency: Context Expert uses Pi's built-in classifier runtime while retaining its own normalized-response validation, window coverage, provenance, and success-only persistence contracts.
