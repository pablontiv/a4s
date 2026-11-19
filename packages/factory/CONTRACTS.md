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
