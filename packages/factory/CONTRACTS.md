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

**Which test runs where.**

| Test | CI (`.github/workflows/ci.yml`) | Gate (`scripts/factory-gate.sh`, the `validate` step) | Schedule |
| --- | --- | --- | --- |
| Unit tests (`npm test`) and typecheck (`scripts/gate.sh`) | yes | yes | no |
| Stub selftest (`npm run selftest:stub`) | yes (own step, 5 min cap) | yes | no |
| Full selftest (`npm run selftest`, real models, isolated T3) | no (needs credentials) | yes | yes (operator host) |

- `npm run selftest:stub` (`selftest/selftest-stub.mjs`) runs the same cycle as the selftest (isolated Dagu, the DAGs of this checkout, a fixture repository) with `PUSH=true` and `CLOSE_ISSUE=true`. No model, no T3 server, no credentials: the `t3` CLI is `selftest/stub/t3.mjs`, found where `resolveT3` looks (`$HOME/.t3/runtime/versions/stub/t3` of a temporary `HOME`), and answers each line from fixture verdicts; `gh` is `selftest/stub/gh.mjs` on `PATH`, serves issues, labels, comments and CI run lists from a fixture directory and records every call in `gh-calls.jsonl`. The remote is a bare git repository that `integrate` and `push` really push to. It needs `git`, `jq` and Dagu (`FACTORY_DAGU_BIN`, else `DAGU_BIN`, else `dagu` on PATH). It never writes the selftest receipt: only the real selftest proves a factory change.
- Scenarios, each asserted from the bare remote and the recorded `gh` calls: delivered (commit with the `Factory-Run` trailer on the remote, CI green, issue closed with the comment, `verify_close` passes); CI red (revert commit on the remote, comment, run failed); CI `cancelled` covered by a later green commit (no revert); validation failure (nothing pushed).
- The real selftest is unchanged.

## Issue contract

Enforced at admission by `src/issue-contract.mjs` (`checkIssue(body)`), tested in `test/issue-contract.test.mjs`. The GitHub issue form `.github/ISSUE_TEMPLATE/factory.yml` produces these headings.

An admitted issue body must contain, in this order:

1. `## Goal`: non-empty.
2. `## Acceptance criteria`: non-empty, with at least one checklist item `- [ ] ...`.
3. `## Out of scope`: non-empty.

`## Blocked by` is optional: issues as `#<n>`, one per line (or comma separated), at least one; a malformed entry or an empty section is a contract problem. `## Activation` and `## Notes` are optional. Only structure is checked, never content quality.

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

Every attempt of a line ends in exactly one outcome, stored in `$STATE/<issue>/<line>.json` (`attempts[].outcome`): `pass | fail | malformed | stuck | timeout | blocked | cancelled | infra | violation`. An attempt without outcome is in flight; any other value makes the station exit `40` when it reads the file.

The next attempt is chosen from the previous outcome only (`POLICY`), never from the attempt count:

| outcome | policy | next attempt |
|---|---|---|
| `pass` | stop | none; the stored verdict is replayed |
| `blocked` | resume | same thread (`threadId`, `question` stored); with `--answer` it is sent there, without one the station waits on that thread |
| `fail`, `malformed`, `stuck`, `timeout` | escalate | new thread on `escalate_to` |
| `cancelled` | same-model | new thread on `model` |
| `infra` | reattach | same thread, no new brief |
| `violation` | halt | none: the stored outcome is replayed (exit `50`); the run fails, the issue goes to `factory:needs-human` with the changed items |

- **No fixed deadline on producing steps** (implementation, QA, QA repair): `cycle.yaml` passes no `--timeout-sec` to any station call. The station watches the thread's activity (`t3 thread show --json`: a new or changed message or tool call) and ends the attempt only on two conditions, killing the thread: `stuck` = no activity for `STALL_SEC` (default 1200); `timeout` = the safety cap `MAX_SEC` (default 14400) since the first start of the attempt. Both are configurable in `limits.json` (`stallSec`, `maxSec`; `STALL_SEC`/`MAX_SEC` env or `--stall-sec`/`--max-sec` override it). An attempt that keeps working is never cut by a clock before `MAX_SEC`. Both clocks come from the persisted `startedAt` and `lastActivityAt` (and an `activitySig` fingerprint) of the attempt: reattaching to a running attempt, or after `infra`, never resets them. Only a thread that is still busy can be `stuck`/`timeout`; a finished one is classified by its verdict.
- Escalation follows results, not time: `fail`, `stuck` and `timeout` escalate to `escalate_to`; time passing while the thread is active escalates nothing.
- Waits on external things keep their deadlines: `CI_TIMEOUT_MIN` (CI step), service reachability (`UNREACHABLE_MIN`, `--reattach-sec`) and the integration lease. The stall alarm (#1040) only notifies about long runs; it never kills them.
- A terminal T3 status `cancelled` (or SIGTERM) is `cancelled`; any other non-`completed` terminal status is `fail`.
- A stored `pass` (stop) or `blocked` without `--answer` (await) is replayed before any T3 access, so it needs no server.
- Unreachable T3 (preflight or while polling), a failed `thread start`, or malformed JSON from the `t3` CLI is `infra`; a preflight failure finalizes the in-flight attempt as `infra`, terminal outcomes are never overwritten.
- **Protected shared Git state (`src/shared-git.mjs`, tested in `test/shared-git.test.mjs` and the selftest).** Before and after every station call (implementation, QA, QA repair) `station.mjs` fingerprints, from the issue worktree: the common `.git/config` and every `config.worktree` file (common, current and all linked worktrees), `.git/hooks/` and `.git/info/` (whole trees, with file modes), every ref except `refs/heads/factory/issue-*` (other runs' branches move, appear and disappear legitimately and are protected by their own `integrate`/`verify_close`; the issue's own branch moving is no difference) and the T3 server's own checkpoint refs `refs/t3/orchestration-v2/checkpoints/<thread>/ordinal/<n>` are not counted; any other `refs/t3/*` ref is protected; `refs/remotes/` moves and a fast-forward of the primary's branch are accepted only while another run holds the integration lease, or took and released it during the call; `objects/` and packs are never read, so `git gc` is not a violation), and the primary checkout's `git status --porcelain` with untracked files (`.workspace/worktrees/` excluded; read with `--git-dir`/`--work-tree` so a hijacked `core.worktree` cannot hide it). The fingerprint is a pure function over a snapshot (`fingerprint`, `violations`, `compareSnapshots`); `collectSnapshot` is the only Git reader. Any difference ends the attempt as `violation` (exit `50`, not in `retry_policy.exit_code`, no automatic retry): the changed items are stored in the attempt (`violations`, `findings`), printed as `findings`, and the needs-human comment lists them. Nothing is restored. The guard fails closed: if the snapshot after the call cannot be read, that is a `violation` too. A snapshot that cannot be read before the call ends the attempt as `infra`.
- `retry_policy.exit_code` of every station step in `cycle.yaml` equals the exit codes of the `escalate` outcomes (`retryExitCodes()`).

## Issue state contract

Labels are the source of truth (`src/labels.mjs`, tested in `test/labels.test.mjs` and the selftest): `factory:ready` → `factory:running` (admission) → closed, or `factory:needs-human` (+ comment: outcome, failed step, question). Run-ids are `factory-issue-<n>-<k>`. After a failed run, `isRetryable(outcome)` (every outcome whose POLICY is not `stop`/`resume`) with fewer than `MAX_RUNS` (3) runs since the last human decision puts the issue back to `factory:ready`; anything else goes to `factory:needs-human`.

**Run budget reset.** A human decision starts a fresh run budget: a park (human puts `factory:ready` back after `factory:needs-human`) and likewise a `factory:hold` → `factory:ready` re-admission (the admit step saw the hold, `admit.mjs --clear-held`, or the label history shows `factory:hold` added after the last run) reset `streak` to 1 on the next admission. `attempts.json` records `resetBy` (`needs-human` | `hold`) and `resetAt`; the needs-human comment says "run k of 3 since <reset>". An admission without a human decision keeps counting.

**CI step.** `src/ci.mjs classify` (pure) classifies the runs of the SHA of the counted workflows (`CI_WORKFLOWS`, default `CI`): `success`; `failure`/`timed_out`/no verdict before `CI_TIMEOUT_MIN` → red (the only case that reverts); `cancelled`, `skipped`/`neutral` → not red. A cancelled run with a later `origin/$BASE` commit containing the SHA waits for that commit's CI. A counted workflow not yet registered is `running`; other workflows are ignored. A red writes `step-failure.json` (step `ci`: conclusion, workflow, run URL), which `finish` carries into `carry.json`; the issue comment names the real conclusion.

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

`limits`: a run exceeded its limits. `collectLimits` reads `$STATE/<n>/{impl,qa,attempts}.json` and the per-step timeouts configured in `dags/cycle.yaml` (`--timeout-sec` of each `station.mjs --line X` step; when one line has steps with different timeouts and the attempt recorded none, an in-flight attempt past the smallest but not the largest is reported as an ambiguous-configuration reason rather than judged by the largest; an attempt's own recorded `timeoutSec` wins; the station default `STATION_TIMEOUT_SEC`, equal to the safety cap `MAX_SEC`, only when neither exists). Reason `kind: limits`, detail names the issue and step. It never clears by itself (reset only); events whose start is before `resetAt` no longer count. Snapshot `limits`: `{maxRuns, runs: [{issue, runs, at}], steps: [{issue, step, startedAt, timeoutSec, outcome?}], problems: [{issue, step, error, at}]}` (`check` collects it from `$STATE` unless the snapshot has one; `--cycle` overrides the cycle file). Edge cases:
1. an attempt still running (no outcome) longer than its safety cap (`MAX_SEC`) → open.
2. an attempt persisted with outcome `stuck` or `timeout` → open, unless a later attempt of the same step passed (an escalation that succeeds does not keep the breaker open); completed violations count until reset.
3. an active long attempt under its safety cap → closed.
4. more than 3 runs for one issue (`streak` of `attempts.json`) → open.
5. attempts archived by admission (`<line>.json.<ts>`) are never read, so never double-counted.
6. a missing (`attempts.json` absent while a station file's latest attempt is in flight, i.e. has no outcome; otherwise the issue is skipped with a debug note) or corrupt/invalid attempt file, or an unreadable cycle file, is a reason, never ignored.

`streak`: two different issues failed in a row. `collectRuns` reads the finished runs from the factory state `$STATE/runs.jsonl` (`{issue, run, outcome: pass|fail|blocked|cancelled, finishedAt}`, appended once per run id by the `onSuccess`/`onFailure` handlers via `breaker.mjs record`; never the paginated Dagu run list), ordered by `finishedAt`; snapshot `runs` is that list. The last two finished runs both `fail` and belong to different issues → open, reason `streak` naming both runs. Edge cases: (1) two failures of different issues → open; (2) two failures of the same issue (re-attempts) → closed; (3) a success between two failures → closed; (4) a run still in progress is not in the history, so ignored; (5) `blocked`/needs-human (and `cancelled`) is not a failure (and, like a success, breaks the streak). Never clears by itself (reset only); runs finished at or before `resetAt` no longer count.

**Notification.** On opening, one inbox notification (`notify.mjs --event breaker`) carries the reasons and the reset command; it is not repeated while the breaker stays open.

**Reset rule.** `node packages/factory/src/breaker.mjs reset [--state S] [--by NAME]` closes it explicitly and records `resetBy`/`resetAt`. Any reason whose kind does not define a self-clearing rule never clears by itself.

**Adding a condition.** Add an entry to `CONDITIONS` in `src/breaker.mjs`: `detect(snapshot, state, now)` returns `{kind, detail, since}` reasons, and optionally `clears(snapshot)` if (and only if) the condition may clear by itself. Data for it goes into the snapshot; the reason shape does not change.

## Research handoff contract

Operator-guided research runs in a dedicated top-level T3 thread per topic (line `research`, instance `pi-research`, started with `src/research.mjs start "<topic>"`; state in `$STATE/research/<slug>.json`). The researcher may do everything except merging to main (operator, 2026-11-19): web, the whole codebase, its own worktree and branch `research/<slug>` (commits, and push of that branch only), tests, the gate, the selftest, isolated T3/Dagu, real model calls (expensive ones with the operator's agreement). It never pushes to, merges into or commits on `main`, never touches the primary checkout or other branches, never changes the live factory (Dagu service, T3 settings/instances, `$STATE` of runs, breaker, labels), never creates issues itself and never handles secrets. It hands off to the supervisor named in its `launch.md` with `[research <slug>] <absolute artifact path>`, quoting the operator's handoff instruction verbatim; the supervisor creates the issues.

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

## Integration lease contract

Changes reach the trunk one at a time; everything before `integrate` runs in parallel.

- **Lease.** `src/lease.mjs` keeps the directory `$STATE/integrate.lease/` as a sequence of generations: `g<N>` = `{run, dag, takenAt}` (the owner of generation N) and `g<N>.released` = `{by, reason, at}` (generation N is over). The lease is held by the highest generation when it has no `.released` marker. Taking is atomic (the record is written to a private file and hard-linked as `g<N+1>`; `EEXIST` = another contender won). Releasing and reclaiming are atomic too: they only hard-link the marker of the exact generation they checked, so they never free a newer owner's lease and a live lease is never exposed as free. Only the owner releases (any other run is a logged no-op). A lease whose owner run is not queued or running in Dagu (`dagu status [--dagu-home $DAGU_HOME] [--config $DAGU_CONFIG] --run-id R DAG`, the store Dagu exports to its steps: finished, or run unknown) or whose record is corrupt is reclaimed, and the reclaim is logged. An unclear answer from Dagu counts as alive.
- **Window.** The `integration_lease` step (between `validate` and `integrate`) waits until the run holds the lease, so in Dagu's step times `integrate` starts only once the window is the run's. `integrate` takes it again (a no-op for its owner) before its `merge-base` check and holds it through `ci`, which releases it at its end (green, revert pushed, or any failure). `integrate` also releases it when it fails, and the `success`, `failure` and `abort` handlers release it. `prepare` takes it around its use of `PRIMARY` (branch and clean-status checks, `git worktree add`) and releases it right after.
- **Wait.** Time spent waiting is added to `$ISSUE_STATE/lease-wait.json` (`{waitedMs, waits:[{from,to,ms,open?}]}`, reset by `prepare`) and logged. A wait in progress is on disk from its start (`open: true`, refreshed on every poll) and counts up to now while it keeps being refreshed. The wait has no deadline: a dead holder is reclaimed and a live one ends within its own steps. `collectLimits` carries into each in-flight step the `waitedMs` that falls inside the attempt (`lease.mjs waitedWithin`: only the overlap of each recorded wait with `[startedAt, now]`), and the breaker's step-timeout check subtracts it, so waiting for the lease never opens the breaker; a wait before the attempt started never stretches its allowance.
- **Dags tests.** `test/dags.test.mjs` runs the literal `integrate` and `ci` steps under real Dagu (skipped when `dagu` is not installed) on a fixture repository with a local bare origin and a stub `gh`: two concurrent runs land one after the other (step times from Dagu's status store), and a SIGKILLed lease holder is reclaimed once Dagu reports its run dead (Dagu marks a killed run `Failed` when its heartbeat goes stale, about 90 s).
- **Revert.** `ci` reverts only a commit that carries this run's `Factory-Run` trailer and only while it is the tip of both the local and the origin trunk (`ci.mjs revert-check`). Otherwise `step-failure.json` gets an `infra:` finding, the inbox is notified (`--event infra`) and the step fails without reverting.
- **Env.** `LEASE_POLL_MS` (default 2000) is the polling interval while waiting.

## Ordering contract

Enforced by `src/next.mjs` (`pickNext`, `analyze`, `loadPolicy`), tested in `test/next.test.mjs` and the selftest. `admit.yaml` runs it after admission on each schedule.

- `limits.json` (`version: 1`, `maxActiveRuns`) is operator policy, validated on load: `maxActiveRuns` is an integer of at least 1; an error names the field, the expected value and the observed one. Shipped with `maxActiveRuns: 1` until the exclusive integration window (#1089) exists.
- `pickNext(issues, inFlight, limits, conflicts)` returns at most `maxActiveRuns - inFlight.length` issues. Candidates: open, labelled `factory` and one of `M0`..`M3`, without `factory:ready`, `factory:hold`, `factory:running` or `factory:needs-human`, passing the issue contract, with every `Blocked by` issue closed as **completed**. Order: lowest milestone, then lowest number. A candidate for which `conflicts(candidate, other)` holds against an in-flight or already picked issue is skipped (default: never).
- A blocker closed as **not planned** puts the blocked issue on `factory:hold` with a comment naming it. Cycles in `Blocked by` are never picked; each member gets one comment naming the cycle. Issues without a milestone label or failing the contract are never picked and are reported once per admission log.
- `admit.yaml` counts in-flight `cycle` runs (queued, running, waiting), labels the picked issues `factory:ready` and logs why each was picked or skipped. With `ISSUES_FILE` it only prints the choice.

**Delivered state.** After `verify_close` the cycle moves `$STATE/<n>/` to `$STATE/archive/<n>/` (atomic rename, `-<ts>` suffix if the entry exists; a failed move is logged, never fails the run). `collectLimits` reads only `$STATE/<n>/` (never `archive/`) and skips an issue whose state has `done.json`; a `timeout` outcome therefore stops counting once the issue is archived or done.
