---
name: repository-discovery
description: Diagnose a repository through independent lenses, validate and consolidate evidence, and hand reviewed work units to backlog-breakdown for operator-approved publication.
---
# Discovery through independent lenses

Use the common [method](METHOD.md), [execution contract](CONTRACT.md), and [lens modules](lenses/). This is a tool-free procedure, not a scheduler integration. Read the adopted repository's AGENTS.md and CONTRIBUTING.md. Discovery diagnoses; it neither changes implementation nor publishes issues without the separate review and approval boundary.

## 1. Establish the audit

Detect the repository's default branch rather than assuming its name. Record repository identity, audited branch and exact commit. Use a read-only snapshot of that commit, preserving the caller's branch and working tree. Choose a writable evidence directory outside the snapshot and supply any previous lens results. State whether the audit is interactive or unattended. No live target is implicit permission to access it.

List the requested lenses explicitly. Assign exactly one independent auditor per requested lens, with at most eight auditors running concurrently. If delegation is unavailable, perform explicitly separated lens passes and disclose that independence limitation; an independent validation reviewer is still required before backlog publication. Each assignment includes:

1. `CONTRACT.md` and the corresponding `lenses/<lens>-*.md` module.
2. Snapshot path, detected default branch, and exact audited commit.
3. Evidence directory and any `prior-<lens>.jsonl`.
4. Autonomous read-only audit scope and required `findings-<lens>.jsonl` output.

Require a result for every requested lens. Applicable lenses with zero findings write empty findings files; an inapplicable lens records its reason separately instead of fabricating a finding. Record inventory, assumptions, unevaluated units and missing resources. A missing file or failed audit is not a clean bill of health.

## 2. Check findings and temporal history

Each findings line has `id`, `lens`, `unit`, `location`, `criterion`, `severity`, `evidence`, `reproduce`, `status`, and `verification`, as defined in [CONTRACT.md](CONTRACT.md). Lens identity matches its filename; IDs remain stable for the same lens/location/criterion. Check JSON syntax, required fields, allowed values and unique IDs before proceeding. Fix malformed results without silently discarding findings.

Compare against saved results of the same lens. Write `temporal-<lens>.jsonl` with `{id,lens,temporal}`: `new`, `persistent`, `resolved`, or `regression`. A previously resolved finding that reappears is a regression. A missing finding is resolved only with evidence that its prior scope was evaluated and its cause no longer applies; missing coverage stays unevaluated. With no history, findings are new. Preserve current findings, temporal history and audit metadata for the next diagnosis.

## 3. Independent validation and consolidation

Have a validator independent of the finding's author examine every current finding and write `verdicts.jsonl`: `{finding,verdict,basis,live}`. Verdict is `confirmed` or `discarded`; basis cites evidence and distinguishes execution from code reading. Confirmation of a suspected risk is not a claim of successful reproduction. Missing validation blocks consolidation of that finding.

Live validation requires explicit operator approval of the exact target, scope and operations, remains read-only, and records `live: true`. Use only the approved target. Consult the pve-api skill before relevant Proxmox operations. Findings needing unavailable resources remain explicitly unevaluated or suspected; do not turn lack of access into a discarded defect.

Consolidate confirmed findings into `units.jsonl` records `{id,title,body,classification,findings}`. Use stable kebab-case IDs derived from sorted finding IDs. Classification is `defect`, `improvement`, or `duplicate`; preserve original finding IDs. Every confirmed finding belongs to exactly one unit and no discarded finding is imported. Bodies contain `## Problem`, `## Change`, and `## Acceptance`, full evidence, complete scope, and targeted check commands so work can be executed independently. Group shared causes rather than generating duplicate issues; explain prerequisite relationships. A duplicate unit identifies its existing issue and is bound for identity reuse, not recreated.

## 4. Backlog handoff

Check lineage explicitly: all confirmed findings are accounted for exactly once, all IDs exist, and unit scope follows the evidence. Stage an absolute `breakdown-units.jsonl` with `{id,title,kind,labels,body,source,findings}`; use `kind: "feature"`, classification as a label, `source: "discovery"`, original finding IDs, and `<!-- discovery-unit: ID -->` in the body. Carry declared relationships and explicit revision intent using the [backlog-breakdown contract](../backlog-breakdown/SKILL.md). Duplicate units bind `revision.issue` to the existing issue with `fields: []` unless specific field revisions were prepared for review.

For nonempty output, hand the frozen units, source evidence, temporal history and validation to [backlog-breakdown](../backlog-breakdown/SKILL.md) for independent unit review, operator approval and idempotent publication. Diagnostic validation does not replace that publication review. With zero units, record `outcome: no-units`, save history and explain any unevaluated scope; create no issue. [Sprint-planning](../sprint-planning/SKILL.md) subsequently ranks and admits feature or PoC work; discovery itself does not start implementation.
