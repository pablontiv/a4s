---
name: sprint-review
metadata:
  author: pablontiv
  updated: "2026-11-08"
description: Sprint Review (Scrum Guide 2020) for an agent session. Re-runs the Sprint Goal checks and evaluates each Sprint Backlog issue using the acceptance and delivery evidence recorded in Sprint Planning. Use when the operator closes a session, asks "what blocks?" or "what is left?", or asks whether the sprint goal is met.
---

# Sprint Review

The session runs the review; the operator accepts the result or changes the goal for the next sprint. Inspect the outcome and adapt the backlog, not just report status.

## Procedure

1. Take the Sprint Goal, its checks and the Sprint Backlog confirmed in `sprint-planning`, including the agreed Definition of Done and repository delivery policy.
2. Run every agreed goal check again now and report yes or no with its output. Use direct, non-mutating checks of the repository and available evidence; do not start delivery or change state to make a review pass. If a check cannot run, report no with the missing evidence or prerequisite rather than claiming success.
3. Evaluate each Sprint Backlog issue against its acceptance criteria and Definition of Done using the recorded implementation or PoC evidence. Report done or not done, with every unmet condition. For feature delivery, require the local gate result and independent review of the exact tested candidate SHA, required PR checks, squash merge of the exact approved head, local main fast-forward, worktree/branch cleanup and issue closure evidence. Apply the explicit repository trunk-integration policy recorded in Sprint Planning instead when it governs delivery, including referenced delivery documentation: require integrated-SHA gate evidence, published base SHA, required post-push CI and cleanup rather than PR-only artifacts. Do not invent missing evidence. For a PoC, require operator-approved execution and the issue's PASS, FAIL or INCONCLUSIVE result with supporting observations and limitations. A completed experiment is distinct from a successful hypothesis; promotion to feature delivery is tracked separately.
4. Present one table: check or issue, result, evidence, owner of the next action.
5. Report goal checks that answer no and unfinished issue conditions separately, naming the responsible agent or operator and next action. Capture any changed needs or backlog adaptations for `sprint-planning`.

The Sprint Goal is met when every agreed goal check returns yes. Report that result separately from issue completion: goal checks alone do not prove issue acceptance or completed delivery.

## Output

- Record the review evidence and the operator's acceptance or requested adaptation in the sprint record. A changed goal starts a new `sprint-planning`. Under an explicit autonomous mandate, record the outcome without waiting for acceptance, within that mandate's decision limits.
- Continue with `sprint-retrospective`.
