# @a4s/factory

A4S factory on **T3** (orchestration and view), **Dagu** (deterministic control, one installation) and **Pi** (agents), built by **self-construction in increments on a single trunk** (`main`). Plan and slices: epic #1009.

This package is the seed (VS0, #1010): the minimum that closes the delivery cycle once on its own repository.

## The cycle

`dags/cycle.yaml`, one run per issue, with no human step. **Nothing is committed before it is validated, and nothing stays on the trunk if CI fails.** Validation is the only gate before the trunk.

1. **prepare** — worktree `.workspace/worktrees/issue-<n>` on branch `factory/issue-<n>` from `main`, registered as a T3 project; a reused worktree keeps an earlier attempt's uncommitted work on the current trunk. The brief and title come from the GitHub issue (or `BRIEF_FILE`).
2. **implement** — `src/station.mjs` runs the worker as a T3 thread on the isolated `impl` line. The worker **does not commit**. Exit codes: `0` pass/blocked, `10` worker fail or timeout (retried once on the escalation model), `30` infrastructure, `40` malformed verdict (retried once).
3. **require_pass** — anything but `pass` stops the run (blocked is manual until VS3/VS5).
4. **qa** — an independent QA line (`qa`, provider `pi-qa`, another model family, tools `read` and `bash` only, `prompts/qa.md`) checks every acceptance criterion against the uncommitted worktree; its brief is the issue brief plus `git status --short` and `git diff`. The worktree must be byte-identical before and after QA (status, diff and untracked contents are hashed), else the step fails. On a QA `fail` the findings are sent once to the implementation thread (`station.mjs --continue`), its new verdict must be `pass`, and QA runs once more; a second `fail` fails the run.
5. **validate** — the uncommitted worktree is validated with `scripts/factory-gate.sh`: the repository gate on CI's Node major plus the selftest with the service's Dagu.
6. **integrate** — the single commit for the issue (`<title> (#n)` + `Factory-Run:` trailer); if the trunk moved, rebase and validate again; fast-forward `main`, push.
7. **ci** — wait for CI on the pushed commit; red, missing or timed out ⇒ revert on `main`, comment the issue, fail the run.
8. **close** — close the issue, remove the worktree and branch.

Every step resolves `PRIMARY`, `FACTORY`, `T3_HOME` and `STATE` through `src/cycle-env.sh` (explicit params, else the `A4S_*` values in Dagu's base config).

Interpretation stays with LLMs (the worker's verdict; later the QA line, the verdict/text checker, support and jev). Dagu only acts on structured results.

## Self-construction

| Pattern question | Answer |
|---|---|
| Unit of work | One A4S issue. Closed when its commit is on `main`, the gate and selftest pass on it, the issue is closed and its worktree removed. |
| Seed | This package (VS0). |
| Binary test | `npm run selftest`: isolated T3 and Dagu run `cycle.yaml` **from the candidate checkout** on a fixture repo; a fixture issue must close the cycle. |
| Activation | Dagu reads `cycle.yaml`, the station and the prompts from the trunk checkout; the next run uses merged code. |
| In-flight state | Dagu run data, the T3 database and `$STATE/<issue>/<line>.json` (station attempts), all outside the code. |

Every slice adds its own check to the selftest. A slice is built with the already-merged cycle; a slice must never need itself to be built.

## Line profiles

`lines.json` holds model, thinking, escalation model and the isolated Pi instance per line. Instances start with `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-mcp` and a tool allowlist (`--tools`). `src/instances.mjs` turns the table into T3 `providerInstances` entries. The `qa` line (VS4) needs the `pi-qa` instance in the operator's T3; until VS7 it is added by hand from `src/instances.mjs`'s output.

## Manual steps (this list may only shrink)

2. Decide in the Dagu UI/API (merge approval, blocked answers) — VS3.
4. Diagnose failures and blocked verdicts — VS5.
5. Cancel or clean stuck runs; archive T3 projects of closed issues — VS6.
6. Sync `lines.json` into the operator's T3 settings — VS7.
8. Coordinate T3/Pi/Dagu updates — VS8.

## Run it

```sh
npm test --workspace @a4s/factory        # unit tests
npm run selftest                          # binary proof (real model calls, ~2 min)
```

Selftest knobs: `SELFTEST_MODEL` (default `anthropic/claude-haiku-5-5`), `SELFTEST_KEEP=1`, `PI_BIN`, `DAGU_BIN`, `T3_BIN`, `T3_VERSIONS_DIR`.

## Admission (VS1)

`dags/admit.yaml` runs every 5 minutes, lists open issues labelled **`factory:ready`** (`gh issue list`, or the `ISSUES_FILE` fixture) and calls `src/admit.mjs` for each. It enqueues `cycle.yaml` with run-id `factory-issue-<n>-<k>` (k = attempt number from 1, kept in `$STATE/<n>/attempts.json`, so a new attempt is never a duplicate). Exit codes: 0 admitted, 20 not labelled, 21 duplicate (Dagu rejects the run-id), 22 contract, 30 infra. The classification label `factory` never admits.

## Issue state in labels (VS5)

The labels are the state: `factory:ready` (to admit) → `factory:running` (admission moves it) → closed by the cycle, or `factory:needs-human` with a comment (outcome, failed step, question). `src/labels.mjs` is the only helper that moves them (GitHub via `--repo`, or an `ISSUES_FILE` fixture via `--issues-file`).

When a run fails, the `failure` handler of `cycle.yaml` runs `labels.mjs finish`: the attempt outcome (policy table, `CONTRACTS.md`) decides. Retryable outcomes (`fail`, `malformed`, `timeout`, `cancelled`, `infra`) put the issue back to `factory:ready` (next admission runs `-<k+1>`), up to 3 runs; `blocked`, the 3rd failure or a non-retryable outcome put it on `factory:needs-human`. Putting `factory:ready` back on a `needs-human` issue admits a new attempt with a fresh budget of 3 runs. A failed step that is not a station (validate, ci…) counts as `fail`. Runs not labelled `factory:running` (started by hand) are never relabelled.

## Notifications (VS2)

`cycle.yaml` declares `handler_on` for `success`, `failure` and `wait`; each runs `node "$FACTORY/src/notify.mjs"` with the event, run-id, issue and step statuses. `src/notify.mjs` sends one message (run-id, issue, event, failed step, issue URL) with `src/t3cli.mjs thread send` to the thread in param `INBOX_THREAD`, else `A4S_INBOX_THREAD` (Dagu base config, resolved by `src/cycle-env.sh`), else the factory's own inbox: a thread titled `Bandeja de la fábrica` in the T3 project of `PRIMARY`, on the isolated line `inbox` (`pi-inbox`, tools `read` and `bash`, `prompts/inbox.md`), created on first use and recorded in `$STATE/inbox.json` (an existing one is adopted, never two). Each run/event is sent once (`$STATE/<issue>/notified.json`). Notification problems are logged and never fail a run. Until VS7, add the `pi-inbox` instance to the operator's T3 by hand (`src/instances.mjs`).
