# Doctor mode

Doctor finds what is wrong in the backlog and fixes all of it in one approved pass. `doctor <id>` limits it to that task or epic.

## 1. Diagnose (read-only)

Run the tree recipe and `bd dep cycles --json`. Read comments (`bd show "$ID" --include-comments --json`) and provenance (`bd provenance log "$ID" --json`) only for records with a finding. Report, with literal IDs and the observed field, command output, SHA or `path:line` as evidence:

- **graph**: cycles, broken edges, types other than `epic`/`task`, nested epics, executable epics, epics with no open children, open children of closed parents;
- **edges**: a `blocks` target closed as duplicate or superseded while open successor work exists; dependencies written only in prose (mentioned IDs that exist but are not linked);
- **ownership**: several `in_progress` tasks in one scope; `in_progress` whose owner or checkpoint contradicts Git, comments or notes; checkpoint metadata on a task that is not `in_progress`;
- **readiness**: tasks failing `definition_of_ready`; readiness drift;
- **relevance**: tasks already resolved on the base branch, targeting code absent from it, implementing a superseded ADR, duplicated by another Bead, or filed questions rather than work.

A suspicion without evidence is not a finding.

## 2. Propose (one pass)

Build one proposal for all findings in scope:

- **Deterministic fixes**: the exact `bd` commands that follow from provider state and existing text.
- **Backfill** for tasks failing `definition_of_ready`: the complete resulting `description`, `design` and `acceptance_criteria` per task. Propose text only from a citable source (repository `path:line`, ADR or spec line, Bead field or note, commit SHA, Backscroll or Engram hit); keep existing text.
- **Questions**: every missing value that has no source, all together, each with the evidence and one concrete question.

Show the proposal once and end with: **approve exactly**, **request adjustments**, or **reject**. Answers to the questions are part of the approval; revise the proposal once with them and apply.

## 3. Apply and verify

Apply only the approved commands, using flags from `bd update --help` (for example `--body-file`, `--design-file`, `--acceptance`), `bd dep add|remove`, `bd duplicate`, `bd supersede` and `bd close --reason "<evidence>"`. Status or assignee corrections use `--if-status` and `--if-assignee` with the observed values. Stop on any failure or effect that differs from the proposal; do not improvise.

Then re-read the affected Beads and dependencies, run `bd dep cycles --json`, rerun the tree, and report: applied fixes, remaining findings, and the next executable candidate.

When Loop calls Doctor for backfill (`incomplete_task_policy: backfill`), the scope is that one task and Loop resumes after verification.
