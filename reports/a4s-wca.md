# a4s-wca — Local CI suite and sync_strategy contract

- **Bead:** `a4s-wca` (epic `a4s-ann`)
- **Candidate SHA:** `9748e839d08d33aac4d415034e444b6c39c2e666`
- **Verdict:** pass (pre-merge); merge and post-check results are appended to the Bead notes at closure.

## Delivered

- `test/ci-local.sh`: runs all 19 non-Windows steps of `.github/workflows/ci.yml` (18) and `.github/workflows/test-model-optimizer.yml` (1), prints a per-step PASS/FAIL table, and exits nonzero on any failure. The CI install steps (pip, `go install` rootline) are replaced by verification-only steps. Windows steps are skipped and declared.
- `profiles/pablontiv/tests/test_profile_contract.py`: `test_sync_strategy_is_observable_and_fail_closed` requires `pull explícito`, `origin/main`, and `unknown`, which is the policy introduced by `f91a17a`.
- `.workspace/config.yaml`: the `ci-billing` compensating control now requires `test/ci-local.sh` green on the candidate SHA.

## Acceptance

| Criterion | Result |
|---|---|
| ci-local.sh green on the candidate and covers every non-Windows step | PASS: `Total: 19 \| Passed: 19 \| Failed: 0`, exit 0. The reviewer contrasted it step by step against both workflows |
| A deliberately broken test makes ci-local.sh exit nonzero | PASS: in a disposable worktree with a real assertion broken, `✗ FAIL: Test profile contract (exit code: 1)`, `Failed: 1`, script exit 1; the worktree was removed |
| sync_strategy test requires `pull explícito`, `origin/main`, `unknown` | PASS |
| ci-billing names test/ci-local.sh green on the candidate SHA | PASS |

## Invariants

- `ci.yml`, `test-model-optimizer.yml`, and the `sync_strategy` text are unchanged: `git diff main -- .github .workspace/config.yaml` shows only the compensating-control line.
- No other tests changed.

## Reviews

- Implementer: fresh subagent. The first pass violated the contract (global `pip --break-system-packages` and `go install`, plus a negative check run on a toy script). Both were corrected in a bounded fix.
- Reviewer: fresh subagent, REQUEST_CHANGES with two findings: MEDIUM, `cd` not fail-closed; LOW, a dead function. Both were fixed and verified by the controller (`test/ci-local.sh:60,63`, function removed).

## Workspace controls

- Sync: explicit `git pull --ff-only` of main before the worktree was created from `0a5a508`.
- Isolation: dedicated worktree `.workspace/worktrees/ci-local-suite`, branch `feat/ci-local-suite`.
- Commits: conventional, with the `Bead:` and `Delivery-Override: ci-billing` trailers.
- Backscroll: not applicable; no prior history changes this task.

## Side effects

- The first implementer run executed `go install github.com/pablontiv/rootline/cmd/rootline@14ee8aa…`, which created `[REDACTED:home]/go/bin/rootline` (2026-09-24 16:25).
- The active `rootline` on PATH (`~/.local/bin/rootline`, 9.13.26) is unchanged.
- Per `cleanup_policy`, removal of that binary is offered to the operator, not performed.
- `pip install --no-deps` of `PyYAML==6.0.3` was a no-op; the version was already installed.

## Delivery

- Delivered by pull request under `delivery_overrides.ci-billing` (ADR 0046).
- The merge was explicitly authorized by the operator on 2026-09-24 for the tasks of epic `a4s-ann` preceding the autonomous delivery mode (T1, TA, T2).
