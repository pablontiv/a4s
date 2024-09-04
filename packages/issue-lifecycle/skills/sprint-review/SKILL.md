---
name: sprint-review
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: Sprint Review (Scrum Guide 2020) for an agent session. Re-runs the Sprint Goal checks and evaluates each Sprint Backlog issue using the acceptance and delivery evidence recorded in Sprint Planning. Use when the operator closes a session, asks "what blocks?" or "what is left?", or asks whether the sprint goal is met. Requires `gh` and `dagu`.
---

# Sprint Review

The session runs the review; the operator accepts the result or changes the goal for the next sprint.

## Procedure

1. Take the Sprint Goal, its checks and the Sprint Backlog confirmed in the `sprint-planning` skill.
2. Run every check again now. Report each check as yes or no, with its output. For Admission, use the installed `a4s admit --check --run-id sprint-admission-check feature -- ISSUE=<n> OMP_SESSION_ID=<session>` in each adopted repository with the station environment and coordinator session described in `sprint-planning`. Expect exit 0 and `admissible=yes`; exit 1 and `admissible=no` reports the blocking reason. Do not run a real admission or delete receipts to perform a review.
3. Evaluate each Sprint Backlog issue against its acceptance criteria and the Definition of Done content in `sprint-planning`, using the existing feature or PoC lifecycle evidence. Report each issue as done or not done, with evidence and any unmet condition. A completed PoC PASS without promotion is a completed experiment; promoted feature delivery is tracked separately.
4. Present one table: check or issue, result, evidence, owner of the next action.
5. Report goal checks that answer no and unfinished issue conditions separately, with the responsible session or operator for each next action.

The Sprint Goal is met when every agreed goal check returns yes. Report that result separately from issue completion: goal checks alone do not prove issue acceptance or completed delivery.

## Output

- The operator accepts the result or changes the goal; a changed goal starts a new `sprint-planning`.
- Continue with the `sprint-retrospective` skill.
