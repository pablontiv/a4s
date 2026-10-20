---
name: backlog-breakdown
description: Import prepared issue units into the planning backend, obtain independent review and operator approval, and create idempotent backlog issues.
---
# Backlog breakdown backend

Use after refine, discovery or the coordinator has prepared self-contained units. Refinement belongs upstream: this skill operates the backend, rather than adding another need-to-unit or plan-writing task. Local acceptance authorizes a backend run; the operator separately authorizes GitHub issue publication. Sprint-planning owns ranking and enqueueing new feature/PoC work.

## Input and invocation

Prepare an absolute `UNITS_FROM` path to a JSONL file, one unit per line:

```json
{"id":"observable-change","title":"Deliver observable change","dag":"feature","labels":[],"body":"## Problem\nFull problem\n## Change\nComplete scope\n## Acceptance\nObservable outcome and exact targeted test command","source":"refine"}
```

Required fields are `id,title,dag,labels,body`. IDs are unique kebab-case. `dag` is `feature` or `poc`. Feature bodies require `## Problem`, `## Change`, `## Acceptance`; PoC bodies require `## PoC`, `## Verdict`, `## After PASS`, plus a nonempty `question`. Existing Spanish equivalents remain accepted. Each issue states its full problem, complete scope and observable acceptance; every unit is independently deliverable. PoC is for unexercised external/runtime behavior that can change the implementation path.

Optional `source` is `refine`, `discovery` or `plan`. Optional `findings` is an array of unique nonempty finding IDs. Preserve source markers and evidence already in the body. The backend retains the exact imported rows and appends source/finding lineage to issue bodies. The run's `SOURCE` defaults to `plan` and supplies provenance for rows without `source`.

Optional neighboring `source.md` and `plan.md` provide reviewer context. Import copies them alongside the unit snapshot. Each explicit reimport refreshes context from upstream; without a neighboring source file, `source.md` contains the run's `SOURCE`, and `plan.md` is present only when supplied upstream.

Get the parent `OMP_SESSION_ID` from `dagu_session_id`. From the adopted repository's main clone, using the scheduler's `DAGU_HOME`:

```sh
dagu-feature-bundle enqueue --run-id "<repo>-breakdown-<slug>" "<main-clone>/.workspace/dagu/dags/planning.yaml" -- \
  UNITS_FROM="<absolute-units.jsonl>" PRIMARY="<main-clone>" SOURCE=refine OMP_SESSION_ID="<session-id>"
```

The installed filename and DAG name remain `planning.yaml` / `planning`. Its steps are `init → import_units → check_plan → review → check_review → approve → materialize`. `init` prints the bundle identity and `out_dir`: `${DAGU_HOME:-$HOME/.dagu}/data/planning/<owner>__<repo>/<run-id>/`. `import_units` makes a deterministic copy to `units.jsonl`. `check_plan` validates it and records line-local `units.jsonl:<line>: rule=<name>` diagnostics in `findings.md`. Inspect import/check errors at the waiting `review` checkpoint before requesting a reviewer.

## Independent review

At `review`, gather current open issues and active workspace runs. Launch `task agent=plan-reviewer`, named `PlanReview<RUN>` (retry `PlanReview<RUN>v<N>`), with the exact `PLAN_REVIEW` generation marker from the prompt/output file `generation`, `source.md`, `units.jsonl`, optional `plan.md`, and that evidence. Reviewer routing selects an independent model. Wait for its structured result, then complete:

```sh
dagu human-task complete planning --run-id <run> --step review --input REVIEW=<allocated-subagent-id>
```

The verifier binds the unique transcript to the parent session, reviewer agent, run/generation and review start time. It checks the last structured yield and stores `review-<iteration>.json`. `findings.md` explains revisions or verification failures. Inspect `check_review` logs as well. A failed or `revise` review remains at `approve` for explicit correction; only an accepted review of the unchanged imported units can publish.

## Approval and corrections

At `approve`, present the units and review to the operator. Obtain explicit authorization for all or the exact subset of IDs. The CLI does not authenticate the operator: the coordinator owns this approval boundary.

```sh
dagu human-task complete planning --run-id <run> --step approve --input APPROVED=all
# Or: --input APPROVED=id-one,id-two
```

For invalid units, a `revise` verdict, or requested changes, refine/the coordinator edits the original `UNITS_FROM` file first. Read `dagu status planning --run-id <run>` and its run-wide `push-back iteration` (default zero), then explicitly push back the currently waiting checkpoint:

```sh
dagu human-task push-back planning --run-id <run> --step review --expected-iteration <observed> --input FEEDBACK="<correction summary>"
# When waiting at approve instead:
dagu human-task push-back planning --run-id <run> --step approve --expected-iteration <observed> --input FEEDBACK="<correction summary>"
```

Both rewind to `import_units`, re-copy the corrected upstream file, and require fresh validation and independent review. A retry uses the current generation marker and a fresh allocated reviewer ID. The backend waits for explicit push-back; it does not automatically reimport unchanged rejected input. If approval was mistakenly completed and materialization failed, use Dagu's terminal-run recovery before repeating review/approval.

## Created backlog

After accepted review and operator approval, `materialize` creates the approved issues with their labels and `<!-- breakdown-unit: <run-id>/<id> -->`. It records `{id,number,url,reused}` rows in `issues.jsonl`. Repeated materialization searches every issue page and reuses marker-bearing issues. Discovery-sourced bodies carrying `<!-- discovery-unit: <id> -->` also retain that stable identity across backend runs, so persistent discovery findings reuse the same issue. Duplicate marker matches fail closed. Inspect `issues.jsonl`, created issue bodies and step logs as durable evidence. The backend ends after issue creation; hand the resulting backlog to sprint-planning for prioritization and admission.
