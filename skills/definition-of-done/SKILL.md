---
name: definition-of-done
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: Definition of Done (Scrum Guide 2020) for issues worked through the Dagu feature and PoC cycle. Decides with evidence whether one issue is done. Use when asked whether an issue is done, before reporting an issue as finished, and from the `sprint-review` skill for each Sprint Backlog issue. Requires `gh` and `dagu`.
---

# Definition of Done

An issue is done only when every condition below has its evidence. Report each condition as yes or no with the command output; one "no" means not done.

## Feature issue

| Condition | Evidence |
|---|---|
| The candidate passed the local gate and two current quality PASS verdicts (QA and reviewer) | `quality.json` of the run |
| The PR is merged into the default branch | `gh pr view <pr> --json state` → `MERGED` |
| Every required check passed on the merged SHA | the run's `authorize_ci` step succeeded |
| The issue is closed | `gh issue view <n> --json state` → `CLOSED` |
| The Dagu run succeeded, and its worktree and branch are removed | `dagu status` → `succeeded`; reconcile reports no `LEFTOVER` for the issue |

## PoC issue

| Condition | Evidence |
|---|---|
| The verdict comment is published on the issue | the `<!-- poc-verdict:... -->` comment |
| The PoC run succeeded, and its worktree and `poc/<run>` branch are removed | `dagu status` → `succeeded`; reconcile reports no `LEFTOVER` for the run |
| PASS with `promote=yes`: the feature run of the same issue is done | the feature table above |
| FAIL: the issue is closed as not planned | `gh issue view <n> --json state,stateReason` → `CLOSED`, `NOT_PLANNED` |

## Rules

- Evidence comes from the commands above, run now; an earlier report is not evidence.
- An issue that is not done names its first "no" condition and the step or component that owns it.
