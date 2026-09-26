# Autonomous loop mode

Loop chains tasks automatically, executing exactly one topologically ready task at a time. Never execute multiple Beads concurrently, even when several tasks have no dependencies. Loop continues until an explicit stopping condition is met.

## 1. Resolve completion authority

Before any mutation, locate and read the effective `.workspace/config.yaml`, including the workspace, group, and repository layers it identifies and their declared precedence. Resolve required context, sync, isolation, development workflow, commits, acceptance checks, review, delivery, post-checks, monitoring, and cleanup controls.

When a required control is missing, inaccessible, or ambiguous, classify it as `unknown` and immediately retain this controller state:

```text
control=<control name>
authority_field=<exact .workspace field>
missing_input=<single material value needed to resolve it>
```

Required `unknown` or `failed` controls stop mutation and prevent delivery and closure. Use the retained values in the final `CONTINUE` row; do not reconstruct them from README, AGENTS, package scripts, or a standalone Definition-of-Done document.

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

4. **Scope boundary for Doctor findings**: a cycle, invalid or broken edge, stale satisfied-prerequisite edge, incomplete candidate as defined by `tree.md`, or unexplained readiness drift triggers stop condition 2 in a scoped loop only when it involves a scoped task or an effective `blocks` prerequisite of a scoped task (fail closed). Findings elsewhere in the backlog do not stop a scoped loop.

If no scope ID is provided, the loop operates over the entire backlog as usual.

## 2. Autonomous loop with stopping conditions

Loop is autonomous by default: chain tasks without asking until an explicit stopping condition applies.

### Stopping conditions (enumerated)

Loop pauses task execution when any of the following is true. Conditions 1 and 3–7 stop the invocation and produce the final SUMMARY. Condition 2 enters §2.1; it produces a final SUMMARY only when recovery is rejected or remains unresolved, and otherwise returns to autonomous selection after verified repair:

1. **No executable tasks remain**: the frontier is empty; all non-epic Beads are closed or blocked on external dependencies.
2. **Doctor required**: a fresh tree read detects a cycle, invalid graph, broken or stale satisfied-prerequisite edge, incomplete candidate as defined by `tree.md`, or unexplained readiness drift. Contract-incomplete records that are blocked, externally gated, deferred, invalid, or lower-ranked than a complete executable task remain findings but do not stop the loop.
3. **Unknown or failed control**: a required workspace control (sync, isolation, development workflow, delivery, post-checks, etc.) is missing, inaccessible, or ambiguous.
4. **Claim or lease lost**: the claim failed (race loss), lease expired between stages, or heartbeat failed; ownership no longer matches or status changed from `in_progress`.
5. **Gate failure**: a required check, review, or delivery gate failed for the current task or PR. This includes HIGH-severity security findings from a triggered security review (§3.1).
6. **Human gate applies**: the effective `.workspace/config.yaml` declares a human gate requirement that is met:
   - delivery-policy changes (delivery_mode, delivery_gate, delivery_overrides modified);
   - external effects outside the repository;
   - destructive operations (force-push, branch deletion, etc.);
   - ADR substitution required (replacing an accepted decision).
7. **Implementation error**: an implementation stage encounters an unrecoverable error outside task scope or violating contract invariants.

### 2.1. Doctor recovery transition

When condition 2 fires, task execution stops but the current Roadmap invocation continues through this state machine:

1. Retain `origin=loop`, the literal finding and one deterministic `recovery_scope`, then apply the boundary from §1.1:
   - incomplete candidate: its direct parent epic and that epic's direct incomplete records, or the root task when it has no epic;
   - cycle: every literal record ID and edge in that cycle;
   - invalid graph or broken edge: every literal record and edge named by the finding, including an absent target ID as evidence rather than an invented record;
   - stale satisfied-prerequisite edge: both edge endpoints and every successor candidate already stated by current authority; and
   - readiness drift: the union of `topology_only` and `provider_only` IDs from `tree.md` step 7.
2. Load `doctor.md` and run its diagnosis and proposal work read-only on only `recovery_scope`. Loop does not apply a Doctor correction.
3. If one material authority value is missing, show the verified evidence, ask one concrete question for that value, and remain in Doctor recovery.
4. When a complete proposal exists, show the complete final field values or guarded command set, its expected effects, and preserved data. End the turn with exactly these choices: **approve exactly**, **request adjustments**, or **reject**. Remain in Doctor recovery until one is chosen; workflow invocation is not an approval response.
5. On **request adjustments**, revise the proposal read-only and present the complete replacement gate. On **reject**, preserve the graph unchanged and stop with condition 2, naming the rejected repair as the blocker.
6. On **approve exactly**, Doctor applies only the displayed payload and runs its complete verification. After verified success, return control to Loop, rerun the complete tree recipe, and resume autonomous selection unless another stopping condition applies.

The operator is never asked to invoke `doctor`, `plan`, or `loop` to advance this transition.

### Selecting and claiming a task

Run the complete tree recipe, limited to the scope boundary if a scope ID was provided. When a condition-2 finding named above applies, complete §2.1 before any selection; unrelated or lower-ranked incomplete records do not stop selection. In a scoped loop apply the boundary in §1.1 item 4. Select exactly one complete task in the executable intersection within the scope boundary, ordered by current ownership, Beads priority, reverse-dependency impact, then ID. Exclude epics. If a scope ID was an epic, consider only its direct task children for selection.

Read the selected task's full contract. Claim only it:

```bash
bd update "$BEAD_ID" --claim --json
```

A failed claim is a race loss (condition 4). Refresh the tree read-only and report; do not overwrite an owner or immediately select another task. Re-read the Bead with `bd show "$BEAD_ID" --json` and verify both the exact expected assignee `$ACTOR` and `in_progress` status before implementation.

## 3. Execute bounded stages

The Roadmap controller alone delegates. Use a fresh Superpowers role appropriate to each bounded pass. No child delegates or creates another subagent. Keep handoffs bounded and return concise results, not accumulated transcripts.

**Role mapping**:
- **Implementer**: `superpowers-mechanical-implementer` (1–2 file changes); `superpowers-integration-worker` (multi-file changes).
- **Reviewer**: `superpowers-task-reviewer` for task review and security review (§3.1).
- **Epic final review**: `superpowers-final-reviewer`.

Every completed bounded role pass appends exactly one Bead comment with this shape:

```text
ROADMAP_HANDOFF v1
role=<implementer|task-reviewer|security-reviewer|epic-final-reviewer>
verdict=<pass|fail|blocked>
candidate_sha=<sha|none>

Summary: <bounded result>
Findings:
- <finding or none>
```

Write it from an owned temporary file outside durable repository paths. Immediately before the write, capture the current comment IDs in controller state; if that read fails, stop before the write:

```bash
bd comments "$BEAD_ID" --json > "$TEMP_COMMENT_BASELINE"
bd comments add "$BEAD_ID" --file "$TEMP_HANDOFF" --json
```

On a confirmed response, retain the returned comment ID. On a failed or ambiguous response, perform exactly one read-only `bd comments "$BEAD_ID" --json` confirmation. Continue only when it proves exactly one new comment ID, absent from `$TEMP_COMMENT_BASELINE`, whose body equals `$TEMP_HANDOFF`; retain that ID. Any absent, duplicate, mismatched, or unreadable result is an unconfirmed handoff and implementation error stopping condition 7. Beads 1.3.0 comments have no idempotency key: never issue a second comment write after a failed or ambiguous response. Remove the temporary files only after a confirmed write or after preserving the evidence needed for the stop report.

Execute:

```text
read full Bead contract
→ execution admission checks required by that contract
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

Set `$SECURITY_PATHS` to the comma-separated changed-path list evaluated by this trigger before either branch.

If trigger applies:
1. Dispatch a fresh `superpowers-task-reviewer` on the PR head SHA with a security-focused brief (secrets exposure, credential handling, authentication and authorization logic, cryptography use), separate from the general task review.
2. Record the security review verdict and findings as a `ROADMAP_HANDOFF v1` comment with `role=security-reviewer`.
3. A HIGH-severity finding blocks task closure and autonomous merge (gate failure, stopping condition 5).
4. After a passing security review, set `SECURITY_RESULT=pass`.

If trigger does not apply, set `SECURITY_RESULT=not-triggered`. The final `ROADMAP_RESULT v1` records that result and `$SECURITY_PATHS` separately.

Run this exact heartbeat command immediately before and after each bounded implementation, review, and delivery stage:

```bash
bd heartbeat "$BEAD_ID"
```

After every heartbeat and stage, re-read the Bead and verify assignee and `in_progress` still match. Heartbeat failure, changed assignee, changed status, or lease loss stops further mutation. Only an explicit Doctor proposal may reclaim a verified expired lease.

Run task-declared fresh observation, lock acquisition, isolated-worktree cleanliness, validation, and equivalent execution admission checks only after claim and before the stage they guard. A failed or unknown admission check is a gate failure (condition 5); do not reclassify it retroactively as a pre-claim external gate or continue to effects.

Preserve unrelated work and remain inside the selected contract. Passing unit tests is not sufficient: prove task acceptance, invariants, required reviews, every applicable effective-workspace control, configured delivery, and post-checks.

## 4. Record canonical evidence and finalize conditionally

Before finalization, verify that every required bounded role outcome is stored as a Bead comment. Record each available external binding after it becomes known:

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

`$CANDIDATE_SHA` is always required. Branch, PR, CI and transcript bindings are required exactly when the selected delivery flow or task produced those values; an artifact the effective workflow does not produce is not applicable. Every applicable binding must be confirmed before finalization. Provenance records are idempotent. A rejection that meets every confirmed no-effect mechanical-correction condition in `contracts.md` receives exactly one corrected attempt and readback; until that succeeds, finalization stays blocked. Any failed or ambiguous provenance write outside that exception blocks finalization. The `Bead: <BEAD_ID>` Git trailer remains a backlink, not a substitute for Beads-side provenance.

Close only when every required result is passed (or explicitly not applicable where the workspace contract permits), including any triggered security review, ownership still matches, and the Bead remains `in_progress`. Build one bounded notes entry:

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

Never retry exit 13, a stale conditional guard, or any ownership loss. Write no fallback PASS, stop mutation, report `claim_lost`, and retain the contract-required non-closed state.

When a required review remains blocking after its bounded fix/re-review, first store its failed handoff comment and capture `$COMMENT_ID`, then run:

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

A stale failure-path guard preserves the truthful comment, writes no PASS, reports `claim_lost`, and stops.

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

### Turn-exit gate

While Loop remains active, apply this ordered gate after each stage or successful close, before autonomous chaining, and before any operator-facing response that could end the turn:

1. Refresh controller state and determine whether one of the seven enumerated stopping conditions or a currently required human decision gate applies. A side status or progress question is not a stopping condition and does not suspend Loop.
2. If a literal stop or human decision gate applies, retain its exact evidence and present it. Real cancellation, completion, configured human gates, Doctor approval questions, claim or lease loss, gate failure, and implementation error remain valid turn-ending paths; this gate does not alter their semantics.
3. Otherwise establish continuation before composing the response:
   - A bounded worker is the fresh role pass dispatched by the controller under §3. If one is already active, verify and retain that state. A status answer may report it without launching duplicate work.
   - If no bounded worker is active, start the next executable action. When that action begins the next Bead's bounded work, claim the Bead, verify its assignee and `in_progress` status, heartbeat it, dispatch the fresh §3 role pass in background, and verify that worker is active.
4. Record the resulting controller state as exactly one of: the next executable action has started; the next Bead is claimed, verified, heartbeated, and its background worker is active; or the literal stopping condition or human decision gate is retained for presentation. An action merely named or promised has not started. If a foreground action finishes before the response, apply this gate again to the resulting state.
5. Only then send the operator-facing response. If starting or dispatching the action fails, retain and report the actual applicable stopping condition and failure evidence instead of stating or implying that work is active.

### Autonomous chaining

After a successful close, immediately re-read the Bead and the complete graph. Check for any stopping condition. If none applies, select the next topologically ready task in deterministic order and continue. Repeat until a stopping condition is met.

An epic is never claimed or implemented. Close an epic only after every child task is closed, an `epic-final-reviewer` handoff comment passes, fresh Bead evidence proves the epic's own success criteria, and any required conditional safeguards hold. Append an epic `ROADMAP_RESULT v1` notes entry; create no execution report file.

## 5. Final summary and emergency continuation

When the loop stops, re-read the complete graph before printing the final summary. If one or more non-epic Beads remain non-closed and no task can continue now, this is a **`BACKLOG EMERGENCY`**. It is not backlog hygiene, even when the blocker is configuration, contract completeness, an external gate, or ownership.

A `BACKLOG EMERGENCY` response must:

1. show the literal count of pending non-epic Beads in scope;
2. name the deterministic next candidate that is stranded, when one exists;
3. name the literal blocker and authoritative field, edge, gate, or finding;
4. provide exactly one concrete policy-valid `CONTINUE` action that addresses that blocker; and
5. keep secondary findings outside the continuation gate.

Derive `CONTINUE` from the retained stopping state and render the next operator decision, not a workflow invocation:

- after §2.1 produced a complete Doctor proposal: `Approve exactly, request adjustments, or reject the displayed proposal for <recovery_scope>`;
- while §2.1 lacks one authority value: repeat the one concrete question for that value;
- for an unknown workspace control: use the retained `authority_field` and `missing_input` from §1 to show the exact authority proposal or ask for that one value;
- for a declared external or defer condition: name the literal condition and the action that satisfies it; and
- when another governed workflow owns the action, show its exact input payload in the current response rather than asking the operator to invoke it.

Advice such as "fix config", "run Doctor", or "retry when available" is not a continuation. Deferred or intentionally parked tasks still count as pending; satisfy the declared condition or explicitly close or re-scope the record instead of silently downgrading the emergency.

Print this bounded shape before exiting. The first four rows after the header are present only for `BACKLOG EMERGENCY`; omit them from a clean `LOOP SUMMARY` with zero pending tasks:

```
╔════════════════════════════════════════════════════════════════╗
║              <LOOP SUMMARY | BACKLOG EMERGENCY>                ║
╠════════════════════════════════════════════════════════════════╣
║ Pending tasks: <count>                                         ║
║ Stranded next candidate: <BEAD_ID + title | none>              ║
║ Blocking condition:                                            ║
║   <literal field, edge, gate, ownership loss, or finding>      ║
║ CONTINUE:                                                      ║
║   <one concrete policy-valid action>                           ║
║ Closed tasks:                                                  ║
║   <BEAD_ID>: <title> (PR: <url>, merge SHA: <sha>)             ║
║   result: ROADMAP_RESULT v1; provenance: <refs>                ║
║   ...                                                           ║
║ Reviews and findings:                                          ║
║   <brief summary of review results or issues>                  ║
║ Delivery gates applied:                                        ║
║   <gate-name>: <passed|failed|not-applicable>                  ║
║   ...                                                           ║
║ Stopping condition:                                            ║
║   <number>. <description>                                      ║
║ Cleanup offered (cleanup_policy):                              ║
║   worktree: <path>                                             ║
║   branch: <branch-name>                                        ║
╚════════════════════════════════════════════════════════════════╝
```

Use `LOOP SUMMARY` only when no pending non-epic Beads remain. The summary must record:
- **Pending tasks**: literal in-scope non-closed non-epic count.
- **Stranded next candidate**: the candidate selected before the blocking control by §2 ordering (current ownership, Beads priority, reverse-dependency impact, then ID), or `none` with the reason no candidate exists.
- **Blocking condition**: the exact authority or graph fact preventing execution.
- **CONTINUE**: one concrete action, including its owning workflow when Loop cannot execute it.
- **Closed tasks**: each task ID, title, PR URL (if applicable), merge SHA (if merged), final `ROADMAP_RESULT v1` verdict, and recorded provenance references.
- **Reviews and findings**: concise summary of reviewer feedback and any HIGH-security findings or regressions.
- **Delivery gates applied**: each gate name and its result (passed, failed, or not applicable).
- **Stopping condition**: reference one of the 7 stopping conditions (section 2) by number and description.
- **Cleanup offered**: list worktree paths and branch names available for cleanup, then wait for the operator to select the exact cleanup target; deletion is never inferred from the offer.
