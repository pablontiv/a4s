---
name: sprint-retrospective
metadata:
  author: pablontiv
  updated: "2026-11-08"
description: Sprint Retrospective (Scrum Guide 2020) for an agent session. Records process incidents and reports during the sprint and carries approved improvements through refine in the repository that owns the component. Use when a process incident occurs, when a report arrives from another session, and after sprint-review.
---

# Sprint Retrospective

Inspect how the work went and identify changes that improve quality and effectiveness. The session proposes the incident list and improvements; the operator confirms which actionable needs enter `refine`.

## Process incident

A process incident is an event where work stopped outside the documented procedure or agreed contract, such as a failed local gate, review, CI or merge procedure, or a recovery that needed an undocumented command.

Reports from other sessions may describe incidents, bugs, requests or FYI observations. Record the report's intent and evidence; distinguish an actionable need from information that only needs acknowledgment.

## During the sprint

Record each incident or report in the turn report under **Blockers and decisions** with its evidence: issue or PR reference, candidate SHA, failed check, log line or report text.

Answer an operational question when one was asked, using the documented recovery supported by the evidence. Identify the responsible agent and any operator decision required. A FYI report is evidence to record, not authorization to mutate state, perform recovery or publish. Supply a recovery command only when the report calls for recovery and the evidence supports it; otherwise preserve the observation or unanswered question for refinement.

## At the end of the sprint

1. List the incidents and reports in one table: incident or report, intent, evidence, component, owning repository, existing issue, responsible agent/operator and next action. Include the proposed improvement and expected outcome for actionable process changes.
2. For each actionable need without an open issue that the operator selected, invoke `refine` in the owning repository with the incident/report and evidence. This follow-through is mandatory: a recommendation to refine is not completion. `refine` produces units for `backlog-breakdown`, which owns independently reviewed, operator-approved issue creation. Existing issues receive the relevant evidence through the responsible agent; FYI-only reports remain recorded observations. Under an explicit autonomous mandate, send every actionable, evidenced incident/report to `refine` within that mandate's approval limits.
3. Record the resulting refinement or existing issue reference and return it to the reporting agent as appropriate within the operator's authorization. Do not mark an approved improvement followed through until its reference is recorded; if refinement is blocked, record the exact prerequisite, owner and next action. New issues return to `sprint-planning` for ranking and selection; do not treat refinement as authorization to implement them.
4. Mark a repeated incident with both sets of evidence so the next `sprint-planning` can rank it P1. Carry the selected improvements into the next sprint's planning and evaluate their effect in the next retrospective.
