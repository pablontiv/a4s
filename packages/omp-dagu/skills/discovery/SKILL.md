---
name: discovery
description: Diagnose an adopted repository through independent lenses, validate and consolidate findings, and hand feature units to the backlog-breakdown backend.
---

# Discovery through independent lenses

Operate the `discover`, `validate`, and `consolidate` human tasks in the
`discovery` DAG. The common method is in [`METHOD.md`](METHOD.md), the execution
contract in [`CONTRACT.md`](CONTRACT.md), and the lenses in [`lenses/`](lenses/).

## Diagnosis

Read `out_dir`, `sha`, and `snapshot` from the `snapshot` step. The snapshot is
the read-only repository being audited. Write findings only in the out-dir.

Interpret `LENSES` as a comma-separated list. Launch exactly one subagent per
requested lens, with at most eight running together. Each assignment includes:

1. `CONTRACT.md` and the corresponding `lenses/<lens>-*.md` module.
2. The snapshot path, repository default branch, and audited `sha`.
3. The out-dir and, when available, `prior-<lens>.jsonl`.
4. The requirement to audit autonomously against the read-only snapshot and write
   `findings-<lens>.jsonl` in the out-dir.

Each subagent writes one JSON object per line with `id`, `lens`, `unit`,
`location`, `criterion`, `severity`, `evidence`, `reproduce`, `status`, and
`verification`. `lens` matches the assigned lens; `id` is a stable fingerprint
of lens, location, and criterion. An applicable lens with zero findings writes
an empty file.

Wait for every subagent and require a findings file for every requested lens
before completing `discover`. The deterministic DAG steps validate the JSONL
and compute `temporal-<lens>.jsonl` from saved lens history.

## Independent validation and consolidation

At `validate`, independently validate each current finding and write
`verdicts.jsonl`: `{finding,verdict,basis,live}`. The verdict is `confirmado` or
`descartado`. Live validation uses only the supplied `LIVE_TARGET`, is read-only,
and records `live=true`.

At `consolidate`, write `units.jsonl` with one self-contained work unit per line:
`{id,title,body,classification,findings}`. Use a stable kebab-case ID derived from
the sorted finding IDs. `classification` is `defecto`, `mejora`, or `duplicado`;
`findings` contains the original finding IDs. Each confirmed finding belongs to
exactly one unit. The issue body includes `## Problem`, `## Change`, and
`## Acceptance`, with enough detail to execute the work independently.

## Backlog-breakdown handoff

After the deterministic lineage check, `handoff` stages an absolute
`breakdown-units.jsonl` file with `{id,title,dag,labels,body,source,findings}`.
Every unit uses `dag: "feature"`, its classification as a label,
`source: "discovery"`, and its original finding IDs. The body retains a
`<!-- discovery-unit: ID -->` provenance marker.

For nonempty units, the DAG enqueues one `planning.yaml` backend run through
`dagu-feature-bundle`, passing `UNITS_FROM`, `SOURCE=discovery`, `PRIMARY`, and
the same `OMP_SESSION_ID`. It returns `BACKEND_RUN_ID`, also saved in
`breakdown-run-id` in the out-dir. With zero units it succeeds with
`outcome=no-units` and an empty backend run ID. Both outcomes save findings and
temporal history for the next diagnosis.
Continue with the `backlog-breakdown` skill in that backend run for independent
review, approval, and issue creation. `sprint-planning` subsequently ranks and
enqueues new feature or PoC work.
