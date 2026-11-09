# Diagnostic contract

Combine this contract with a [lens module](lenses/). The lens defines what is evaluated; this contract defines how to work and what to deliver.

## Objective

Diagnose the repository's default branch, detected from repository metadata rather than assumed to be main or master, through the assigned lens. Findings inform prioritization: evidence matters more than volume. Declare repository identity, audited branch and exact commit.

## Modes and definitions

- **Interactive:** an operator is present to read the summary. This is the default.
- **Unattended:** write results to an explicitly supplied absolute evidence directory; no runtime or scheduler is required.
- **Analysis unit:** defined by the lens.
- **Finding:** a unit or group of units violating a lens criterion, with evidence.
- **Verified:** reproduced by execution. **Suspected:** supported only by code reading or indirect evidence.

Before starting, establish whether the lens applies. For example, a persistence lens may not apply to a repository that stores no data. If inapplicable, record the reason as the sole lens result, not as a defect.

## Non-negotiable restrictions

- The repository is read-only: preserve its branch and working tree, without checkout or source changes. If necessary, export the default-branch commit to a temporary snapshot and audit that copy. Keep the snapshot immutable; run builds against a disposable working copy.
- Builds, fixtures, databases, end-to-end execution and temporary results belong only in a system or harness temporary directory, with effects contained there.
- Interactive repository writes are limited to Markdown/JSONL diagnostic reports explicitly requested by the operator. Unattended mode performs no repository writes; write `findings-<lens>.jsonl` to the supplied evidence directory.
- Work autonomously without diagnostic questions. Choose and record reasonable interpretations of ambiguity. Resource approval and confirmation of an interactive report destination are exceptions; ambiguity does not authorize access or consequential actions.

## External resources

Prefer test doubles or disposable local instances over external services and shared databases. Leave processes you did not start untouched. If a unit needs a real resource, record that limitation and continue evaluating the rest.

In interactive mode, consolidate resource requests at the end: identify exact resources, target, scope and what each would validate. Use only explicitly approved resources, then update findings. In unattended mode, record `not evaluated: requires <resource>` unless a prior explicit mandate covers the exact operation. Live checks remain read-only. Consult the pve-api skill for relevant Proxmox operations; any operational PoC outside this diagnosis needs separately approved scope and an evidence-backed PASS, FAIL, or INCONCLUSIVE verdict.

## Working method

- Partition by the lens's analysis unit and delegate when available, with no more than eight concurrent workers across the audit.
- After a unit times out, the only retry is to split it into smaller parts and execute each part once. A second failure is recorded as not evaluated.
- Prefer execution evidence to code reading, and identify the method used for each finding. Never present an unexecuted check as passing.
- Save each finding's complete detail in the evidence directory as work proceeds, so context loss does not erase evidence.

## Previous results

Look for prior results of the same lens in the repository's research convention for interactive work or the supplied `prior-<lens>.jsonl` for unattended work. Consolidate still-applicable findings, evidenced resolutions, new findings and regressions. Deliver a consolidated result rather than only a delta.

Keep temporal state separate in `temporal-<lens>.jsonl` with `id`, `lens`, and `temporal`: `new`, `persistent`, `resolved`, or `regression`. Without previous results, every finding is new. A prior resolved finding recurring is a regression. Absence without evaluated coverage and resolution evidence is not resolution; record that scope as not evaluated.

## Finding schema: `findings-<lens>.jsonl`

One JSON object per line:

- `id`: stable fingerprint of lens + location + criterion; the same cause keeps its ID across audits.
- `lens`: assigned lens, matching the filename.
- `unit`: analysis unit.
- `location`: file:line, or component if file locations do not apply.
- `criterion`: violated criterion.
- `severity`:
  - `critical`: data loss/exposure or unauthorized execution without special conditions.
  - `high`: the same under plausible conditions, or a failing primary function.
  - `medium`: bounded impact or an available workaround.
  - `low`: debt, inconsistency or theoretical risk.
- `evidence`: concrete observations with sources and execution/code-reading distinction.
- `reproduce`: reproducible steps, or the explicit limitation preventing reproduction.
- `status`: `verified` or `suspected`.
- `verification`: deterministic test, benchmark or fixture that would catch the finding in future.

Use unique IDs and nonempty required values. Applicable lenses with no findings write an empty findings file; record inapplicability, incomplete scope and failures in audit metadata, not fabricated findings. When using previous reports with other vocabulary, explicitly record the mapping to this schema and preserve original evidence and IDs.

## Deliverables

**Summary:** audited branch/commit, lens, counts by criterion and severity, critical/high findings, changes from the prior audit, unevaluated units, resource requests, and two to four new research directions distinct from this diagnosis. Each lens may require additional summary content.

**Detail:** inventory of evaluated units; schema-compliant findings grouped by criterion; index of affected functions or components (functions by default); assumptions and unevaluated units. Supply readable Markdown and JSONL with one finding per line. Each lens may add detail sections.

**Interactive:** show the summary. Persist detail in the repository only on operator request. Detect the research convention from AGENTS.md, CLAUDE.md, `.workspace/`, `docs/research/`, or `research/`; if none exists, propose a path and await confirmation.

**Unattended:** write lens findings, inventory and summary to the supplied evidence directory. Subsequent independent validation and consolidation retain `temporal-<lens>.jsonl`, `verdicts.jsonl`, `units.jsonl` and the eventual `issues.jsonl` mapping there or in an explicitly linked publication evidence directory. Preserve metadata sufficient to bind all artifacts to the audited commit and follow the [skill procedure](SKILL.md).
