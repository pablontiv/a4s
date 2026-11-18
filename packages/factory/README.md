# @a4s/factory

A4S factory on **T3** (orchestration and view), **Dagu** (deterministic control, one installation) and **Pi** (agents), built by **self-construction in increments on a single trunk** (`main`). Plan and slices: epic #1009.

This package is the seed (VS0, #1010): the minimum that closes the delivery cycle once on its own repository.

## The cycle

`dags/cycle.yaml`, one run per issue:

1. **prepare** — worktree `.workspace/worktrees/issue-<n>` on branch `factory/issue-<n>` from `main`, registered as a T3 project. The brief comes from the GitHub issue (or `BRIEF_FILE`).
2. **implement** — `src/station.mjs` runs the worker as a T3 thread on the isolated `impl` line. It polls the thread with `t3 thread show --json`, reattaches after T3 restarts, and returns a structured verdict. Exit codes: `0` pass/blocked, `10` worker fail or timeout (retried once on the escalation model), `30` infrastructure, `40` malformed verdict (retried once).
3. **require_pass** — anything but `pass` stops the run (blocked is manual until VS3/VS5).
4. **gate** — `scripts/factory-gate.sh`: the repository gate plus the selftest.
5. **approve_merge** — operator click (Dagu human task; one-click card from VS3).
6. **integrate** — rebase on `main`, re-run the gate, fast-forward `main`, push.
7. **close** — close the issue, remove the worktree and branch.

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

`lines.json` holds model, thinking, escalation model and the isolated Pi instance per line. Instances start with `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-mcp` and a tool allowlist (`--tools`). `src/instances.mjs` turns the table into T3 `providerInstances` entries.

## Manual steps (this list may only shrink)

1. Enqueue the run (`dagu start/enqueue … cycle.yaml -- ISSUE=<n> …`) — VS1.
2. Watch Dagu for waits and failures — VS2.
3. Decide in the Dagu UI/API (merge approval, blocked answers) — VS3.
4. Review quality by hand — VS4.
5. Diagnose failures and blocked verdicts — VS5.
6. Cancel or clean stuck runs; archive T3 projects of closed issues — VS6.
7. Sync `lines.json` into the operator's T3 settings — VS7.
8. Coordinate T3/Pi/Dagu updates — VS8.

## Run it

```sh
npm test --workspace @a4s/factory        # unit tests
npm run selftest                          # binary proof (real model calls, ~2 min)
```

Selftest knobs: `SELFTEST_MODEL` (default `anthropic/claude-haiku-5-5`), `SELFTEST_KEEP=1`, `PI_BIN`, `DAGU_BIN`, `T3_BIN`, `T3_VERSIONS_DIR`.
