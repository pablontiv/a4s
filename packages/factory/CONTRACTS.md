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
