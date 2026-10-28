---
name: backlog-breakdown
description: Import prepared issue units into the planning backend, obtain independent review and operator approval, and create idempotent backlog issues.
---
# Backlog breakdown backend

Use after refine, discovery or the coordinator has prepared self-contained units. Refinement belongs upstream: this skill operates the backend, rather than adding another need-to-unit or plan-writing task. Local acceptance authorizes a backend run; the operator separately authorizes GitHub issue publication. Sprint-planning owns ranking and enqueueing new feature/PoC work.

One coordinator owns canonical `units.jsonl` and integration. Preparation delegates only genuine unresolved questions with known source ranges and explicitly bounded outputs; the coordinator incorporates the evidence directly. Mechanical preparation may use the installed public API's role-scoped `AgentDefinition.thinkingLevel: low` or `@task:low`. Global model settings stay unchanged. Suffixes take precedence over agent defaults, and enabled caller model/effort overrides may supersede both; record the exercised dispatch's final native `resolvedModelIdentity`, `resolvedThinkingLevel` and transcript evidence. Unexpected native findings return to coordinator judgment. Preparation effort is distinct from semantic review.

## Input and invocation

Prepare an absolute `UNITS_FROM` path to a JSONL file, one unit per line:

```json
{"id":"observable-change","title":"Deliver observable change","dag":"feature","labels":[],"body":"## Problem\nFull problem\n## Change\nComplete scope\n## Acceptance\nObservable outcome and exact targeted test command","source":"refine"}
```

Required fields are `id,title,dag,labels,body`. IDs are unique kebab-case. `dag` is `feature` or `poc`. Feature bodies require `## Problem`, `## Change`, `## Acceptance`; PoC bodies require `## PoC`, `## Verdict`, `## After PASS`, plus a nonempty `question`. Existing Spanish equivalents remain accepted. Each issue states its full problem, complete scope and observable acceptance, including targeted test commands. Self-contained means that this content is understandable and reviewable on its own; delivery may require explicitly declared prerequisites. PoC is for unexercised external/runtime behavior that can change the implementation path.

Optional `source` is `refine`, `discovery` or `plan`. Optional `findings` is an array of unique nonempty finding IDs. Preserve source markers and evidence already in the body. The backend retains the exact imported rows and appends source/finding lineage to issue bodies. The run's `SOURCE` defaults to `plan` and supplies provenance for rows without `source`.

Optional `relationships` is the canonical structured relationship intent:

```json
{"relationships":[{"kind":"blocked_by","target":{"unit":"prerequisite-unit"}},{"kind":"blocked_by","target":{"issue":442}},{"kind":"parent","target":{"unit":"umbrella-unit"}}]}
```

Each relationship has exactly `kind` and `target`. `blocked_by` means the current unit requires the target; `parent` means the current unit is a sub-issue of the target. A target has exactly one key: `unit` is an exact ID in this imported snapshot (forward references supported), or `issue` is an existing issue number in the adopted repository (positive safe integer). Units accept only the documented fields. Omitted or empty relationships mean no declared intent. Use at most one parent and one occurrence of each kind/target pair. Native validation diagnoses malformed kinds/targets, unknown local IDs, self-references and cycles in each same-snapshot graph separately; a parent's completion may legitimately require its child. Existing-issue identity and remote graph state require GitHub evidence during semantic review. State prerequisite rationale and the umbrella's own outcome in the body; completeness and prerequisite scheduling are separate judgments.

`units.jsonl` remains the single editable input. Import and validation retain its exact bytes; relationship fields are included in the same generation-bound independent review as every other field.

Optional `revision` binds a unit to an existing issue in this repository:

```json
{"revision":{"issue":444,"fields":["title","body","labels"]}}
```

The object has exactly `issue` (a positive safe integer) and `fields` (unique names from `title`, `body`, `labels`). Values come from those fields at the canonical unit root. `fields: []` binds/reuses identity only. Only explicitly declared fields are revised; an explicit body revision is the exact root body, including its existing markers if they are intended. New units and marker-reused units retain their normal create/reuse behavior. Each existing issue identity belongs to one unit; duplicate bindings fail closed. Present the exact revision and relationship intent with the unit for review and operator approval.

Run the existing package's canonical validator during upstream preparation:

```sh
dagu-feature-bundle validate-planning-units --input "/absolute/path/to/units.jsonl" \
  --snapshot "/absolute/path/to/validated-units.jsonl" --findings "/absolute/path/to/findings.md"
```

Only `--input` is required and it must be absolute. The same command is used by native `check_plan`. It collects independent mechanical errors, including malformed JSON lines, as JSONL diagnostics with `line`, `field`, `rule`, `expected`, and `observed`, ordered by line, field, then rule. Missing values are explicit `{"missing":true}`. Stderr and optional findings contain identical diagnostics; any invalid input exits nonzero and clears the requested snapshot. Valid input yields an exact-byte snapshot, including whitespace and line endings. Input and output paths must be distinct. Correct only canonical `units.jsonl`; the snapshot is evidence. Mechanical validation establishes the schema and graph contract; the independent reviewer owns completeness, duplication, rationale and semantic judgment.

Optional neighboring `source.md` and `plan.md` provide reviewer context. Import copies them alongside the unit snapshot. Each explicit reimport refreshes context from upstream; without a neighboring source file, `source.md` contains the run's `SOURCE`, and `plan.md` is present only when supplied upstream.

Get the parent `OMP_SESSION_ID` from `dagu_session_id`. From the adopted repository's main clone, using the scheduler's `DAGU_HOME`:

```sh
dagu-feature-bundle enqueue --run-id "<repo>-breakdown-<slug>" planning -- \
  UNITS_FROM="<absolute-units.jsonl>" PRIMARY="<main-clone>" SOURCE=refine OMP_SESSION_ID="<session-id>"
```

The installed filename and DAG name remain `planning.yaml` / `planning`. Its steps are `init → import_units → check_plan → review → check_review → approve → materialize`. `init` prints the bundle identity and `out_dir`: `${DAGU_HOME:-$HOME/.dagu}/data/planning/<owner>__<repo>/<run-id>/`. `import_units` makes a deterministic copy to `units.jsonl`. `check_plan` invokes the same package validator and records the complete structured diagnostics in `findings.md`. Inspect import/check errors at the waiting `review` checkpoint before requesting a reviewer.

## Independent review

At `review`, gather current open issues and active workspace runs. Launch `task agent=plan-reviewer`, named `PlanReview<RUN>` (retry `PlanReview<RUN>v<N>`). The exact `PLAN_REVIEW` generation marker from the prompt/output file `generation` is the first line of that assignment's `task` field. `check_review` reads that line from `session_init.task`. Do not place the marker only in the shared `context` field. Pass `source.md`, `units.jsonl`, optional `plan.md`, and that evidence in the same assignment. Preserve the reviewer's `@slow` declaration, existing independent model routing and enabled overrides, regardless of preparation effort. The accepted `review-<iteration>.json` keeps `verdict` and `findings` and records `reviewer`: the agent name, the session id, the provider and model of the transcript's final assistant message, and the ordered `model_change` entries with `resolvedModelIsFallback`. That object uses the same transcript derivation as native role evidence. `session_init.resolvedModel` does not select the model. Wait for the structured result, then complete:

```sh
dagu human-task complete planning --run-id <run> --step review --input REVIEW=<allocated-subagent-id>
```

The verifier binds the unique transcript to the parent session, reviewer agent, run/generation and review start time. It checks the last structured yield and stores `review-<iteration>.json` with `verdict`, `findings`, and the `reviewer` identity above. `findings.md` explains revisions or verification failures. Inspect `check_review` logs as well. A missing generation marker is reported as absent from the reviewer's `session_init.task`, together with the expected marker. A failed or `revise` review remains at `approve` for explicit correction; only an accepted review of the unchanged imported units can publish.

`check_plan`, `check_review` and `materialize` bind the same canonical native review iteration: `approvalIteration` on the unique `review` node in `/api/v1/dag-runs/planning/<run>`. On the official Dagu runtime, an omitted counter on that present node means initial iteration zero; a native push-back advances it even while mechanical steps run and review is not waiting. The current REST review start time remains the independent transcript-freshness cutoff.

## Approval and corrections

At `approve`, present the units, their relationship intent and review to the operator. Obtain explicit authorization for all or the exact subset of IDs. An approved subset must include every same-snapshot target referenced by its units, transitively; external issue targets remain references rather than authorization to edit those issues. The CLI does not authenticate the operator: the coordinator owns this approval boundary.

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

After accepted review and operator approval, `materialize` creates approved new issues with their labels and `<!-- breakdown-unit: <run-id>/<id> -->`, reuses unambiguous marker identities, and applies only declared revisions. Discovery-sourced bodies carrying `<!-- discovery-unit: <id> -->` retain stable identity across backend runs. Full paginated repository issue reads and durable identity mappings resolve retries independently of GitHub search indexing. Ambiguous markers or conflicting identities fail closed before publication.

Declared `blocked_by` and `parent` relationships become native GitHub dependency and sub-issue edges after all approved identities are resolved. Existing edges are preserved. A different existing parent is a diagnosed conflict; coordinator judgment resolves it. External targets authorize the declared edge, while field edits require their own explicitly approved revision unit.

Native graph mappings retain GitHub's global issue identity together with repository and issue number. Existing cross-repository edges remain distinct from adopted-repository edges with the same issue number; a conflicting parent finding includes its repository identity. Canonical `{issue: N}` targets continue to name issues in the adopted repository.

`issues.jsonl` records `{id,number,url,reused}`. Beside it, `materialization-<run>-<iteration>.json` retains scope, unit/field/edge mappings, baseline and intended state, pending/applied/verified progress, and grouped remote readback with structured mismatches. Its neighboring `-units.jsonl` is the exact reviewed snapshot binding recovery. Final verification groups every affected issue and both directions of its native relationships, following all connection pages. Only a complete title/body/labels/graph match is successful. Findings identify conflicts, inaccessible issues, failed commands and remote mismatches; successful partial effects remain durable so retrying the same reviewed publication converges. Inspect these artifacts and `findings.md`, then hand the verified backlog to sprint-planning for prioritization and admission.
