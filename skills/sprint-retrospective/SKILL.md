---
name: sprint-retrospective
metadata:
  author: pablontiv
  updated: "2026-10-19"
description: Sprint Retrospective (Scrum Guide 2020) for an agent session. Records process incidents and reports during the sprint and hands actionable evidence to refine in the repository that owns the component. Use when a process incident occurs, when a report arrives from another session, and after sprint-review.
---

# Sprint Retrospective

The session proposes the incident list; the operator confirms which incidents enter `refine`.

## Process incident

A process incident is an event where work stopped outside a human task's documented contract, such as a failed DAG step, exit handler, guard, CI or merge procedure, or a recovery that needed an undocumented command.

Reports from other sessions may describe incidents, bugs, requests or FYI observations. Record the report's intent and evidence; distinguish an actionable need from information that only needs acknowledgment.

## During the sprint

Record each incident or report in the turn report under **Blockers and decisions** with its evidence: run id, step, log line, or report text.

Answer an operational question when one was asked, using the documented recovery supported by the evidence. Identify the responsible session and any operator decision required. A FYI report is evidence to record, not authorization to mutate state, recover a run or publish. Supply a recovery command only when the report calls for recovery and the evidence supports it; otherwise preserve the observation or unanswered question for refinement.

## At the end of the sprint

1. List the incidents and reports in one table: incident or report, intent, evidence, component, owning repository, existing issue, responsible session/operator and next action.
2. For each actionable need without an open issue that the operator selected for refinement, hand the incident/report and evidence to `refine` in the owning repository. Refine produces units for `backlog-breakdown`, which owns reviewed issue materialization. Existing issues receive the relevant evidence through the responsible session; FYI-only reports remain recorded observations.
3. Return the resulting refinement or issue reference to the reporting session as appropriate within the operator's authorization. New issues return to `sprint-planning` for ranking and enqueue.
4. Mark a repeated incident with both sets of evidence so the next `sprint-planning` can rank it P1.
