---
name: backlog-breakdown
description: Import prepared issue units, obtain independent review and operator approval, and publish an idempotent backlog with verified relationships.
---
# Backlog breakdown

Use after [refine](../refine/SKILL.md), [repository-discovery](../repository-discovery/SKILL.md), or the coordinator has prepared self-contained units. Refinement belongs upstream; this procedure reviews and publishes prepared units rather than inventing another planning phase. Acceptance of a local plan does not authorize issue publication. [Sprint-planning](../sprint-planning/SKILL.md) owns ranking and admission to execution.

This is a tool-free procedure: use the repository's available editing, review, and issue interfaces, without requiring a particular scheduler, extension, command wrapper, or agent implementation. Read the adopted repository's AGENTS.md and CONTRIBUTING.md first. One coordinator owns canonical `units.jsonl`, evidence, and integration. Delegate genuinely unresolved questions with known source ranges and bounded outputs; incorporate their evidence directly. Mechanical preparation may use lower effort, but never weaken independent semantic review or change global model settings. Record the actual reviewer identity and, where available, model and effort evidence rather than assuming configured routing was exercised.

## 1. Import a frozen input

Prepare an absolute path to `units.jsonl`, one JSON object per line:

```json
{"id":"observable-change","title":"Deliver observable change","kind":"feature","labels":[],"body":"## Problem\nFull problem\n## Change\nComplete scope\n## Acceptance\nObservable outcome and exact targeted test command","source":"refine"}
```

Required fields are `id`, `title`, `kind`, `labels`, and `body`. IDs are unique kebab-case; `kind` is `feature` or `poc`; labels are unique nonempty strings. Titles and bodies are nonempty. Feature bodies require `## Problem`, `## Change`, and `## Acceptance`. PoC bodies require `## PoC`, `## Verdict`, and `## After PASS`, plus a nonempty root `question`. Write new content in English; recognize equivalent headings in existing imported issues. Each issue states its full problem, complete scope, observable acceptance and exact targeted checks. Self-contained means independently understandable and reviewable, not free of explicitly declared prerequisites. A PoC addresses unexercised external or operational behavior that can change the implementation path: execute it directly under operator-approved scope, consult the pve-api skill when applicable, and record PASS, FAIL, or INCONCLUSIVE with evidence in the issue. Never label an unexercised hypothesis PASS.

Optional `source` is `refine`, `discovery`, or `plan` (default `plan`). Optional `findings` contains unique nonempty finding IDs. Preserve existing provenance markers and evidence. Append source/finding lineage to newly published bodies; an explicitly revised body remains the exact approved body. Optional neighboring `source.md` and `plan.md` provide reviewer context. Refresh context on every corrected import; do not silently reuse stale context.

Optional `relationships` declares exact relationship intent:

```json
{"relationships":[{"kind":"blocked_by","target":{"unit":"prerequisite-unit"}},{"kind":"blocked_by","target":{"issue":442}},{"kind":"parent","target":{"unit":"umbrella-unit"}}]}
```

Each relationship has exactly `kind` and `target`. `blocked_by` means this unit requires the target; `parent` means this unit is a sub-issue of the target. A target has exactly one key: `unit` names an exact ID in the imported snapshot, including forward references; `issue` is a positive safe integer naming an existing issue in the adopted repository. At most one parent and one occurrence of each kind/target pair are allowed. Reject unknown local IDs, self-references, and cycles within each same-snapshot graph separately; a parent's completion may legitimately require its child. Explain prerequisites and the umbrella's own outcome in the body. Completeness and prerequisite scheduling are separate judgments. Existing issue identity and remote graph state require current hosting-service evidence.

Optional `revision` binds identity to an existing issue:

```json
{"revision":{"issue":444,"fields":["title","body","labels"]}}
```

It has exactly `issue` (positive safe integer) and `fields` (unique values from `title`, `body`, `labels`). Values come from the unit root. Empty fields bind/reuse identity only. Edit only explicitly listed fields; body replacement is the exact approved root body, including markers that must survive. Each existing issue identity belongs to only one unit; reject duplicate bindings. Undeclared issue edits are never implicit.

Keep `units.jsonl` the single editable input. Preserve an exact-byte, immutable imported snapshot, its digest, repository identity and an import identity chosen once for this publication; do not replace the snapshot in place. Retain context and all review/approval evidence beside it in a designated evidence directory outside the audited source tree unless repository policy says otherwise. Accept only the fields documented above.

## 2. Validate before semantic review

Check every JSON line, required field, type, allowed value, unique identity, heading, revision and relationship constraint. Collect all mechanical diagnostics with `line`, `field`, `rule`, `expected`, and `observed`, ordered by line, field and rule; represent a missing value explicitly. Invalid input cannot advance to publication. Record findings and the snapshot digest; mechanical validity is not semantic acceptance.

Read all relevant open issues and active implementation work with pagination. Resolve existing references, check duplication, parent conflicts and dependency rationale. Retain repository plus global issue identity, not issue number alone: cross-repository edges can share the same local number.

## 3. Obtain independent review

Assign an independent reviewer who did not prepare the units. Supply the exact frozen snapshot and digest, source/context, current issue inventory, active work, and relationship/revision intent. The reviewer checks completeness, observable acceptance, duplication, evidence, prerequisite rationale, scope, and every proposed remote field or edge change. Preserve applicable independent model-routing policy and record actual identity/model evidence when available; preparation shortcuts never substitute for this review.

Save a structured result with `verdict` (`accept` or `revise`), actionable `findings`, reviewer identity, review time, and the exact snapshot digest. An absent, ambiguous, stale, failed or `revise` review blocks publication. Acceptance applies only to unchanged imported bytes and the reviewed scope. The coordinator cannot accept their own preparation as independent review.

## 4. Approval and corrections

Present the exact reviewed units, revisions, relationships and accepted review to the operator. Obtain explicit approval for all IDs or a named subset. A coordinator may authorize publication only under a recorded autonomous mandate from [sprint-planning](../sprint-planning/SKILL.md) that explicitly permits issue creation and the proposed edits; retain mandate and coordinator attribution in the sprint ledger. Do not treat local preparation, an interface response, or reviewer acceptance as operator approval.

An approved subset must include every same-snapshot target referenced by its units, transitively. External targets authorize the declared edge, not edits to those issues. Record the approved IDs, digest, exact field/edge scope, authorizer and time. Approval cannot expand reviewed scope.

For invalid input, requested changes or a `revise` verdict, correct canonical input, import a new immutable snapshot, refresh context, validate again, and obtain fresh independent review and authorization. Supersede stale approvals explicitly. Cancellation before publication records `cancelled`, preserves evidence, and performs no remote writes. If partial publication has occurred, record its actual effects instead of describing cancellation as rollback.

## 5. Publish idempotently and reconcile

Before any write, resolve every approved identity against durable prior mappings and a full paginated repository issue inventory, including closed issues. Do not depend on search indexing. New issues receive a stable `<!-- breakdown-unit: IMPORT-ID/UNIT-ID -->` marker; preserve `<!-- discovery-unit: ID -->` when supplied. Reuse an unambiguous identity across retries; discovery markers provide stable identity across imports. A fresh import identity is not permission to duplicate an existing issue. Ambiguous markers, conflicting mappings, inaccessible targets or duplicate bindings fail closed before writes.

Retain a publication journal binding the reviewed snapshot/digest, approval, repository, unit/field/edge mappings, baseline and intended state, and pending/applied/verified progress. Resolve approved issue identities before adding native dependency and sub-issue edges. Preserve existing edges; a different existing parent is a conflict requiring coordinator/operator resolution, not permission to replace it. External targets receive only approved edges; field edits require their own approved revision.

Create approved new issues with exact approved title, body and labels; apply only declared revision fields. Record each successful effect durably before proceeding. On interruption, read remote state and resume the same approved intent rather than blindly recreate issues or repeat already-applied mutations. If remote baseline drift conflicts with the approved intent, stop and resolve it without overwriting unrelated edits.

Read back every affected issue and both directions of its native relationships, following all pages. Compare exact intended title/body/labels and graph scope; preserve unrelated baseline fields and edges. Record structured mismatches, inaccessible issues and command failures. Only complete remote agreement is successful; partial effects remain in the journal for convergent recovery.

Write `issues.jsonl` records `{id,number,url,reused}` and retain verified field/edge mappings, remote readback, review, approval, snapshot and findings. Hand the verified backlog and dependencies to sprint-planning. Issue creation alone does not authorize implementation or establish completion.
