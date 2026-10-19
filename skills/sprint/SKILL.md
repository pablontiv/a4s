---
name: sprint
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: The sprint of an agent session, in Scrum Guide 2020 terms. Sprint Planning orders a repository's issues against an operator-confirmed goal with yes/no checks (session scope = Sprint Goal, backlog scope = Product Goal) and enqueues the Sprint Backlog in Dagu; Sprint Review re-runs the checks; Retrospective turns the sprint's process incidents into refined needs. Defines the Definition of Done and how reports from other sessions enter. Use when the operator asks to prioritize, order, plan or re-plan issues, asks "what blocks?" or "what is left?", closes a session, receives a report from another session, or before enqueueing several issues in Dagu. Requires `gh`.
---

# Sprint

One coordinator session is one sprint. The session decides the order with the operator. Dagu executes the queue in the order the session enqueues; it never ranks issues.

## Flow and owners

| Event | Owner | Output |
|---|---|---|
| Refinement | Session runs `refine`; operator answers | Issues in the backlog |
| Sprint Planning | Session proposes; operator confirms goal, checks and order | Sprint Backlog enqueued in Dagu |
| Execution | Dagu, subagents (triage, PoC, implement, QA, reviewer), reconciler | One Dagu run per issue, until its Definition of Done |
| Daily | Session | The turn status report of the `dagu-feature` skill |
| Sprint Review | Session runs checks; operator accepts or changes the goal | Checks answered yes/no |
| Retrospective | Session proposes; operator confirms | One refined need per process incident |

## Scopes

The same procedure has two scopes:

- **Sprint:** the Sprint Goal of the current session. The output is the Sprint Backlog: the issues to work on now, in order.
- **Product:** the standing Product Goal of the repository. The output is the order of every open issue.

## 1. Goal

Write the goal as one sentence that describes an observable result, and get the operator's confirmation before ranking. Example: "The Dagu cycle of a4s and activities takes an issue to merge without manual intervention."

## 2. Checks

Convert the goal into 3–5 checks. Each check is one command with an expected result, so its answer is yes or no:

| Check | Command | Expected |
|---|---|---|
| Admission | `dagu-feature-bundle admit --run-id <probe> .workspace/dagu/dags/feature.yaml -- ISSUE=<n>` in each adopted repo, then delete the probe receipt | exit 0 |
| Reconciler | `dagu history reconcile --format json --limit 5` | all `succeeded` |
| Station | owner `OMP_SESSION_ID` of every `waiting`/`queued` run | a live session owns each run |
| CI | `gh run list --branch main --limit 1` | `success` |

Run every check and record its output. The operator confirms the checks together with the goal.

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

In the product scope, an issue that no check and no evidence reaches is P3. Report it as a candidate to close or to refine; close or relabel it only when the operator asks.

## 4. Sprint Backlog and enqueue

Show the order as one table: position, issue, class, evidence, the check it turns to "yes". After the operator confirms, enqueue the issues in Dagu in that order with the `dagu-feature` skill. P3 issues are not enqueued.

## 5. Definition of Done

An issue is done when all of these are true:

| Condition | Evidence |
|---|---|
| The candidate passed the local gate and two current quality PASS verdicts (QA and reviewer) | `quality.json` of the run |
| The PR is merged into the default branch | `gh pr view <pr> --json state` → `MERGED` |
| Every required check passed on the merged SHA | `authorize_ci` succeeded |
| The issue is closed | `gh issue view <n> --json state` → `CLOSED` |
| The Dagu run succeeded, and its worktree and branch are removed | `dagu status` → `succeeded`; reconcile reports no `LEFTOVER` for the issue |

A PoC issue is done when its verdict comment is published and its run succeeded: PASS with `promote=yes` continues as a feature run of the same issue, which follows the table above; FAIL closes the issue as not planned.

The sprint is done when every check of the Sprint Goal answers "yes".

## 6. Sprint Review

At the end of the session, run the checks again. Report each check as yes or no, and each Sprint Backlog issue as done or not done against the Definition of Done. The checks that answer "no" are the answer to "what blocks?" or "what is left?". The operator accepts the result or changes the goal for the next sprint.

## 7. Retrospective

A process incident is an event where work stopped outside a human task's documented contract: a component failed, a recovery needed a command that no skill documents, or a report arrived from another session. During the sprint, record each incident in the turn report under **Blockers and decisions** with its evidence (run id, step, log line, or the report).

At the end of the sprint, list the incidents in one table: incident, evidence, the component that caused it, and its repository. For each incident that has no open issue, run `refine` with the incident as the need, in the repository that owns the component. An incident that repeats an earlier one is P1 in the next Sprint Planning.

## Reports from other sessions

A report from another session (a bug, a deadlock, a request) is a process incident of the repository that owns the affected component:

- Answer the operational question first: the exact command that recovers the sender's run.
- Run `refine` with the report as the need, so the fix enters the backlog as an issue; send the issue number to the sender.

## Rules

- Answer "what blocks?" with the check output. Each blocker names its failing check, its cause and its fix.
- A new process step (seal, checkpoint, gate, approval) enters only with a check that shows it keeps the goal's checks at "yes".
- When a P0 breaks the Dagu cycle itself, fix it with a direct PR and merge; the cycle cannot repair itself.
- Attribute each run to the session in its `OMP_SESSION_ID` parameter. A run whose owner session is not alive is a station failure.
- Re-rank when a check changes its answer or the operator changes the goal; an order written in an earlier session is not reused without re-running the checks.
