---
name: sprint-review
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: Sprint Review (Scrum Guide 2020) for an agent session. Re-runs the Sprint Goal checks from Sprint Planning and evaluates every Sprint Backlog issue with the Definition of Done. Use when the operator closes a session, asks "what blocks?" or "what is left?", or asks whether the sprint goal is met. Requires `gh` and `dagu`.
---

# Sprint Review

The session runs the review; the operator accepts the result or changes the goal for the next sprint.

## Procedure

1. Take the Sprint Goal, its checks and the Sprint Backlog confirmed in the `sprint-planning` skill.
2. Run every check again now. Report each check as yes or no, with its output.
3. Evaluate each Sprint Backlog issue with the `definition-of-done` skill. Report each issue as done or not done; a not-done issue names its first "no" condition.
4. Present one table: check or issue, result, evidence, owner of the next action.
5. The checks that answer "no" are the answer to "what blocks?" or "what is left?".

The sprint is done when every check of the Sprint Goal answers "yes".

## Output

- The operator accepts the result or changes the goal; a changed goal starts a new `sprint-planning`.
- Continue with the `sprint-retrospective` skill.
