---
tipo: plan
---
# Roadmap canonical Bead evidence implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove new Roadmap execution-report files and make each Bead the complete canonical operational record through fields, comments, guarded notes, and provenance.

**Architecture:** Roadmap remains a Markdown-only skill. `contracts.md` defines the Bead evidence model; `loop.md` writes bounded role comments, typed provenance, and atomic pass/fail notes; `doctor.md` and `tree.md` read those surfaces explicitly; README owns the six fresh-agent pressure scenarios. Historical reports and governing documents remain preserved.

**Tech Stack:** Agent Skills Markdown, Beads 1.3.0 CLI, Rootline-governed ADR/spec/plan Markdown, Git, Superpowers fresh-agent pressure tests.

**Spec:** `.workspace/docs/specs/2026-09-25-roadmap-canonical-bead-evidence-design.md`

## Global constraints

- Bead `a4s-vb0` owns this delivery.
- ADR 0050 is the accepted authority for new Roadmap evidence.
- Preserve ADR 0033's `--if-assignee`, `--if-status in_progress`, exit-13, and `claim_lost` semantics.
- Preserve ADR 0043's bounded fresh roles, controller-only delegation, and no recursive delegation.
- Preserve ADR 0044's Beads authority and ADR 0048's Markdown-only skill and pressure-test verification.
- Add no parser, adapter, runtime, daemon, schema, unit test, integration test, E2E test, or HTTP dependency.
- Do not edit, migrate, or delete historical files under `reports/` or ignored `.superpowers/roadmap/reports/`.
- New executions create no role or final execution report files.
- Comments contain bounded summaries, never logs or transcript bodies.
- Ambiguous comment writes are never retried because Beads 1.3.0 comments have no idempotency key.
- Pass and fail lifecycle transitions remain guarded single `bd update` mutations.
- Provenance records only existing external references and finalization fails closed if a required binding cannot be confirmed.
- Keep the readiness semantics delivered by `6eb5985` unchanged.
- Update `skills/roadmap/SKILL.md` `metadata.updated` in the same commit as the behavioral change.
- Run `bd heartbeat a4s-vb0` before and after each implementation, review, and delivery stage.

## Review focus

- A comment write succeeds but the later guarded lifecycle update loses ownership: preserve the truthful comment, write no PASS, and report `claim_lost`.
- A comment response is ambiguous: do not retry and risk a duplicate comment.
- Optional external references are absent: skip only absent bindings; never fabricate SHA, PR, CI, branch, or transcript values.
- Historical report files still exist: preserve them while forbidding new report creation.
- A blocking normal or security review remains unresolved after bounded fix/re-review: record the failure canonically, move to `blocked` with guards, and stop.

---

### Task 1: Replace the execution evidence contract

**Files:**
- Modify: `skills/roadmap/references/contracts.md`
- Modify: `skills/roadmap/references/loop.md`

**Interfaces:**
- Consumes: Bead fields, `bd comments add`, `bd provenance record`, guarded `bd update`, effective `.workspace/config.yaml`.
- Produces: `ROADMAP_HANDOFF v1` comments and `ROADMAP_RESULT v1` notes; no report files.

- [ ] **Step 1: Re-run the mechanical RED before editing**

Run:

```bash
rg -n -S 'roadmap/reports|EVIDENCE_REF|PASS evidence=|repository-contained Markdown (evidence )?report' skills/roadmap
```

Expected: FAIL oracle — matches in `references/contracts.md` and `references/loop.md` prove the obsolete report-file contract still exists.

Run:

```bash
rg -n -S 'bd comments|include-comments|bd provenance' skills/roadmap
```

Expected: FAIL oracle — no canonical comment/provenance contract is present.

- [ ] **Step 2: Persist the observed RED in the Bead, not a report file**

Create a temporary file outside the repository containing:

```text
ROADMAP_HANDOFF v1
role=task-reviewer
verdict=fail
candidate_sha=6eb598566e6133360002a6d22a8d090d9c7a6ddd

Summary: RED baseline for canonical Bead evidence.
Findings:
- normal close used role and final report files;
- blocking review had no Bead-resident finding;
- Doctor did not read comments;
- external bindings did not use provenance;
- duplicate-report pressure was accepted;
- claim_lost behavior passed.
```

Append it once:

```bash
bd comments add a4s-vb0 --file "$TEMP_HANDOFF" --json
```

Capture the returned comment ID. On failed or ambiguous response, do not retry; stop implementation.

- [ ] **Step 3: Rewrite `contracts.md` evidence authority**

Replace the report-file paragraph with a concise contract that states:

```text
The Bead is the complete canonical operational record. Role handoffs and review findings are bounded comments. Final pass/fail and gate outcomes are appended to notes by the guarded lifecycle update. External Git, PR, CI, branch, work and transcript references use Beads provenance. Logs and transcript bodies remain with their owning provider. Roadmap creates no execution report files.
```

Require explicit comment reads for reconstruction, retain the existing description/design/acceptance field assignments, and state that Roadmap never deletes, prunes, or purges canonical execution Beads.

- [ ] **Step 4: Replace role report files with comment handoffs in `loop.md`**

Remove:

```text
Role reports are written per file at `.superpowers/roadmap/reports/<bead>-<role>.md`.
```

Require one comment per bounded role pass with this exact shape:

```text
ROADMAP_HANDOFF v1
role=<implementer|task-reviewer|security-reviewer|epic-final-reviewer>
verdict=<pass|fail|blocked>
candidate_sha=<sha|none>

Summary: <bounded result>
Findings:
- <finding or none>
```

Use:

```bash
bd comments add "$BEAD_ID" --file "$TEMP_HANDOFF" --json
```

State explicitly: remove the temporary file after a confirmed write; never retry an ambiguous comment response; an unconfirmed handoff is stopping condition 7.

- [ ] **Step 5: Add typed external provenance**

Add exact optional bindings after each value becomes known:

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

Require the `Bead:` Git trailer as a backlink, not a substitute. Skip absent optional values; stop before finalization on a failed or ambiguous required provenance write.

- [ ] **Step 6: Replace path-only PASS with guarded structured pass**

Remove `$EVIDENCE_REF` and the repository report creation. Define:

```bash
ROADMAP_RESULT=$(cat <<EOF
ROADMAP_RESULT v1
verdict=pass
candidate_sha=$CANDIDATE_SHA
acceptance=pass
invariants=pass
review=pass
security=$SECURITY_RESULT
security_paths=$SECURITY_PATHS
workspace_checks=pass
delivery=$DELIVERY_RESULT
post_checks=$POST_CHECKS_RESULT
EOF
)

bd update "$BEAD_ID" --status closed \
  --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "$ROADMAP_RESULT" --json
```

Keep the existing exit-13 rule verbatim: no retry, force, fallback PASS, or post-failure reclassification; report `claim_lost` and stop.

- [ ] **Step 7: Specify the blocking-review path**

After bounded fix/re-review is exhausted, require the failed handoff comment first, capture `$COMMENT_ID`, then run:

```bash
ROADMAP_RESULT=$(cat <<EOF
ROADMAP_RESULT v1
verdict=fail
gate=review
comment_id=$COMMENT_ID
candidate_sha=$CANDIDATE_SHA
EOF
)

bd update "$BEAD_ID" --status blocked \
  --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "$ROADMAP_RESULT" --json
```

A stale guard preserves the truthful comment, writes no PASS, reports `claim_lost`, and stops.

- [ ] **Step 8: Run focused GREEN checks and commit**

Run:

```bash
! rg 'roadmap/reports|EVIDENCE_REF|PASS evidence=|repository-contained Markdown (evidence )?report' \
  skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
rg -n 'bd comments|append-notes|bd provenance|ROADMAP_HANDOFF v1|ROADMAP_RESULT v1|claim_lost' \
  skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
git diff --check
```

Expected: first command exits 0 with no matches; second shows every native Beads surface and both record formats; diff check is silent.

Commit:

```bash
git add skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
git commit -m "feat(roadmap): keep execution evidence in Beads" -m "Bead: a4s-vb0"
```

### Task 2: Teach Roadmap to reconstruct canonical Bead evidence

**Files:**
- Modify: `skills/roadmap/references/doctor.md`
- Modify: `skills/roadmap/references/tree.md`
- Modify: `skills/roadmap/README.md`
- Modify: `skills/roadmap/SKILL.md`

**Interfaces:**
- Consumes: comment bodies from `bd show --include-comments --json` and typed rows from `bd provenance log`.
- Produces: comment-aware Doctor/tree diagnosis and the six evidence pressure scenarios.

- [ ] **Step 1: Run the comment-reconstruction RED with a fresh agent**

Dispatch one fresh read-only agent with only this scenario and the current Roadmap files:

```text
A closed task's implementer, reviewer, and security handoffs exist only as Bead comments. Reconstruct its execution history using the commands Roadmap requires. Do not mutate anything.
```

Expected RED: the agent uses ordinary `bd show` and cannot guarantee comment bodies because current Doctor/tree omit `--include-comments` and `bd comments`.

Append the bounded verdict to `a4s-vb0` as a comment; do not create a report file.

- [ ] **Step 2: Update Doctor's read and evidence contracts**

Change Doctor's affected-record reads and post-apply verification to:

```bash
bd show "$ID" --include-comments --json
bd provenance log "$ID" --json
```

Allow `bd comments "$ID" --json` when only the thread is required. Name comments, notes, provenance, commits, and providers as distinct evidence surfaces. Add findings for:

- missing required role handoff;
- failed review with no blocked/failure result;
- pass result with missing required provenance;
- comment/provenance disagreement with notes; and
- new execution report files cited by a post-ADR-0050 task.

Preserve historical report references for tasks completed before ADR 0050.

- [ ] **Step 3: Bound tree's comment/provenance reads**

Keep ordinary tree rendering cheap. Require explicit comment/provenance reads only when needed to explain:

```text
candidate completeness, stale operational state, failed gate, closure inconsistency, stale satisfied prerequisite, or a Doctor finding
```

Do not require every tree render to load every historical comment.

- [ ] **Step 4: Add the six evidence scenarios to README**

Under Verification, add these fresh-agent scenarios and required outcomes:

```text
1. normal close: comments + provenance + atomic structured notes; no report file;
2. claim loss: no close, no PASS, no retry/force, claim_lost;
3. blocking review: failed comment + guarded blocked result; no PASS;
4. reconstruction: explicit comment and provenance reads;
5. external evidence: typed SHA/branch/PR/CI/transcript bindings without copied logs;
6. file pressure: refuse role/final report documents and use Beads.
```

Require all agents to agree on storage surface, lifecycle result, retry behavior, and created files. Disagreement is failure.

Add the two mechanical checks from the spec. Keep the explicit prohibition on a Roadmap test harness.

- [ ] **Step 5: Update the skill metadata date**

Set in `skills/roadmap/SKILL.md`:

```yaml
metadata:
  author: pablontiv
  updated: "2026-09-25"
```

If the date already matches, leave the value unchanged; the substantive same-day edit satisfies repository policy.

- [ ] **Step 6: Run focused GREEN checks and commit**

Run:

```bash
rg -n 'include-comments|bd comments|bd provenance|missing required role handoff|ADR 0050' \
  skills/roadmap/references/doctor.md skills/roadmap/references/tree.md
rg -n 'normal close|claim loss|blocking review|reconstruction|external evidence|file pressure' \
  skills/roadmap/README.md
! rg 'roadmap/reports|EVIDENCE_REF|PASS evidence=|repository-contained Markdown (evidence )?report' \
  skills/roadmap
git diff --check
```

Commit:

```bash
git add skills/roadmap
git commit -m "docs(roadmap): verify canonical Bead evidence" -m "Bead: a4s-vb0"
```

### Task 3: Synchronize governance and prove semantic GREEN

**Files:**
- Reference without editing: `.workspace/docs/adr/0050-hacer-del-bead-el-registro-canonico-de-evidencia-roadmap.md`
- Reference without editing: `.workspace/docs/specs/2026-09-25-roadmap-canonical-bead-evidence-design.md`
- Modify only for corrections found during plan review: `.workspace/docs/plans/2026-09-25-roadmap-canonical-bead-evidence.md`
- No new report or test files

**Interfaces:**
- Consumes: accepted ADR 0050, approved spec, Tasks 1–2 candidate SHA.
- Produces: six GREEN pressure verdicts stored as Bead comments and a review-ready branch.

- [ ] **Step 1: Verify governance before pressure runs**

Run:

```bash
rootline validate .workspace/docs/adr/0050-hacer-del-bead-el-registro-canonico-de-evidencia-roadmap.md -o json
rootline validate .workspace/docs/specs/2026-09-25-roadmap-canonical-bead-evidence-design.md -o json
rootline validate .workspace/docs/plans/2026-09-25-roadmap-canonical-bead-evidence.md -o json
```

Expected: all valid, zero errors and warnings.

- [ ] **Step 2: Run the six GREEN scenarios with fresh agents**

Dispatch one fresh read-only agent per README evidence scenario. Each reads only `SKILL.md`, `contracts.md`, and the routed reference. It must return PASS/FAIL plus exact commands, storage surfaces, lifecycle state, retry behavior, and files created.

Store each bounded verdict as one `ROADMAP_HANDOFF v1` comment on `a4s-vb0` with `role=task-reviewer`. Do not write a repository report. If any scenario fails, amend only the implicated Markdown and rerun only that scenario with another fresh agent.

- [ ] **Step 3: Verify no new report artifacts**

Record the baseline counts, run the GREEN scenarios, then verify counts did not increase:

```bash
find .superpowers/roadmap/reports -maxdepth 1 -type f 2>/dev/null | wc -l
git ls-files 'reports/*.md' | wc -l
git status --short
```

Historical counts may be nonzero. Success means no new files and no unexpected worktree changes.

- [ ] **Step 4: Run the full validation suite**

Run:

```bash
test/ci-local.sh
rootline validate --all .workspace/docs/adr -o json
rootline validate --all .workspace/docs/specs -o json
rootline validate --all .workspace/docs/plans -o json
git diff --check
```

Also run:

```bash
! rg 'roadmap/reports|EVIDENCE_REF|PASS evidence=|repository-contained Markdown (evidence )?report' skills/roadmap
rg -n 'include-comments|bd comments' skills/roadmap/references/doctor.md skills/roadmap/references/tree.md
rg -n 'append-notes|ROADMAP_HANDOFF v1|ROADMAP_RESULT v1' skills/roadmap/references/loop.md
rg -n 'bd provenance' skills/roadmap/references/contracts.md skills/roadmap/references/doctor.md skills/roadmap/references/tree.md skills/roadmap/references/loop.md
```

Expected: CI 19/19, Rootline valid, no obsolete report contract, all canonical Beads surfaces present.

- [ ] **Step 5: Request independent final review**

Dispatch a fresh `superpowers-final-reviewer` with:

```text
Review merge-base..HEAD against ADR 0050, the approved spec, and this plan. Focus on atomic claim-loss behavior, ambiguous comment writes, failed-review blocking, bounded comment reads, provenance completeness, historical-report preservation, and accidental readiness changes.
```

Fix every valid finding with Markdown-only edits, rerun affected pressure scenarios, and request one scoped re-review on the new SHA.

- [ ] **Step 6: Commit any pressure/review fixes**

If files changed:

```bash
git add skills/roadmap .workspace/docs/adr .workspace/docs/specs .workspace/docs/plans
git commit -m "fix(roadmap): close canonical evidence gaps" -m "Bead: a4s-vb0"
```

If nothing changed, create no empty commit.

## Final delivery

1. Record the candidate SHA in Beads provenance with `kind=commit`, `ref-kind=git-sha`, `source=roadmap`.
2. Push `feat/a4s-vb0-roadmap-canonical-evidence` and open a PR against `pablontiv/a4s` `main` using the repository delivery policy.
3. Record branch and PR bindings in Beads provenance.
4. Apply the `ci-billing` override only if every remote job has zero steps and the configured compensating controls pass.
5. Merge only when the exact candidate SHA satisfies `.workspace/config.yaml` and ADR 0047, using `--match-head-commit`.
6. Pull `origin/main`, verify local main equals remote main, and verify a clean tree.
7. Append the final `ROADMAP_RESULT v1` to Bead notes and close `a4s-vb0` with `--if-assignee` and `--if-status in_progress`.
8. Preserve the worktree until the operator chooses cleanup; never delete it automatically.
