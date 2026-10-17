---
name: dagu-planning
description: Convert an OMP-local approved plan into independently reviewed, operator-approved issues and durable feature or PoC runs.
---
# Planning lifecycle

Draft in OMP plan mode. Local plan approval authorizes orchestration, not inline implementation or GitHub publication. Obtain `OMP_SESSION_ID` from `dagu_session_id`, then enqueue from the adopted repository's main clone:

```sh
dagu enqueue --run-id "<repo>-planning-<slug>" .workspace/dagu/dags/planning.yaml -- \
  SOURCE="<operator request>" PRIMARY="<main clone>" OMP_SESSION_ID="<session id>"
```

Use the same `DAGU_HOME` as the scheduler. `init` prints `out_dir` and the stamped bundle identity. Artifacts live at `${DAGU_HOME:-$HOME/.dagu}/data/planning/<owner>__<repo>/<run-id>/`.

At `plan`, copy the locally approved plan to `plan.md` in that directory and write `units.jsonl`, one object per line:

```json
{"id":"observable-change","title":"Deliver observable change","dag":"feature","labels":[],"body":"## Problema\nFull problem\n## Cambio\nComplete scope\n## Aceptación\nObservable outcome and exact targeted test command"}
```

Feature bodies require `## Problema`, `## Cambio`, `## Aceptación`. PoC units use `dag:"poc"`, a nonempty `question`, and `## PoC`, `## Veredicto`, `## Después del PASS`. IDs are unique kebab-case. Every issue is independently deliverable. Complete `plan` with `dagu human-task complete planning --run-id <run> --step plan`.

`check_plan` validates the files. An invalid plan records `units.jsonl:<line>: rule=<name>` in `findings.md`; the bounded dispatcher returns the run to `plan` with incremented run-wide iteration. Read those findings when correcting the artifacts. Dispatcher logs are `review-transition.log` and `approve-transition.log`.

At `review`, read the exact generation marker from its prompt (also `generation` in the output directory). Gather current open issues and active workspace runs with `gh issue list` and Dagu history. Launch `task agent=plan-reviewer`, named `PlanReview<RUN>` (retry `PlanReview<RUN>v<N>`), with the full marker, source.md, plan.md, units.jsonl and that evidence. The package's cross-family reviewer routing selects an independent model. Wait for its structured result, then complete:

```sh
dagu human-task complete planning --run-id <run> --step review --input REVIEW=<allocated-subagent-id>
```

The verifier binds the unique transcript to the parent session, agent, run/generation and review start time, checks its last yield, and stores `review-<iteration>.json`. A `revise` returns automatically to `plan`; read `findings.md`. Missing, stale, foreign or malformed transcripts fail closed. Recover a terminal run through Dagu's terminal-run recovery; a new reviewer must start after that run's current `review.startedAt`. Each retry uses a fresh allocated reviewer id and the current marker.

At `approve`, present the reviewed units to the operator and obtain explicit approval of all or the exact unit IDs. `dagu human-task` does **not authenticate the operator**: the coordinator is responsible for honoring that approval boundary. Complete only the approved selection:

```sh
dagu human-task complete planning --run-id <run> --step approve --input APPROVED=all
# or --input APPROVED=id-one,id-two
```

Before any manual push-back, read `dagu status planning --run-id <run>` and its run-wide `push-back iteration` (default zero). To request changes use `dagu human-task push-back planning --run-id <run> --step approve --expected-iteration <observed>`; this rewinds to `plan` and requires fresh review.

Only after approval, `materialize` creates issues with labels and `<!-- planning-unit: <run-id>/<id> -->`, recording `{id,number,url,reused}` in `issues.jsonl`. Repeating materialization for the same run reuses marker-bearing issues across all issue pages. `dispose` skips existing run IDs and enqueues `<repo>-issue-<n>` for feature or `<repo>-poc-<n>` for PoC, preserving `OMP_SESSION_ID` and the PoC question. Inspect logs and `issues.jsonl` as durable evidence. Record the first post-merge planning run and its `check_plan`, `check_review`, `materialize`, and `dispose` logs in the delivery issue.

Bootstrap stages four repository DAGs: feature, poc, discovery and planning. Adoption copies all four stamped files to `.workspace/dagu/dags/`; the user-level reconcile DAG remains separately installed.
