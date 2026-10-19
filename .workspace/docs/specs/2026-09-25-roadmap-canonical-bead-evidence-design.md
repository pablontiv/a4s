---
tipo: spec
---
# Roadmap canonical Bead evidence design

## Goal

Make each Bead the canonical and complete operational record of one Roadmap task. Roadmap must stop creating new role reports under `.superpowers/roadmap/reports/` and final execution reports under `reports/`. Requirements remain in structured issue fields, handoffs and review findings become Bead comments, finalization becomes one bounded result in Bead notes, and external artifacts are bound through Beads provenance.

This design preserves Roadmap as a Markdown-only skill. It adds no parser, adapter, daemon, custom runtime, unit-test framework, or HTTP dependency.

## Problem

The current contract declares Beads as the durable backlog but splits one task across three stores:

1. task contract and lifecycle in Beads;
2. ignored per-role files under `.superpowers/roadmap/reports/`; and
3. tracked final Markdown reports under `reports/`, referenced by `PASS evidence=<path>`.

That duplication makes the Bead incomplete, leaves ignored handoffs unavailable to other checkouts, and requires consumers to follow and parse repository files to reconstruct one task. Fresh-agent pressure tests on main `6eb5985` passed only claim-loss behavior; normal closure, failed review recording, comment reconstruction, typed provenance, and refusal of duplicate report files failed.

## Governing decisions

This design preserves:

- ADR 0033's conditional finalization and `claim_lost` behavior;
- ADR 0043's bounded fresh implementer and reviewer roles, controller-only delegation, and no recursive delegation;
- ADR 0044's decision that Beads is the durable Roadmap backlog; and
- ADR 0048's Markdown-only Roadmap and fresh-agent pressure verification.

A successor ADR replaces only these clauses:

- ADR 0033's `PASS evidence=<ruta>` payload; and
- ADR 0043's report-by-file handoff.

Historical ADRs, specs, plans, and reports remain unchanged. The successor decision establishes precedence for new Roadmap executions.

## Authority boundary

| Concern | Canonical location |
| --- | --- |
| Context, expected result, scope, and initial state | Bead `description` |
| Invariants, interfaces, constraints, and sources of truth | Bead `design` |
| Binary completion criteria | Bead `acceptance_criteria` |
| Implementer, reviewer, security, and epic-review handoffs | Bead comments |
| Final pass/fail result and gate summary | Bead `notes` |
| Commit, PR, branch, CI work ID, and transcript references | Beads provenance |
| Code and full logs | Git, CI, or their owning external provider |
| Dependency order and hierarchy | Beads edges |
| ADRs, specs, and implementation plans | Rootline-governed Markdown |

Comments and notes contain bounded summaries, never copied logs or transcripts. Git and external providers retain the underlying artifacts.

## Comment protocol

Every completed bounded role pass appends exactly one Bead comment. The body uses a stable human-readable header and bounded Markdown:

```text
ROADMAP_HANDOFF v1
role=<implementer|task-reviewer|security-reviewer|epic-final-reviewer>
verdict=<pass|fail|blocked>
candidate_sha=<sha|none>

Summary: <bounded result>
Findings:
- <finding or none>
```

Roadmap writes it with the installed Beads CLI:

```bash
bd comments add "$BEAD_ID" --file "$TEMP_HANDOFF" --json
```

`$TEMP_HANDOFF` is an owned temporary file outside durable repository paths and is removed after a successful write. The stored comment object and its ID are retained in controller state for the current turn. A comment response that is failed or ambiguous is not retried because Beads 1.3.0 has no comment idempotency key; Roadmap stops with an implementation error rather than risk duplication.

A failed required review is recorded as a comment before lifecycle mutation. After any bounded fix/re-review allowed by the task is exhausted, Roadmap uses a guarded `bd update` to append a bounded `ROADMAP_RESULT` failure summary and move the task to `blocked`. It never writes `PASS` and never continues to another task.

## Final result and conditional lifecycle

A passing task appends this bounded shape to notes in the same conditional update that closes it:

```text
ROADMAP_RESULT v1
verdict=pass
candidate_sha=<sha>
acceptance=pass
invariants=pass
review=pass
security=<pass|not-triggered>
security_paths=<comma-separated paths evaluated>
workspace_checks=pass
delivery=<verified|not-applicable>
post_checks=<pass|not-applicable>
```

The exact command remains atomic with ownership guards:

```bash
bd update "$BEAD_ID" --status closed \
  --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "$ROADMAP_RESULT" --json
```

Exit 13, ownership loss, lease loss, or changed status writes nothing through this command. Roadmap never retries, forces, or writes a fallback PASS; it reports `claim_lost` and stops. This preserves the accepted core of ADR 0033.

For a failed gate, `$ROADMAP_RESULT` uses `verdict=fail`, names the gate and stored comment ID, and applies this guarded transition:

```bash
bd update "$BEAD_ID" --status blocked \
  --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "$ROADMAP_RESULT" --json
```

If that transition loses its guard, the already-recorded comment remains truthful evidence of the review observation, no PASS is written, and Roadmap reports `claim_lost`.

## External provenance

Roadmap records external bindings with idempotent `bd provenance record` commands after each binding becomes known:

```bash
bd provenance record --issue "$BEAD_ID" --kind commit --source roadmap \
  --ref "$CANDIDATE_SHA" --ref-kind git-sha --json
bd provenance record --issue "$BEAD_ID" --kind handoff --source roadmap \
  --ref "$BRANCH" --ref-kind branch --json
bd provenance record --issue "$BEAD_ID" --kind handoff --source roadmap \
  --ref "$PR_URL" --ref-kind pr --json
bd provenance record --issue "$BEAD_ID" --kind used --source roadmap \
  --ref "$CI_RUN_ID" --ref-kind work-id --json
bd provenance record --issue "$BEAD_ID" --kind used --source roadmap \
  --ref "$TRANSCRIPT_REF" --ref-kind transcript --json
```

Only existing references are recorded. Provenance failure or ambiguity blocks finalization because the Bead would otherwise be incomplete. Commit trailers such as `Bead: <id>` remain useful Git-side backlinks but do not replace Beads-side provenance.

## Durability and limits

Beads comment authors and actors are caller-attributed audit data, not cryptographic identity. Comments are not indexed by `bd search` or `bd query`, so reconstruction uses explicit comment reads. Roadmap never retries an ambiguous comment append and never treats the local events journal as durable evidence.

Comments, notes, and provenance are removed if their owning Bead is deleted, pruned, or purged. Roadmap therefore never deletes, prunes, or purges canonical execution Beads. Repository operations retain the established Beads backup and sync policy; this skill does not create a second archive to compensate for missing Beads durability.

## Read contract

Any Roadmap mode that validates execution history or reconstructs a task must read comments explicitly:

```bash
bd show "$ID" --include-comments --json
bd provenance log "$ID" --json
```

`bd comments "$ID" --json` may be used when only the thread is needed. Doctor treats comments, notes, provenance, commits, and provider records as distinct evidence surfaces. It does not infer a missing comment from a report file.

Bare tree rendering need not load every comment. It loads comments and provenance only when required to explain a candidate, stale operational state, failed gate, closure inconsistency, or Doctor finding.

## Artifact boundary

Roadmap may still create the ignored `.superpowers/roadmap/approved-plan.json` because it is a transient input required by `bd create --graph`. It must not create new files under:

```text
.superpowers/roadmap/reports/
reports/
```

Existing historical files in those locations are preserved. No migration, deletion, or rewriting is part of this change.

The final loop SUMMARY remains console output derived from Beads state and provenance. It reports IDs and external references without creating a summary document.

## Verification

Verification uses `writing-skills` RED-GREEN pressure scenarios, not a custom Roadmap test harness.

### RED baseline

The six scenarios already ran against main `6eb5985` with fresh agents:

1. normal close without report files — failed;
2. claim loss — passed;
3. blocking review recorded canonically — failed;
4. Doctor reconstruction from comments — failed;
5. typed external provenance — failed; and
6. pressure to create duplicate report documents — failed.

### GREEN scenarios

After the Markdown change, fresh agents rerun the same six scenarios. Success requires observable decisions, not exact prose:

- normal close uses comments, provenance, and atomic notes without report files;
- claim loss retains its current no-write/no-retry behavior;
- blocking review leaves canonical Bead evidence and no PASS;
- Doctor reads comments and provenance explicitly;
- SHA, PR, CI, and transcript references use typed provenance; and
- requests for duplicate reports are refused.

Two mechanical checks supplement, but never replace, pressure scenarios:

```bash
! rg 'roadmap/reports|EVIDENCE_REF|PASS evidence=|repository-contained Markdown (evidence )?report' skills/roadmap
rg 'include-comments|bd comments' skills/roadmap/references/doctor.md skills/roadmap/references/tree.md
rg 'append-notes|ROADMAP_HANDOFF v1|ROADMAP_RESULT v1' skills/roadmap/references/loop.md
rg 'bd provenance' skills/roadmap/references/contracts.md skills/roadmap/references/doctor.md skills/roadmap/references/tree.md skills/roadmap/references/loop.md
```

Existing checks remain mandatory: `test/ci-local.sh`, Rootline validation, `git diff --check`, and one fresh final review on the candidate SHA.

## Change surface

The implementation updates:

- `skills/roadmap/references/contracts.md` — canonical evidence contract;
- `skills/roadmap/references/loop.md` — comments, provenance, pass/fail notes, summary;
- `skills/roadmap/references/doctor.md` — comment/provenance reads and findings;
- `skills/roadmap/references/tree.md` — bounded comment/provenance reads when needed;
- `skills/roadmap/README.md` — six evidence pressure scenarios and mechanical checks;
- `skills/roadmap/SKILL.md` — substantive update date;
- a successor ADR — partial replacement of ADR 0033 and ADR 0043; and
- the implementation plan for the approved spec.

The historical `2026-09-24-roadmap-on-beads-design.md` remains unchanged.

## Success criteria

- One Bead contains the complete operational record of each new Roadmap task.
- New Roadmap executions create no role or final execution report Markdown files.
- Every role handoff is a bounded Bead comment.
- Pass finalization writes a structured result and closes in one guarded update.
- Failed reviews leave canonical evidence and never write PASS.
- Claim loss preserves the previously passing no-write/no-retry behavior.
- Doctor can reconstruct work from comments, notes, and provenance.
- External artifact bindings are typed and queryable through Beads provenance.
- The six GREEN pressure scenarios agree across fresh agents.
- No custom Roadmap runtime or test harness is introduced.
