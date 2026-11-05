# Native objective succession and host handoff

## Result

All four bounded stages passed the targeted evidence reconciler on official compiled OMP 18.16.0, embedded Bun 1.4.4, in interactive PTYs with `NODE_PATH` unset. No server was started/stopped. All six owned hosts and six command workers exited with code 0. There were no commits, installs, or changes to earlier retained proof files.

Each objective has two native tasks (`native-first` then dependent `native-successor`), an independent command inventory, and `named-blocker` with `operator-authorization-not-granted`. Final objective status is intentionally `blocked`: all three executable items completed, and the fourth has that named blocker. Successor dispatch required no operator prompt. Slash commands below exercised lifecycle boundaries, not item admission.

| Stage | Result | Workflow ID | Exact event evidence (`evidence/<directory>/events.jsonl`) |
| --- | --- | --- | --- |
| S1 baseline | pass | `native-objective-native-succession-S1-0502` | `S1`: request line 7, first receipt 18, successor request 23, successor receipt 31, clean exit 42 |
| S2 turn boundary | pass | `native-objective-native-succession-S2-0503` | `S2`: request 7 at 05:03:36.732Z; root `turn_end` 11 before first receipt 18 at 05:04:19.267Z; successor request 23, receipt 31, clean exit 42 |
| S3 context rotation | pass after retry | `native-objective-native-succession-S3-rotation-0507` | `S3-rotation`: request 7 at 05:08:03.694Z; `session_compact` 15 at 05:08:32.409Z; receipt 21 at 05:08:45.699Z; successor request 26, receipt 34, clean exit 45 |
| S4 real extension reinitialization | pass after retry | `native-objective-native-succession-S4-recovery-0506` | `S4-recovery`: request 7; old instance shutdown 13; new root instance start 14; activity recovered 16; existing workflow attached 17; first receipt 23; successor request 28, receipt 36; clean exit 47 |

Dates in these events are 2026-11-05 UTC. `summary.json` in each directory records checks and workflow IDs. `state-updates.jsonl` and `state` events retain running/completed/blocked item state. Command receipts and inventory artifacts are alongside them.

S4 used the actually supported `/restart` TUI command, verified in installed source `src/slash-commands/builtin-lifecycle.ts:883-889`: restart with the same flags and resume the current session. It reinitialized the factory in the same process: instance `0504e805-85fa-47cb-a77a-f4c2295f437b` became `6af3cc51-ee4a-4a07-81c2-c93505e6e21d`, with the same session `01a1aa1a-a4db-73d8-932e-cbf4b7cfbea2`, workflow ID and queues. The recovered activity resumed the durable pending handoff, sent it once, and accepted one result. This is not a claim of OS-process crash recovery or code-version update safety.

## Exact build and execution commands

From repository root, using the already installed SDK 1.25.0 and existing private Bun/config snapshot:

```sh
poc/temporal-omp/omp/.runtime/package/bin/bun poc/temporal-omp/native-objective/prepare.mjs
poc/temporal-omp/omp/.runtime/package/bin/bun poc/temporal-omp/native-objective/build.ts
```

Preparation snapshots only the earlier probe's private config/database into this slice's ignored `.runtime/`, without printing credentials. No user's live session is resumed. Build reuses `../omp/build.ts` with optional `A4S_TEMPORAL_BUILD_ROOT`; default OMP probe behavior is unchanged. Deployed files live in ignored `dist/`, with a build manifest. `runtime-paths.ts` uses the proven first-import initialization. Shared SDK modules resolve from the existing objective installation, not a new install or copied tree.

The exact command-worker and host pairs were:

```sh
node poc/temporal-omp/native-objective/command-worker.mjs poc/temporal-omp/native-objective/evidence/S1 native-succession-S1-0502
bash poc/temporal-omp/native-objective/launch.sh S1 native-succession-S1-0502
node poc/temporal-omp/native-objective/command-worker.mjs poc/temporal-omp/native-objective/evidence/S2 native-succession-S2-0503
bash poc/temporal-omp/native-objective/launch.sh S2 native-succession-S2-0503
node poc/temporal-omp/native-objective/command-worker.mjs poc/temporal-omp/native-objective/evidence/S3 native-succession-S3-0503
bash poc/temporal-omp/native-objective/launch.sh S3 native-succession-S3-0503
node poc/temporal-omp/native-objective/command-worker.mjs poc/temporal-omp/native-objective/evidence/S4 native-succession-S4-0504
bash poc/temporal-omp/native-objective/launch.sh S4 native-succession-S4-0504
node poc/temporal-omp/native-objective/command-worker.mjs poc/temporal-omp/native-objective/evidence/S4-recovery native-succession-S4-recovery-0506
bash poc/temporal-omp/native-objective/launch.sh S4-recovery native-succession-S4-recovery-0506
node poc/temporal-omp/native-objective/command-worker.mjs poc/temporal-omp/native-objective/evidence/S3-rotation native-succession-S3-rotation-0507
bash poc/temporal-omp/native-objective/launch.sh S3-rotation native-succession-S3-rotation-0507 --config /home/shared/harness/a4s/poc/temporal-omp/native-objective/rotation-config.yml
```

Each host is `--max-time 210s`, `--tools task`, synchronous task configuration, `--no-extensions --no-skills --no-rules --no-context-files --no-lsp --no-title`, explicit deployed extension, model `cliproxy/gpt-6.1-sol`, private session directory and non-source cwd. Command workers run separately and share only their stage's evidence directory; they reuse `../objective/activities.mjs` and its fixed inventory command.

Deterministic stdin driving used `write` to `proc://<owned-service>`:

- S3 initial: `/compact\n`, then `\r` (LF alone did not immediately submit).
- S4 initial: `ESC/restart\r` was incorrectly interpreted as ordinary `restart` text, not a slash command. No extension restart occurred; this attempt is retained as a failed stage, not reused as a pass.
- S4 recovery: `/restart\r` while `native-first` was durably pending, after `activity_request` and before its scheduled dispatch.
- S3 rotation: `/compact\r` while pending. `rotation-config.yml` sets `compaction.keepRecentTokens: 1` and `reserveTokens: 1024`; a real compaction committed before the result.
- Completed hosts: `/exit\r`; earlier Ctrl-C inputs only interrupted/cleared input and did not themselves establish exit. Actual `host_exit` events establish exit code 0.

Command workers were stopped only after host completion using `kill -TERM 143480 144087 144468 145193 146907 147485`; all returned code 0. The existing Temporal server was untouched.

Reconciliation commands and observed exit codes:

```sh
node poc/temporal-omp/native-objective/summarize.mjs S1           # 0, pass
node poc/temporal-omp/native-objective/summarize.mjs S2           # 0, pass
node poc/temporal-omp/native-objective/summarize.mjs S3-rotation  # 0, pass
node poc/temporal-omp/native-objective/summarize.mjs S4-recovery  # 0, pass
node poc/temporal-omp/native-objective/summarize.mjs S3           # 1, retained failed attempt
node poc/temporal-omp/native-objective/summarize.mjs S4           # 1, retained failed attempt
```

The initial S3 terminal reported `Compaction failed: Nothing to compact (session too small)`; no `session_compact` was recorded. Lower retained-token configuration repaired that precondition in a separate run. No broad test, lint, or repository build was run.

## Controller and receipt contract

`workflow.ts` follows the objective batch/dependency model without modifying its earlier proven workflow. Native activities are pinned to a mandate-derived native queue hosted only when `ctx.hasUI`; command activities use another mandate-derived queue/worker. Workflow identity is stable for that mandate. `REJECT_DUPLICATE` and `WorkflowExecutionAlreadyStartedError` attach to the existing workflow rather than starting another run. Activity heartbeats preserve bounded waiting and retries reconnect to durable state.

A SQLite table keyed by canonical full binding (`mandateId`, `itemId`, `stage`, `attempt`, `revision`, `generation`) stores pending/sent/accepted state and the accepted receipt. The prompt and child output carry a structured `A4S_BINDING:{...}` token. The root parses tokens from actual task input string fields and child output and compares canonical binding equality, not arbitrary substring membership. A conditional SQLite update accepts only a sent binding; already accepted results are rejected. Native receipts are `native_host_activity`, `nativeHostProof:true`; the command receipt remains `bootstrap_command_activity`, false. Task children inherit hooks but never start workers because they lack UI.

The first native activity has an intentional 30-second durable dispatch delay to expose lifecycle boundaries without operator intervention in objective succession. Restart recovery exercised this pending-before-send boundary. The resulting successor is dispatched automatically without a second operator prompt.

## Limits

- The proven reload mechanism is same-version `/restart` factory reinitialization, not extension hot replacement or self-update. `/reload-plugins` was inspected, not executed: `builtin-marketplace.ts:25-42` refreshes discovery/skills/slash commands/task agents/MCP, not extension factories.
- Pending-before-send recovery is proven. Recovery after `sendMessage` but before receipt acceptance, in-flight child loss, OS-process crash, stale generation takeover and external-effect reconciliation remain unproven.
- SQLite transition to `sent` precedes `sendMessage`; these cannot be made atomic with the exposed API. A crash in that interval can lose delivery; this probe does not claim crash-safe exactly-once dispatch. Late/duplicate acceptance is guarded in code, but adversarial duplicate/wrong-binding injections were not exercised here.
- Bindings use numeric experiment revision/generation counters, not Git revisions or authority leases. No engineering/audit gate chain or independent semantic task validator is claimed.
- Evidence reconciles observed event ordering and binding counts; it is not an independent Temporal-history verifier. It does not rehash deployment files at reconciliation time. The reused build manifest records known build inputs but does not list the new contracts module separately.
- Runtime bundling retains the earlier SDK/Linux-x64-specific restrictions. Credentials, private sessions, deployment bundles and SQLite handoff files are ignored; sanitized events, receipts, source snapshots and summaries remain retained.
