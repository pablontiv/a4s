---
name: issue-prioritization
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: Orders a repository's issues against an operator-confirmed objective with yes/no checks, for one session or for the whole open backlog. The session decides the order; Dagu only runs the queue in the order the session enqueues. Use when the operator asks to prioritize, order, plan or re-plan issues, asks "what blocks?" or "what is left?", or before enqueueing several issues in Dagu. Requires `gh`.
---

# Issue prioritization

The coordinator session decides the order with the operator. Dagu executes the queue in the order the session enqueues; it never ranks issues.

## Scopes

The same procedure has two scopes:

- **Session:** the objective of the current session. The output is the list of issues to work on now.
- **Backlog:** the standing objective of the repository. The output is the order of every open issue.

## 1. Objective

Write the objective as one sentence that describes an observable result, and get the operator's confirmation before ranking. Example: "The Dagu cycle of a4s and activities takes an issue to merge without manual intervention."

## 2. Checks

Convert the objective into 3–5 checks. Each check is one command with an expected result, so its answer is yes or no:

| Check | Command | Expected |
|---|---|---|
| Admission | `dagu-feature-bundle admit --run-id <probe> .workspace/dagu/dags/feature.yaml -- ISSUE=<n>` in each adopted repo, then delete the probe receipt | exit 0 |
| Reconciler | `dagu history reconcile --format json --limit 5` | all `succeeded` |
| Station | owner `OMP_SESSION_ID` of every `waiting`/`queued` run | a live session owns each run |
| CI | `gh run list --branch main --limit 1` | `success` |

Run every check and record its output. The operator confirms the checks together with the objective.

## 3. Rank

Collect the open issues with `gh issue list --state open`. Put each issue in the first class it fits:

| Class | Rule | Evidence required |
|---|---|---|
| P0 | It makes a check answer "no" now | the failing check output and the line that ties it to the issue |
| P1 | It has cost time more than once | session ids, run ids or counts of turns, hours or incidents |
| P2 | The operator asked for it in the current conversation | the operator message |
| P3 | Everything else | none |

Order inside a class:

1. Issues that unblock other issues go first; follow the declared `blocked-by` relationships.
2. Issues that edit the same files go one after the other; issues that edit different files can run in parallel.
3. In P1, a higher observed cost goes first.

In the backlog scope, an issue that no check and no evidence reaches is P3. Report it as a candidate to close or to refine; close or relabel it only when the operator asks.

## 4. Output and enqueue

Show the order as one table: position, issue, class, evidence, the check it turns to "yes". After the operator confirms, enqueue the issues in Dagu in that order with the `dagu-feature` skill. P3 issues are not enqueued.

## 5. Close

At the end of the session, run the checks again. Report each check as yes or no. The checks that answer "no" are the answer to "what blocks?" or "what is left?".

## Rules

- Answer "what blocks?" with the check output. Each blocker names its failing check, its cause and its fix.
- A new process step (seal, checkpoint, gate, approval) enters only with a check that shows it keeps the objective's checks at "yes".
- When a P0 breaks the Dagu cycle itself, fix it with a direct PR and merge; the cycle cannot repair itself.
- Attribute each run to the session in its `OMP_SESSION_ID` parameter. A run whose owner session is not alive is a station failure.
- Re-rank when a check changes its answer or the operator changes the objective; an order written in an earlier session is not reused without re-running the checks.
