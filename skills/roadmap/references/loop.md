# Sequential loop mode

Loop implements exactly one topologically ready task at a time. Never execute multiple Beads concurrently, even when several tasks have no dependencies.

## 1. Resolve completion authority

Before any mutation, locate and read the effective `.workspace/config.yaml`, including the workspace, group, and repository layers it identifies and their declared precedence. Resolve required context, sync, isolation, development workflow, commits, acceptance checks, review, delivery, post-checks, monitoring, and cleanup controls.

A missing, inaccessible, or ambiguous required control is `unknown`. Required `unknown` or `failed` controls stop mutation and prevent delivery and closure. Do not infer a fallback from README, AGENTS, package scripts, or a standalone Definition-of-Done document.

## 2. Select one task

Run the complete tree recipe. Stop for Doctor on a cycle, invalid graph, incomplete candidate, or readiness drift. Select exactly one complete task in the intersection of the topology frontier and provider-ready IDs, ordered by current ownership, Beads priority, reverse-dependency impact, then ID. Exclude epics.

Read the selected task's full contract. Claim only it:

```bash
bd update "$BEAD_ID" --claim --json
```

A failed claim is a race loss. Refresh the tree read-only and report; do not overwrite an owner or immediately select another task. Re-read the Bead with `bd show "$BEAD_ID" --json` and verify both the exact expected assignee `$ACTOR` and `in_progress` status before implementation.

## 3. Execute bounded stages

The Roadmap controller alone delegates. Use a fresh Superpowers implementer subagent and a fresh reviewer subagent appropriate to each bounded pass. No child delegates or creates another subagent. Keep reports bounded and return artifact paths or concise results, not accumulated transcripts.

Execute:

```text
read full Bead contract
→ bounded implementation
→ task review and bounded fix/re-review when required
→ repository validation
→ configured delivery and post-checks
→ conditional finalization
```

Run this exact heartbeat command immediately before and after each bounded implementation, review, and delivery stage:

```bash
bd heartbeat "$BEAD_ID"
```

After every heartbeat and stage, re-read the Bead and verify assignee and `in_progress` still match. Heartbeat failure, changed assignee, changed status, or lease loss stops further mutation. Only an explicit Doctor proposal may reclaim a verified expired lease.

Preserve unrelated work and remain inside the selected contract. Passing unit tests is not sufficient: prove task acceptance, invariants, required reviews, every applicable effective-workspace control, configured delivery, and post-checks.

## 4. Record evidence and close conditionally

Write a repository-contained Markdown evidence report and set `$EVIDENCE_REF` to its repository-relative path. It must identify the Bead and candidate SHA and record acceptance results, preserved invariants, reviews, workspace controls, delivery, and post-checks.

Close only when every required result is passed (or explicitly not applicable where the workspace contract permits), ownership still matches, and the Bead remains `in_progress`:

```bash
bd update "$BEAD_ID" --status closed \
  --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "PASS evidence=$EVIDENCE_REF" --json
```

Never retry exit 13, a stale conditional guard, or any ownership loss. Preserve the evidence, stop mutation, and report `claim_lost`. Failed or ambiguous effects retain the contract-required non-closed state.

After a successful close, re-read the Bead and the complete graph. Ask before selecting the next topologically ready task; approval to run loop is not standing approval for another task.

An epic is never claimed or implemented. Close an epic only after every child task is closed and fresh evidence proves the epic's own success criteria; append the repository-relative evidence path and preserve any required conditional safeguards.
