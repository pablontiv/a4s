---
tipo: spec
---
# Cost analyzer delivery efficiency design

## Goal

Add an opt-in delivery-efficiency view to `skills/cost-analyzer` that measures the native cost required to produce durable production-code changes. It must preserve every existing S1–S4 budget and topology report unchanged, and must never infer topology efficiency from sessions, aggregate tokens, or raw commit count alone.

## Evidence and decision

The existing scenario table divides native cost and all token classes by session count. This is not an efficiency measure: cache-read tokens dominate observed volume, model pricing differs by cohort, and some session files have no native cost. The observed period 2026-09-17 through 2026-09-23 contained 118 S1 files without native cost, while S2 cost was concentrated in `gpt-5.6-sol` and `grok-4.5`.

DORA recommends measuring delivery throughput together with instability and applying metrics within an application or service, not across disparate work. SPACE identifies commits as activity rather than a standalone productivity outcome. The view therefore reports a primary cost-per-durable-change indicator with quality, flow, and attribution guardrails; it does not create a composite score.

## Boundaries

- Session selection remains exclusively by JSONL file mtime; no internal session timestamp may select a report range.
- Git commit metadata is used only to evaluate outcomes for sessions selected by mtime.
- The existing `quad.py` classification signals and their legacy regression behavior remain unchanged.
- Existing `report.py` budget, topology, harness, outcomes, attribution, and extension views remain behaviorally compatible.
- The feature is read-only: `git` and `gh` calls must not mutate repositories, remotes, branches, or credentials.
- A missing default-branch ref, a shallow history, an unavailable worktree, or an ambiguous commit attribution produces explicit unknown/withheld counts; it never silently treats a commit as durable.

## Delivery-efficiency model

The new CLI view is opt-in: `python3 assets/report.py --since YYYY-MM-DD --until YYYY-MM-DD --view delivery-efficiency`.

A candidate is a unique SHA observed through an existing selected session's `cwd` and session time window. A candidate is a production-code change only when its changed paths include at least one `code` path according to the existing path categorizer and include no code-exclusion-only change. Documentation, tests, fixtures, lockfiles, and configuration-only commits do not qualify.

A candidate is mature only when its commit timestamp is at least seven calendar days before the report evaluation date. Maturity is independent of mtime session selection. A mature candidate is durable only when all conditions hold:

1. It is reachable from the repository's resolved default branch (`refs/remotes/origin/HEAD`, then local `main`, then local `master`);
2. the repository has sufficient history to evaluate it; and
3. no explicit `This reverts commit <SHA>` record is found on the resolved default branch.

Candidates younger than seven days are reported as `immature`, not as failed or zero-value. Candidates that cannot be evaluated are `unknown`, not durable.

The primary indicator is **Cost per Durable Production Change (CDPC)**:

```
CDPC = native cost attributable to qualifying sessions / unique durable production SHAs
```

Lower CDPC is better only within the same repository/value stream and comparable task class.

## Attribution and scenario handling

A SHA can be observed by sessions in multiple S1–S4 scenarios. The view must not place that SHA in every scenario denominator. Each SHA is assigned one of these cohorts:

- `S1`, `S2`, `S3`, or `S4` when every observing session has that same scenario;
- `mixed` when observing sessions span scenarios; or
- `unknown` when session-to-commit evidence cannot be evaluated.

Only homogeneous cohorts receive a scenario CDPC. `mixed` is reported separately and excluded from scenario ranking. The numerator includes only sessions in the same cohort that observe at least one durable production SHA; a session that observes multiple qualifying SHAs splits its native cost evenly among them, preventing its complete cost from being charged repeatedly.

Every result reports attribution coverage: attributable native cost divided by native cost of all selected Pi sessions in that repository/cohort. A scenario is displayed but is not ranked when coverage is below 80% or its durable-change denominator is zero.

## Guardrails

The view reports, next to CDPC:

- durable production changes;
- immature and unknown candidates;
- explicit-revert rate among mature candidates;
- median time from the first observing session start to the qualifying commit timestamp; and
- attribution coverage.

It renders no aggregate cross-repository winner. Per-repository rows are the canonical comparison unit; an optional scenario summary is descriptive and explicitly marked as non-comparable when it spans repositories.

## Output contract

The report has a clear heading containing its mtime session range and its outcome evaluation date. Per-repository rows contain:

| Repository | Cohort | Native cost attributed | Durable changes | CDPC | Reverts | Median time | Coverage | Status |
|---|---|---:|---:|---:|---:|---:|---:|---|

`Status` is one of `ranked`, `insufficient-coverage`, `no-durable-changes`, or `unknown-history`. The detailed section lists candidate counts by `durable`, `immature`, `reverted`, `excluded-noncode`, `mixed`, and `unknown`.

## Testing

Tests must precede implementation and use disposable local Git repositories. They must prove:

1. Code-bearing commits on the resolved default branch mature after seven days and become durable.
2. Documentation-only and test-only commits are excluded.
3. A commit inside the seven-day horizon is immature and cannot enter CDPC.
4. An explicit revert changes a mature code commit from durable to reverted.
5. A SHA observed across scenarios becomes `mixed` and cannot appear in an S1–S4 denominator.
6. A session observing two durable SHAs splits its native cost instead of double-counting it.
7. Missing default-branch/history evidence reports unknown and never durable.
8. Existing S1–S4 and harness views retain their current output contracts.

## Acceptance criteria

- `--view delivery-efficiency` is read-only and uses the existing mtime-selected session set.
- The view exposes CDPC plus durability, quality, flow, and coverage guardrails; it has no single composite score.
- Cross-scenario SHA duplication cannot inflate any S1–S4 durable-change denominator.
- Cross-repository aggregation never claims a topology winner.
- Existing reports continue to pass their regression tests unchanged.
- Documentation states that commits are an activity-derived delivery proxy, not a direct measure of individual productivity or business value.
