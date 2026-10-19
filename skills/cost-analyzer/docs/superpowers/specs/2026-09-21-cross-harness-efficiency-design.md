# Cross-Harness Efficiency and Topology Design

**Status:** proposed
**Date:** 2026-09-21
**Scope:** `~/.agents/skills/cost-analyzer/`

## Intent

Compare work-efficiency across Pi, Claude Code, and Codex without inventing
USD for harnesses whose session logs do not expose native cost. Preserve Pi's
native USD report as a harness-specific cost view, but use tokens and Git
output for the universal comparison. Classify S1–S4 as an independent topology
dimension for all three harnesses.

## Canonical record additions

`SessionRecord` remains the sole session representation. It gains:

```python
observed_topology: Literal['S1', 'S2', 'S3', 'S4', 'unknown']
topology_confidence: Literal['direct', 'inferred', 'unknown']
commit_coverage: Literal['observable', 'not-a-repo', 'no-timestamps', 'error']
```

`harness` remains `pi | claude | codex`. `pi_extension` remains Pi-only. No
view identifies a harness from an internal `originator` string: Codex records
can say `originator: Claude Code` despite being Codex sessions.

## Universal efficiency metric

### Resource denominator

```text
total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
```

Every report retains all four token fields. `total_tokens` is a normalized
resource measure, not a price estimate. No model-price table is used.

### Work-output numerator

```text
unique_commit_shas(cohort)
```

A commit is an observable unit of work, not proof of user value. It is found
only when the session has a valid Git `cwd` and time window; SHAs are deduped
inside each reported cohort, such as `codex × S2 × September`.

The universal ranking is:

```text
tokens_per_unique_sha = total_tokens / unique_commit_shas
```

Lower is more token-efficient. Cohorts with zero unique SHAs are displayed but
not ranked. Reports also display `commits/session` and commit-coverage so an
unobservable harness cannot appear efficient merely through missing evidence.

### Closure signals

Merged PRs and closed beads are retained as optional, higher-confidence closure
signals. They never gate the universal ranking because many valid sessions have
neither. They are presented separately and never summed with commits into a
fabricated value score.

### Native-cost view

`cost_native_usd` remains a valid Pi-only metric. Cross-harness dollar rankings
are forbidden until Claude/Codex expose a native cost or the user explicitly
approves a pricing-estimation model. Missing cost renders as `—`, never `$0`.

## Cross-harness topology

Topology describes observed work distribution, independently of the client:

| Topology | Definition |
|---|---|
| S1 | One observed session, no coordination or delegation evidence. |
| S2 | In-harness delegation, no external coordinator evidence. |
| S3 | External coordinator/worker evidence, no in-harness delegation. |
| S4 | Both external coordination and in-harness delegation evidence. |
| unknown | Source is insufficient or malformed; never silently forced to S1. |

### Delegation evidence (direct)

| Harness | Signals |
|---|---|
| Pi | `subagent-notify`, `subagent_run`, `subagent` |
| Claude Code | `Agent` tool calls |
| Codex | `spawn_agent`, `followup_task` |

Any of these gives direct delegation evidence, yielding S2 if coordination is
absent or S4 if it is present.

### Coordination evidence

External coordination is direct when the source records Intercom, Firstmate,
Herdr, or a parent/worker relationship. Existing Pi signals and validated
worktree patterns remain an *inferred* coordination surface for backward
compatibility. Harness-specific pattern matchers must identify their evidence
in `topology_evidence`; no classifier may infer an S3/S4 solely from temporal
proximity.

A record with parsed content and absence of all listed evidence is S1 with
`inferred` confidence. A malformed or unparseable source is `unknown` with
`unknown` confidence.

## Views

All views consume one loaded/enriched `list[SessionRecord]`; none reads JSONL
independently.

1. **Harness:** Pi / Claude / Codex. Displays sessions, native USD coverage,
   token components, unique SHAs, commits/session, tokens/SHA, Git coverage,
   PRs and beads. It ranks only tokens/SHA.
2. **Topology:** S1–S4/unknown across every harness and a cross-tab
   `harness × topology` table. It ranks only tokens/SHA.
3. **Pi extension:** `pi-subagents-j0k3r`, `pi-subagents`, and
   `mixed/unknown`, crossed with topology. It remains observational because it
   uses the verified cutover cohort.
4. **Native Pi cost:** Existing USD/outcome and attribution reports. They
   remain explicitly Pi-only.

Every view prints its cohort definition, number of sessions, token and Git
coverage, and a caveat that commit volume is work output rather than value.

## Enrichment and error handling

Git enrichment is opt-in (`--with-commits`) and immutable: failure for one
session records a coverage state and does not abort the report. PR/bead lookups
remain opt-in. A parser error emits `unknown` rather than dropping the session
from the denominator.

## Compatibility and migration

`quad.py`, `outcomes.py`, `extensions.py`, and `attribution.py` become
compatibility wrappers over the canonical loader and views. Their flags and
legacy output names remain supported during the migration, but parsing and
classification live only in the canonical modules. Tests must demonstrate that
legacy Pi fixtures preserve their S1–S4 outcome after the move.

## Acceptance criteria

- Pi, Claude Code, and Codex appear in harness and topology reports.
- `tokens/SHA` is available for any cohort with Git-observable commits; missing
  commits or tokens cannot produce a winner.
- USD is never calculated, estimated, or ranked for Claude/Codex without
  native evidence.
- Claude `Agent` and Codex `spawn_agent`/`followup_task` classify delegation.
- S3/S4 require recorded coordination evidence; unparseable sources are
  `unknown`.
- Legacy Pi S1–S4 and j0k3r cutover tests remain green.
