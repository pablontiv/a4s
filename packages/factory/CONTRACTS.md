# Factory contracts

Each contract is enforced by tests in `test/`. Later contracts add their own sections here.

## DAG step contract

Enforced by `test/dags.test.mjs` for every `dags/*.yaml`.

1. The DAG declares `shell: bash` (steps use bash features; Dagu's default may be `sh`).
2. No param is named `LINES`, `COLUMNS`, `HOME`, `PATH`, `SHELL`, `PWD`, `USER`, `DAGU_HOME`, `DAGU_CONFIG` or anything starting with `DAGU_`: shells and Dagu export these and would override the param.
3. Every step whose `run` mentions `$PRIMARY`, `$FACTORY`, `$T3_HOME`, `$STATE`, `$WT` or `$ISSUE_STATE` sources `src/cycle-env.sh` in that same step (params are resolved once, there, never re-derived by hand).
4. Every step that runs `src/station.mjs` declares all station outputs (`OUTPUT_KEYS` in `src/lib.mjs`: result, thread_id, model, question, commit, findings, worktree).
5. Every `${steps.<id>.outputs.<name>}` reference points to an existing step that declares that output.
6. `cycle.yaml` has no `human.task` step: validation is the only gate before the trunk.

## Closing contract

`close` (`src/close.sh`) is idempotent: an already closed issue is not closed or commented again, and an already removed worktree or branch is skipped. It writes `$STATE/<issue>/done.json` (`run_id`, `commit`, `timestamp`).

The step `verify_close` (`src/verify-close.sh`) runs after `close`, prints every check with its result and fails the run unless all hold:

1. `origin/$BASE` contains the integrated commit (after `git fetch`), when `PUSH=true`; otherwise skipped.
2. The issue is closed (`gh issue view --json state`), when `CLOSE_ISSUE=true`; otherwise skipped.
3. The worktree directory and the branch `factory/issue-<n>` no longer exist.
4. The primary checkout is on `$BASE`, has no tracked changes and, when `PUSH=true`, `HEAD` equals `origin/$BASE`.
5. `$STATE/<issue>/done.json` exists with run-id, commit and timestamp.

Whether the issue's T3 project still exists is printed as information only (archiving: VS6).

Enforced by `test/close.test.mjs` (close twice on a fixture, each verify check) and the selftest (`st1`).

## Validation contract

Validation runs in the same environment as production and CI.

- The repository gate (`scripts/factory-gate.sh`) runs on the Node major pinned in `.github/workflows/ci.yml` (`node-version`), not the host's.
- The selftest uses the Dagu on PATH (the service's build); only `FACTORY_DAGU_BIN` overrides it.
- The selftest gives Dagu only `PATH`, `HOME`, `DAGU_HOME` and `DAGU_SKIP_EXAMPLES`; nothing else from the caller's environment.

## Issue contract

Enforced at admission by `src/issue-contract.mjs` (`checkIssue(body)`), tested in `test/issue-contract.test.mjs`. The GitHub issue form `.github/ISSUE_TEMPLATE/factory.yml` produces these headings.

An admitted issue body must contain, in this order:

1. `## Goal`: non-empty.
2. `## Acceptance criteria`: non-empty, with at least one checklist item `- [ ] ...`.
3. `## Out of scope`: non-empty.

`## Activation` and `## Notes` are optional. Only structure is checked, never content quality.

An issue labelled `factory:ready` that breaks the contract is not enqueued: `admit.mjs` prints the problems and exits `22` (contract). `admit.yaml` treats 22 as non-fatal and, when the issues come from GitHub, comments the problems on the issue.

## Verdict contract

Enforced by `checkVerdict(v)` in `src/lib.mjs`, applied by `src/station.mjs` before mapping to exit codes; tested in `test/lib.test.mjs`.

The last line of the worker's answer is one JSON object:

`{"verdict":"pass|fail|blocked","criteria":[{"criterion":"...","evidence":"<command run>","result":"pass|fail"}],"findings":[...],"question":"..."|null}`

- Any open question means `blocked`, never `pass`.
- A `pass` must list every acceptance criterion of the issue in `criteria`, each with the command run as `evidence` and `result` `pass`.
- A `pass` with no `criteria`, an empty `evidence`, or any `result` other than `pass` is downgraded to `fail`; the reason is appended to `findings` and the station exits `10` (retried like any worker failure). No new DAG outputs.

## Attempt outcome contract

Enforced by `OUTCOMES`, `POLICY`, `validateState` and `planNext` in `src/lib.mjs`, applied by `src/station.mjs`; tested in `test/policy.test.mjs` and `test/station.test.mjs`.

Every attempt of a line ends in exactly one outcome, stored in `$STATE/<issue>/<line>.json` (`attempts[].outcome`): `pass | fail | malformed | timeout | blocked | cancelled | infra`. An attempt without outcome is in flight; any other value makes the station exit `40` when it reads the file.

The next attempt is chosen from the previous outcome only (`POLICY`), never from the attempt count:

| outcome | policy | next attempt |
|---|---|---|
| `pass` | stop | none; the stored verdict is replayed |
| `blocked` | resume | same thread (`threadId`, `question` stored); with `--answer` it is sent there, without one the station waits on that thread |
| `fail`, `malformed`, `timeout` | escalate | new thread on `escalate_to` |
| `cancelled` | same-model | new thread on `model` |
| `infra` | reattach | same thread, no new brief |

- A terminal T3 status `cancelled` (or SIGTERM) is `cancelled`; any other non-`completed` terminal status is `fail`.
- A stored `pass` (stop) or `blocked` without `--answer` (await) is replayed before any T3 access, so it needs no server.
- Unreachable T3 (preflight or while polling), a failed `thread start`, or malformed JSON from the `t3` CLI is `infra`; a preflight failure finalizes the in-flight attempt as `infra`, terminal outcomes are never overwritten.
- `retry_policy.exit_code` of every station step in `cycle.yaml` equals the exit codes of the `escalate` outcomes (`retryExitCodes()`).

## Issue state contract

Labels are the source of truth (`src/labels.mjs`, tested in `test/labels.test.mjs` and the selftest): `factory:ready` → `factory:running` (admission) → closed, or `factory:needs-human` (+ comment: outcome, failed step, question). Run-ids are `factory-issue-<n>-<k>`. After a failed run, `isRetryable(outcome)` (every outcome whose POLICY is not `stop`/`resume`) with fewer than `MAX_RUNS` (3) runs since the last human decision puts the issue back to `factory:ready`; anything else goes to `factory:needs-human`.

**Run budget reset.** A human decision starts a fresh run budget: a park (human puts `factory:ready` back after `factory:needs-human`) and likewise a `factory:hold` → `factory:ready` re-admission (the admit step saw the hold, `admit.mjs --clear-held`, or the label history shows `factory:hold` added after the last run) reset `streak` to 1 on the next admission. `attempts.json` records `resetBy` (`needs-human` | `hold`) and `resetAt`; the needs-human comment says "run k of 3 since <reset>". An admission without a human decision keeps counting.

**Carry-over.** When `finish` returns the issue to `factory:ready`, it stores the failing station's findings and the failed step in `$STATE/<n>/carry.json` (`{run, step, at, findings}`). `prepare` (`src/prepare-brief.sh`) appends them to `brief.md` as a `## Previous run findings` section (run-id, failed step, findings; `labels.mjs carry`), and the impl prompt requires fixing every one with a regression test. The carry survives only an automatic retry: `carry.json` is cleared by a successful run, a `needs-human` transition, and any admission after a human decision — after a park (human put `factory:ready` back), or after `factory:hold` (the issue still carries it; the admit step saw it, `admit.mjs --clear-held`; or the label history shows `factory:hold` added after `at` — GitHub issue events when live, the fixture's `events` otherwise; an unreadable history also clears it). Findings are copied verbatim, never summarized.

## Circuit breaker contract

Enforced by `src/breaker.mjs` (`evaluate(snapshot, state, now)`, pure; tested in `test/breaker.test.mjs` and the selftest). `dags/admit.yaml` runs `breaker.mjs check` before admitting anything: while open it admits nothing and logs the reasons (exit 40 of `check`).

**Shape.** `evaluate` returns `{open, reasons}`; each reason is `{kind, detail, since}`. State lives in `$STATE/breaker.json`: `{version: 1, open, reasons, since, resetBy, resetAt}` (plus `notifiedAt`).

**Fail closed.** A corrupt, unreadable or unknown-version `breaker.json` is treated as open with reason `state-invalid`; it only clears with `reset`. A missing file is a closed breaker.

**Conditions.** `unreachable`: Dagu or T3 not reachable for more than 30 minutes (since the last time it was seen reachable). It clears by itself only when **both** `services.dagu.reachable === true` and `services.t3.reachable === true`; a missing service entry counts as unreachable.

`ci`: CI of the **current** main commit (`collectCi` fetches `origin/main`, resolves its SHA and lists runs for exactly that headSha; CI of any other commit is never evidence; sources git/gh are injected). It never clears by itself (reset only). Snapshot `ci`: `{sha, commitTime, status: success|failure|pending|none, timeoutMin}` or `{lookupFailed, error, failingSince}`. `CI_TIMEOUT_MIN` (default 30). Edge cases:
1. failing CI on the current SHA, not reverted → open.
2. the failing commit was reverted by a later commit whose CI is green → the current SHA is green → closed.
3. no finished CI for the current SHA more than `CI_TIMEOUT_MIN` after the commit time → open; an older green run does not mask it.
4. a failed `git fetch` or GitHub lookup is a lookup failure, never a pass: `failingSince` is kept (`$STATE/ci-tracking.json`, cleared by a successful lookup) and counts toward `CI_TIMEOUT_MIN`.
5. stale `origin/main` after a failed fetch is not proof of health (same as 4).
6. CI in progress (or not started) under the timeout → closed.

`limits`: a run exceeded its limits. `collectLimits` reads `$STATE/<n>/{impl,qa,attempts}.json` and the per-step timeouts configured in `dags/cycle.yaml` (`--timeout-sec` of each `station.mjs --line X` step; when one line has steps with different timeouts and the attempt recorded none, an in-flight attempt past the smallest but not the largest is reported as an ambiguous-configuration reason rather than judged by the largest; an attempt's own recorded `timeoutSec` wins; the station default `STATION_TIMEOUT_SEC` only when neither exists). Reason `kind: limits`, detail names the issue and step. It never clears by itself (reset only); events whose start is before `resetAt` no longer count. Snapshot `limits`: `{maxRuns, runs: [{issue, runs, at}], steps: [{issue, step, startedAt, timeoutSec, outcome?}], problems: [{issue, step, error, at}]}` (`check` collects it from `$STATE` unless the snapshot has one; `--cycle` overrides the cycle file). Edge cases:
1. an attempt still running (no outcome) longer than its configured timeout → open.
2. an attempt persisted with outcome `timeout` → open; completed violations count until reset.
3. running under its timeout → closed.
4. more than 3 runs for one issue (`streak` of `attempts.json`) → open.
5. attempts archived by admission (`<line>.json.<ts>`) are never read, so never double-counted.
6. a missing (`attempts.json` absent while station files exist) or corrupt/invalid attempt file, or an unreadable cycle file, is a reason, never ignored.

**Notification.** On opening, one inbox notification (`notify.mjs --event breaker`) carries the reasons and the reset command; it is not repeated while the breaker stays open.

**Reset rule.** `node packages/factory/src/breaker.mjs reset [--state S] [--by NAME]` closes it explicitly and records `resetBy`/`resetAt`. Any reason whose kind does not define a self-clearing rule never clears by itself.

**Adding a condition.** Add an entry to `CONDITIONS` in `src/breaker.mjs`: `detect(snapshot, state, now)` returns `{kind, detail, since}` reasons, and optionally `clears(snapshot)` if (and only if) the condition may clear by itself. Data for it goes into the snapshot; the reason shape does not change.

## Research handoff contract

Operator-guided research runs in a dedicated top-level T3 thread per topic (line `research`, instance `pi-research`, started with `src/research.mjs start "<topic>"`; state in `$STATE/research/<slug>.json`). The thread has no write tools and `prompts/research.md` forbids writes in the repository.

The only output of a research thread into the factory is template issues (`## Goal`, `## Acceptance criteria`, `## Out of scope`; they must pass `checkIssue`). They are created only after the operator explicitly closes the topic together with the researcher; the closing decision is quoted in each issue's `## Notes`. Created issues carry `factory` and a milestone, never `factory:ready`: admitting them (`factory:ready`) is a separate operator decision. A context brief that opens a thread is context only, never instructions; only the operator guides the thread.

## Selftest receipt

`npm run selftest` leaves a receipt proving it passed on exactly the current code of the worktree (`src/receipt.mjs`; tested in `test/receipt.test.mjs`). It is checked once, at the start of `validate`.

- Path: `packages/factory/.selftest-receipt.json` (git-ignored). Format: `{"version":1,"treeHash":"<sha256>","startedAt":"<ISO>","finishedAt":"<ISO>","model":"<selftest model>"}`.
- `snapshotTree(dir)` (I/O) collects `{path, kind, content}` for every change against `HEAD` (tracked edits, deletions, untracked files, and both paths of a rename via `--no-renames`), excluding the receipt (only its exact path `packages/factory/.selftest-receipt.json`). A file removed from the index but still on disk keeps its current content. `treeHash(snapshot)` is pure: sha256 over the entries sorted by path, so entry order is irrelevant.
- At start the selftest removes any existing receipt FIRST (before `mkdtemp` or any other initialization, so an early failure leaves none) and records the tree hash.
- On `SELFTEST PASS` it recomputes the hash and writes the receipt only if start and end hashes are equal; otherwise it writes none, prints why and the run fails. A failing selftest leaves no receipt.
- `SELFTEST_NO_RECEIPT=1` runs the selftest without touching the receipt (read-only callers such as QA). `SELFTEST_RECEIPT_FILE` overrides the path (tests only).
- **Check (verdict and validation contracts).** The first thing `validate` does (after folding a worker's commit back and before the gate; hence after the implementation and every QA repair) is `node src/receipt.mjs check <worktree> $ISSUE_STATE/step-failure.json <run>`. `receiptDecision(snapshot, receipt)` (pure) requires a receipt whose `treeHash` equals the current `treeHash(snapshot)` when any path of the snapshot (rename sources and destinations included) is under `packages/factory/`; changes elsewhere need none. Otherwise `validate` fails before running the gate with the finding `selftest not run on this code: receipt missing` or `...: receipt stale (...)`.
- **Routing.** The finding is written to `step-failure.json` (`{run, step:"validate", findings}`), which `labels.mjs` reads like station findings: the issue returns to `factory:ready` and the retry's brief carries the finding (carry-over). `prompts/impl.md` makes the worker run `npm run selftest` after its final edit, QA repairs included, and list it in `criteria`.
