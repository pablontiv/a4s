---
name: sprint-retrospective
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: Sprint Retrospective (Scrum Guide 2020) for an agent session. Records process incidents during the sprint and, at its end, turns each incident without an issue into a need for the `refine` skill in the repository that owns the component. Use when a process incident occurs, when a report arrives from another session, and after the `sprint-review` skill. Requires `gh`.
---

# Sprint Retrospective

The session proposes the incident list; the operator confirms which incidents enter `refine`.

## Process incident

A process incident is an event where work stopped outside a human task's documented contract:

- a component failed (a DAG step, an exit handler, a guard, CI, a merge procedure);
- a recovery needed a command that no skill documents;
- a report arrived from another session (a bug, a deadlock, a request).

## During the sprint

Record each incident in the turn report under **Blockers and decisions** with its evidence: run id, step, log line, or the report text.

For a report from another session, answer the operational question first with the exact command that recovers the sender's run, then record the incident.

## At the end of the sprint

1. List the incidents in one table: incident, evidence, component, owning repository, existing issue.
2. For each incident with no open issue, run the `refine` skill with the incident and its evidence as the need, in the owning repository.
3. Send the resulting issue number to the session that reported the incident, when there is one.
4. Mark an incident that repeats an earlier one as repeated, with both evidences; the next `sprint-planning` ranks it P1.
