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
