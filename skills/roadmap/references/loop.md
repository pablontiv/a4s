# Autonomous loop mode

Loop chains tasks automatically, executing exactly one topologically ready task at a time. Never execute multiple Beads concurrently, even when several tasks have no dependencies. Loop continues until an explicit stopping condition is met.

## 1. Resolve completion authority

Before any mutation, locate and read the effective `.workspace/config.yaml`, including the workspace, group, and repository layers it identifies and their declared precedence. Resolve required context, sync, isolation, development workflow, commits, acceptance checks, review, delivery, post-checks, monitoring, and cleanup controls.

A missing, inaccessible, or ambiguous required control is `unknown`. Required `unknown` or `failed` controls stop mutation and prevent delivery and closure. Do not infer a fallback from README, AGENTS, package scripts, or a standalone Definition-of-Done document.

## 1.1. Scope parameter (optional)

If a scope ID is provided (invoked as `loop <id>`):

1. **Validate the ID**: Run `bd show "<id>" --json`. If the ID does not exist, reject without mutation. If the ID exists but is not type `epic` or `task`, reject without mutation.

2. **Determine scope boundary**:
   - If `<id>` is an **epic**: the scope includes only the direct children of that epic (its immediate tasks). Root tasks and other epics are excluded.
   - If `<id>` is a **task**: the scope includes only that single task.

3. **Evaluate drift and stopping conditions within scope only**:
   - Stop condition 1 (no executable tasks remain): evaluated against executable tasks within the scope only.
   - Stop condition 2 (Doctor required, including readiness drift): apply the scope boundary in item 4.
   - All other stopping conditions apply globally regardless of scope.

4. **Scope boundary for Doctor findings**: a cycle, invalid or broken edge, incomplete candidate (contract gap), or readiness drift triggers stop condition 2 in a scoped loop only when it involves a scoped task or a `blocks` prerequisite of a scoped task (fail closed). Findings elsewhere in the backlog do not stop a scoped loop.

If no scope ID is provided, the loop operates over the entire backlog as usual.

## 2. Autonomous loop with stopping conditions

Loop is autonomous by default: chain tasks without asking until an explicit stopping condition applies.

### Stopping conditions (enumerated)

Loop stops and prints a final SUMMARY when any of the following is true:

1. **No executable tasks remain**: the frontier is empty; all non-epic Beads are closed or blocked on external dependencies.
2. **Doctor required**: a fresh tree read detects a cycle, invalid graph, incomplete candidate, or readiness drift.
3. **Unknown or failed control**: a required workspace control (sync, isolation, development workflow, delivery, post-checks, etc.) is missing, inaccessible, or ambiguous.
4. **Claim or lease lost**: the claim failed (race loss), lease expired between stages, or heartbeat failed; ownership no longer matches or status changed from `in_progress`.
5. **Gate failure**: a required check, review, or delivery gate failed for the current task or PR. This includes HIGH-severity security findings from a triggered security review (§3.1).
6. **Human gate applies**: the effective `.workspace/config.yaml` declares a human gate requirement that is met:
   - delivery-policy changes (delivery_mode, delivery_gate, delivery_overrides modified);
   - external effects outside the repository;
   - destructive operations (force-push, branch deletion, etc.);
   - ADR substitution required (replacing an accepted decision).
7. **Implementation error**: an implementation stage encounters an unrecoverable error outside task scope or violating contract invariants.

### Selecting and claiming a task

Run the complete tree recipe, limited to the scope boundary if a scope ID was provided. Stop for Doctor on a cycle, invalid graph, incomplete candidate, or readiness drift (condition 2); in a scoped loop apply the boundary in §1.1 item 4. Select exactly one complete task in the intersection of the topology frontier and provider-ready IDs within the scope boundary, ordered by current ownership, Beads priority, reverse-dependency impact, then ID. Exclude epics. If a scope ID was an epic, consider only its direct task children for selection.

Read the selected task's full contract. Claim only it:

```bash
bd update "$BEAD_ID" --claim --json
```

A failed claim is a race loss (condition 4). Refresh the tree read-only and report; do not overwrite an owner or immediately select another task. Re-read the Bead with `bd show "$BEAD_ID" --json` and verify both the exact expected assignee `$ACTOR` and `in_progress` status before implementation.

## 3. Execute bounded stages

The Roadmap controller alone delegates. Use a fresh Superpowers role appropriate to each bounded pass. No child delegates or creates another subagent. Keep reports bounded and return artifact paths or concise results, not accumulated transcripts.

**Role mapping**:
- **Implementer**: `superpowers-mechanical-implementer` (1–2 file changes); `superpowers-integration-worker` (multi-file changes).
- **Reviewer**: `superpowers-task-reviewer` for task review and security review (§3.1).
- **Epic final review**: `superpowers-final-reviewer`.

Role reports are written per file at `.superpowers/roadmap/reports/<bead>-<role>.md`.

Execute:

```text
read full Bead contract
→ bounded implementation
→ task review and bounded fix/re-review when required
→ selective security review (if triggered)
→ repository validation
→ configured delivery and post-checks
→ conditional finalization
```

### 3.1. Selective security review trigger

After implementation and task review pass, check the candidate diff for sensitive paths. Run `git diff --name-only <base>...HEAD` and evaluate each changed file:

- **Trigger if any path contains** (case-insensitive match of literal string): `secret`, `credentials`, `.env`, `auth`, or `crypto`.
- **Or trigger if** the task contract explicitly requests a security review.

If trigger applies:
1. Dispatch a fresh `superpowers-task-reviewer` on the PR head SHA with a security-focused brief (secrets exposure, credential handling, authentication and authorization logic, cryptography use), separate from the general task review.
2. Record the security review verdict and any findings in the evidence report (§4).
3. A HIGH-severity finding blocks task closure and autonomous merge (gate failure, stopping condition 5).

If trigger does not apply:
- Log in evidence: `security review: not triggered` followed by the comma-separated list of changed file paths evaluated.

Run this exact heartbeat command immediately before and after each bounded implementation, review, and delivery stage:

```bash
bd heartbeat "$BEAD_ID"
```

After every heartbeat and stage, re-read the Bead and verify assignee and `in_progress` still match. Heartbeat failure, changed assignee, changed status, or lease loss stops further mutation. Only an explicit Doctor proposal may reclaim a verified expired lease.

Preserve unrelated work and remain inside the selected contract. Passing unit tests is not sufficient: prove task acceptance, invariants, required reviews, every applicable effective-workspace control, configured delivery, and post-checks.

## 4. Record evidence and close conditionally

Write a repository-contained Markdown evidence report and set `$EVIDENCE_REF` to its repository-relative path. It must identify the Bead and candidate SHA and record acceptance results, preserved invariants, reviews, workspace controls, delivery, post-checks, and security review results (if applicable).

The evidence report must record:
- **Security review trigger**: whether the trigger applied (yes/no).
- **If not triggered**: the list of changed file paths evaluated.
- **If triggered**: the security review verdict (passed/failed), any findings, and their severity levels. A HIGH-severity finding must be explicitly noted as a gate failure that blocks closure and merge.

Close only when every required result is passed (or explicitly not applicable where the workspace contract permits), including any triggered security review, ownership still matches, and the Bead remains `in_progress`:

```bash
bd update "$BEAD_ID" --status closed \
  --if-assignee "$ACTOR" --if-status in_progress \
  --append-notes "PASS evidence=$EVIDENCE_REF" --json
```

Never retry exit 13, a stale conditional guard, or any ownership loss. Preserve the evidence, stop mutation, and report `claim_lost`. Failed or ambiguous effects retain the contract-required non-closed state.

### Commit trailers and delivery

Every commit produced by loop must carry the following trailer in its body:

```
Bead: <BEAD_ID>
```

When the effective `.workspace/config.yaml` declares autonomous delivery with overrides (e.g., `delivery_overrides.ci-billing`), also include:

```
Delivery-Override: <override-key>
```

The loop applies the delivery rule from the effective config literally. Read `delivery_gate` to determine whether the PR requires autonomous merge (when all gates pass) or human authorization. A human delivery gate requirement is a stopping condition (condition 6).

### Autonomous chaining

After a successful close, immediately re-read the Bead and the complete graph. Check for any stopping condition. If none applies, select the next topologically ready task in deterministic order and continue. Repeat until a stopping condition is met.

An epic is never claimed or implemented. Close an epic only after every child task is closed and fresh evidence proves the epic's own success criteria; append the repository-relative evidence path and preserve any required conditional safeguards.

## 5. Final summary

When the loop stops (any stopping condition), print a final SUMMARY before exiting:

```
╔════════════════════════════════════════════════════════════════╗
║                      LOOP SUMMARY                              ║
╠════════════════════════════════════════════════════════════════╣
║ Closed tasks:                                                  ║
║   <BEAD_ID>: <title> (PR: <url>, merge SHA: <sha>)             ║
║   evidence: <repository-relative-path>                         ║
║   ...                                                           ║
║ Reviews and findings:                                          ║
║   <brief summary of review results or issues>                  ║
║ Delivery gates applied:                                        ║
║   <gate-name>: <passed|failed|not-applicable>                  ║
║   ...                                                           ║
║ Stopping condition:                                            ║
║   <number>. <description>                                      ║
║ Next steps:                                                    ║
║   <recommendation based on stopping condition>                 ║
║ Cleanup offered (cleanup_policy):                              ║
║   worktree: <path>                                             ║
║   branch: <branch-name>                                        ║
╚════════════════════════════════════════════════════════════════╝
```

The summary must record:
- **Closed tasks**: each task ID, title, PR URL (if applicable), merge SHA (if merged), and repository-relative evidence path.
- **Reviews and findings**: concise summary of reviewer feedback and any HIGH-security findings or regressions.
- **Delivery gates applied**: each gate name and its result (passed, failed, or not applicable).
- **Stopping condition**: reference one of the 7 stopping conditions (section 2) by number and description.
- **Next steps**: a specific recommendation based on the stopping reason (e.g., "open Doctor for cycle detection", "authorize delivery-policy change", "retry after control becomes available").
- **Cleanup offered**: list worktree paths and branch names available for cleanup (never auto-delete; the operator chooses).
