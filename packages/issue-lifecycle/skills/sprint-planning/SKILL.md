---
name: sprint-planning
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: Sprint Planning (Scrum Guide 2020) for an agent session. Orders a repository's issues against an operator-confirmed goal with yes/no checks (session scope = Sprint Goal, backlog scope = Product Goal) and enqueues the Sprint Backlog in Dagu in that order. Use when the operator asks to prioritize, order, plan or re-plan issues, or before enqueueing several issues in Dagu. Requires `gh`.
---

# Sprint Planning

One coordinator session is one sprint. The session proposes the goal, the checks and the order; the operator confirms them. Dagu executes the queue in the order the session enqueues; it never ranks issues.

## Scopes

- **Sprint:** the Sprint Goal of the current session. The output is the Sprint Backlog: the issues to work on now, in order.
- **Product:** the standing Product Goal of the repository. The output is the order of every open issue.

## 1. Goal

Write the goal as one sentence that describes an observable result, and get the operator's confirmation before ranking. Example: "The Dagu cycle of a4s and activities takes an issue to merge without manual intervention."

## 2. Checks

Convert the goal into 3–5 checks. Each check is one command with an expected result, so its answer is yes or no:

| Check | Command | Expected |
|---|---|---|
| Admission | `dagu-feature-bundle admit --run-id <probe> feature -- ISSUE=<n>` in each repo with a committed answers file, then delete the probe receipt | exit 0 |
| Reconciler | `dagu history reconcile --format json --limit 5` | all `succeeded` |
| Station | owner `OMP_SESSION_ID` of every `waiting`/`queued` run | a live session owns each run |
| CI | `gh run list --branch main --limit 1` | `success` |

Run every check and record its output. The operator confirms the checks together with the goal. The `sprint-review` skill re-runs the same checks at the end of the sprint.

### Definition of Done

Keep goal completion and issue completion separate. The goal is met when its agreed checks answer yes; that alone does not establish that an issue meets its acceptance criteria. For each issue, record yes/no against its acceptance criteria and the delivery evidence required by its existing feature or PoC lifecycle:

| Work | Completion evidence |
|---|---|
| Feature | Acceptance results, the run's local gate (and any adopted operator validation), merged PR, required CI evidence from `authorize_ci`, closed issue, and successful run with reconciled worktree/branch cleanup |
| PoC | The published verdict and findings answering the issue's question, successful PoC run and reconciled worktree/branch cleanup, and the lifecycle's issue disposition |
| PoC PASS with promotion | Also track the promoted feature continuation against the feature evidence; distinguish a completed experiment from unfinished promoted delivery |
| PoC PASS without promotion | The completed experiment needs no feature implementation to count as a completed PoC |
| PoC FAIL | The published verdict explains the failed experiment; the required existing issue's disposition remains unchanged |
| PoC INCONCLUSIVE | The published findings record the unresolved question and the operator's choice of iteration or completion with promote=no; an inconclusive result is not a PASS |

Use the existing run artifacts and issue/PR evidence; record their provenance and current lifecycle state. A missing condition is a no with the responsible next action, not a reason to invent another delivery gate.

## 3. Rank

Collect the open issues with `gh issue list --state open`. Put each issue in the first class it fits:

| Class | Rule | Evidence required |
|---|---|---|
| P0 | It makes a check answer "no" now | the failing check output and the line that ties it to the issue |
| P1 | It has cost time more than once, or the `sprint-retrospective` skill recorded it as a repeated incident | session ids, run ids or counts of turns, hours or incidents |
| P2 | The operator asked for it in the current conversation | the operator message |
| P3 | Everything else | none |

Order inside a class:

1. Issues that unblock other issues go first; follow the declared `blocked-by` relationships.
2. Issues that edit the same files go one after the other; issues that edit different files can run in parallel.
3. In P1, a higher observed cost goes first.

In the product scope, an issue that no check and no evidence reaches is P3. Report it as a candidate to close or to refine; close or relabel it only when the operator asks.

## 4. Sprint Backlog and enqueue

Show the order as one table: position, issue, class, evidence, the check it supports (or its stated contribution). After the operator confirms, the responsible session enqueues the issues in Dagu in that order with the `issue-execution` skill. P3 issues are not enqueued. This is the sole ranking and new-issue enqueue path; Dagu executes the supplied order. Existing feature and PoC continuations keep their lifecycle behavior.

Needs, reports and incidents that are not yet actionable issues go through `refine`, then `backlog-breakdown` for reviewed issue materialization. Bring the resulting issues back here for ranking and enqueue.

## Rules

- Answer "what blocks?" with the check output. Each blocker names its failing check, the evidenced cause or unresolved question, and the responsible next action.
- Use the existing delivery lifecycle and its evidence for recovery; the responsible session acts within the operator's authorization.
- Attribute each run to the session in its `OMP_SESSION_ID` parameter. A run whose owner session is not alive is a station failure.
- Re-rank when a check changes its answer or the operator changes the goal; an order written in an earlier session is not reused without re-running the checks.
