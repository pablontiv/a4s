---
tipo: plan
---
# Roadmap non-temporal session fencing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Roadmap's five-minute Beads leases with session-scoped compare-and-set ownership that supports immediate takeover and checkpoint-based continuation.

**Architecture:** Roadmap remains a Markdown-only skill. `contracts.md` defines the controller and evidence contracts, `loop.md` performs guarded start, takeover, checkpoint, and finalization transitions, and Tree and Doctor classify resumable or ambiguous `in_progress` state. README pressure scenarios and a disposable Beads smoke prove the provider commands and prose behavior.

**Tech Stack:** Agent Skills Markdown, Beads 1.3.x CLI, Pi `PI_SESSION_ID`, Git worktrees, Rootline-governed ADR/spec/plan Markdown, Superpowers fresh-agent pressure tests.

**Spec:** `.workspace/docs/specs/2026-09-26-roadmap-non-temporal-session-fencing-design.md`

## Global constraints

- ADR 0057 is the accepted authority and supersedes ADR 0044.
- Preserve Roadmap as the only Plan, tree, Doctor, and sequential Loop interface over Beads.
- Preserve ADR 0033 conditional finalization, now guarded by the current session controller.
- Preserve ADR 0048's Markdown-only implementation and pressure-test verification.
- Preserve ADR 0050's canonical Bead evidence boundary.
- Resolve the controller exactly as `roadmap:<PI_SESSION_ID>` and stop before mutation when `PI_SESSION_ID` is absent.
- Add no daemon, timer, lock service, scheduler, parser, adapter, helper runtime, or Roadmap test harness.
- Normal Loop must not call `bd update --claim`, `bd heartbeat`, or `bd reclaim`.
- A new Loop invocation automatically takes over exactly one resumable task without waiting or asking for confirmation.
- More than one resumable `in_progress` task is a Doctor finding; never choose one arbitrarily.
- Store checkpoints only in Bead metadata, comments, notes, and provenance. Create no execution report file.
- Keep comments and provenance append-only. A stale-session append remains history and cannot authorize a gate or closure.
- Keep dedicated-worktree isolation and explicit cleanup from `.workspace/config.yaml`.
- Before implementation mutation, refresh local `main` with explicit `git pull --ff-only origin main`, then update the implementation branch from that verified base and stop on conflicts.
- Rename live Roadmap `pre-claim external gate` vocabulary to `pre-start external gate` because acquisition no longer uses a claim.
- Rename the live Roadmap terminal condition from `claim_lost` to `controller_lost`; repository search found no active consumer outside the Roadmap skill.
- Update `skills/roadmap/SKILL.md` `metadata.updated` to `"2026-09-26"` in the same commit as the behavior change.
- Preserve historical ADRs, specs, plans, and reports without editing their old claim or lease terminology.

## Review focus

- An open task already has a human or pool assignee: start must compare against that exact value and still produce one controller winner.
- A second Pi session starts while the first can still run: takeover must invalidate the old lifecycle guard, and old-session comments must not satisfy current gates.
- A legacy task still exposes `lease_expires_at`: takeover must proceed immediately and no later Roadmap path may reclaim it.
- The candidate SHA changes after review or validation: every later checkpoint result for the old SHA must become invalid.
- A scoped loop sees one in-scope and one out-of-scope `in_progress` task: only the in-scope record participates in takeover or ambiguity.

---

### Task 1: Replace lease execution with the controller protocol

**Files:**
- Modify: `skills/roadmap/references/contracts.md:1-66`
- Modify: `skills/roadmap/references/loop.md:1-306`

**Interfaces:**
- Consumes: `PI_SESSION_ID`, observed Bead status and assignee, `bd update` conditional guards, Bead metadata, comments, notes, provenance, and Git worktree state.
- Produces: `CONTROLLER=roadmap:<PI_SESSION_ID>`, six `roadmap_*` checkpoint keys, `ROADMAP_HANDOFF v2`, `ROADMAP_RESULT v2`, and `controller_lost`.

- [ ] **Step 1: Capture five fresh-agent RED samples before editing**

Give five fresh read-only agents the current `SKILL.md`, `contracts.md`, and `loop.md`. Use one scenario per agent:

```text
1. Start one open, unassigned executable task and explain every ownership command.
2. Resume one in_progress task with a human assignee and an expired lease from a new Pi session.
3. Start the same task from a second session that resolves to the same human Beads actor.
4. Accept a late reviewer handoff from the prior session after ownership changes.
5. Resume after review when the worktree candidate SHA changed before validation.
```

Expected RED: each accepted sample exhibits the current failure relevant to its scenario, such as `--claim`, heartbeat, lease wait/reclaim, actor-level ownership, v1 handoff without session identity, or no checkpoint/SHA invalidation rule. If a sample already gives the required design behavior, strengthen that scenario and replace the sample before editing. Preserve transcript references and exact rationalizations outside repository report files.

- [ ] **Step 2: Prove the Beads CAS commands in a disposable repository**

Run this provider smoke before changing Markdown:

```bash
set -euo pipefail
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q
bd -C "$TMP" init --non-interactive --skip-agents --skip-hooks --prefix fence

ID=$(bd -C "$TMP" create "CAS target" --type task --silent)
bd -C "$TMP" update "$ID" \
  --status in_progress \
  --assignee roadmap:session-1 \
  --if-status open \
  --if-assignee '' \
  --set-metadata roadmap_controller_session=session-1 \
  --set-metadata roadmap_stage=admission \
  --json

set +e
bd -C "$TMP" update "$ID" \
  --status in_progress \
  --assignee roadmap:session-2 \
  --if-status open \
  --if-assignee '' \
  --json
START_RC=$?
set -e
test "$START_RC" -eq 13

PREASSIGNED=$(bd -C "$TMP" create "Preassigned target" --type task --assignee planner --silent)
bd -C "$TMP" update "$PREASSIGNED" \
  --status in_progress \
  --assignee roadmap:session-4 \
  --if-status open \
  --if-assignee planner \
  --set-metadata roadmap_controller_session=session-4 \
  --json

bd -C "$TMP" update "$ID" \
  --assignee roadmap:session-2 \
  --if-status in_progress \
  --if-assignee roadmap:session-1 \
  --set-metadata roadmap_controller_session=session-2 \
  --json

set +e
bd -C "$TMP" update "$ID" \
  --status closed \
  --if-status in_progress \
  --if-assignee roadmap:session-1 \
  --append-notes stale-controller-must-fail \
  --json
OLD_RC=$?
set -e
test "$OLD_RC" -eq 13

SHOW_JSON=$(bd -C "$TMP" show "$ID" --json)
SHOW_JSON="$SHOW_JSON" python3 - <<'PY'
import json, os
value = json.loads(os.environ["SHOW_JSON"])
issue = value[0] if isinstance(value, list) else value
assert issue["status"] == "in_progress"
assert issue["assignee"] == "roadmap:session-2"
assert issue.get("lease_expires_at") in (None, "")
metadata = issue.get("metadata") or {}
assert metadata.get("roadmap_controller_session") == "session-2"
PY

LEGACY=$(bd -C "$TMP" create "Legacy leased target" --type task --silent)
bd -C "$TMP" --actor legacy-worker update "$LEGACY" --claim --json
bd -C "$TMP" update "$LEGACY" \
  --assignee roadmap:session-3 \
  --if-status in_progress \
  --if-assignee legacy-worker \
  --set-metadata roadmap_controller_session=session-3 \
  --json
```

Expected: concurrent guarded starts have exactly one winner, an open task with a human assignee starts only from that exact observed value, takeover succeeds immediately, the old controller receives exit 13, manual `in_progress` assignment has no lease, and the legacy claimed task transfers without heartbeat, expiry wait, or reclaim. Any mismatch stops implementation and sends the spec back for revision.

- [ ] **Step 3: Define controller and checkpoint contracts in `contracts.md`**

Add these exact controller values and metadata keys:

```text
CONTROLLER=roadmap:<PI_SESSION_ID>
roadmap_controller_session
roadmap_stage
roadmap_branch
roadmap_worktree
roadmap_base_sha
roadmap_candidate_sha
```

Define `pre-start external gate` as the pre-controller counterpart to an execution admission check. Replace live claim and lease terms in the confirmed no-effect exception with controller acquisition, takeover, ownership, lifecycle, and conditional guards. Define v2 handoff/result authority: only payloads whose `controller_session` matches the current assignee and whose `candidate_sha` matches the active checkpoint can satisfy a gate.

- [ ] **Step 4: Replace Loop selection and claim with guarded start and takeover**

In `loop.md`:

1. resolve `PI_SESSION_ID` before mutation and retain it as an unknown required control when absent;
2. rename stop condition 4 to controller transition or ownership loss;
3. prioritize exactly one in-scope resumable `in_progress` task before open selection;
4. use the spec's guarded start command for an open candidate;
5. use the spec's guarded takeover command for an interrupted task;
6. re-read status, assignee, and `roadmap_controller_session` after either transition; and
7. enter Doctor recovery with every literal ID when more than one resumable task exists.

Exit 13 gets one read-only state refresh. Continue only when readback already shows this controller; otherwise report `controller_lost` and stop. Remove the heartbeat block and every normal-loop reclaim instruction.

- [ ] **Step 5: Add checkpoints, v2 handoffs, and v2 guarded results**

Require guarded metadata checkpoints after admission and each bounded implementation, review, validation, and delivery stage. Reconstruction reads comments and provenance, verifies branch/worktree/SHA, resumes the first incomplete stage, and invalidates all later stage results after a candidate SHA change.

Replace live payloads with the spec's exact `ROADMAP_HANDOFF v2` and `ROADMAP_RESULT v2` shapes. Read controller ownership immediately before and after append-only comment/provenance writes. A stale-session payload remains visible but cannot count toward review, security, delivery, or closure.

Final pass and blocked-review transitions must use:

```text
--if-status in_progress
--if-assignee "$CONTROLLER"
```

Replace every live `claim_lost` output with `controller_lost`. Preserve the no-retry, no-force, no-fallback-result behavior.

- [ ] **Step 6: Run the five focused GREEN pressure scenarios**

Repeat Step 1 with five new agents and the edited files. Require unanimous results:

```text
1. one guarded open -> in_progress winner and no claim command;
2. immediate takeover of one legacy or session-owned task;
3. old controller loses lifecycle authority after takeover;
4. stale-session v2 handoff is historical only;
5. changed candidate SHA invalidates review and later checkpoints.
```

Any disagreement is RED. Edit only the implicated wording and rerun that scenario with another fresh agent.

- [ ] **Step 7: Run focused mechanical GREEN checks**

Run:

```bash
! rg -n -- '--claim|bd heartbeat|bd reclaim' skills/roadmap/references/loop.md
! rg -n 'claim_lost|pre-claim external gate|ROADMAP_HANDOFF v1|ROADMAP_RESULT v1' \
  skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
rg -n 'PI_SESSION_ID|roadmap_controller_session|roadmap_stage|roadmap_candidate_sha|controller_lost|ROADMAP_HANDOFF v2|ROADMAP_RESULT v2' \
  skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
git diff --check
```

Expected: forbidden normal-flow commands and v1 terms are absent; every new controller surface is present; diff check is silent.

- [ ] **Step 8: Commit the controller protocol**

```bash
git add skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
git commit -m "feat(roadmap): replace leases with session fencing"
```

### Task 2: Make Tree and Doctor understand resumable sessions

**Files:**
- Modify: `skills/roadmap/references/tree.md:1-156`
- Modify: `skills/roadmap/references/doctor.md:1-134`

**Interfaces:**
- Consumes: task status, assignee, `roadmap_controller_session`, checkpoint metadata, comments, provenance, scope boundary, and open-task provider readiness.
- Produces: one resumable task, explicit multi-task ambiguity, scoped ownership classification, and guarded Doctor corrections without reclaim.

- [ ] **Step 1: Capture ownership-classification RED with fresh agents**

Run one fresh read-only agent per scenario against the current Tree and Doctor text:

```text
1. One in_progress task has roadmap_controller_session from an older Pi session.
2. One legacy in_progress task has a human assignee and lease_expires_at but no controller metadata.
3. Two in_progress tasks exist in the same loop scope.
4. A scoped loop has one in-scope and one out-of-scope in_progress task.
5. A task is open but still carries roadmap_controller_session metadata.
```

Expected RED: current guidance treats another live session or lease as blocking, proposes reclaim, mixes `in_progress` with provider-ready comparison, or lacks exact ambiguity/session rules.

- [ ] **Step 2: Separate resumable work from open-task readiness in `tree.md`**

Before comparing topology-ready and provider-ready open tasks:

1. classify `in_progress` tasks inside the active scope;
2. mark exactly one coherent task `resumable`, whether it has a current session controller or legacy human assignee;
3. mark more than one `ownership ambiguity` and produce a Doctor finding over every literal in-scope ID;
4. exclude out-of-scope `in_progress` records from scoped ambiguity;
5. keep status-mismatched controller metadata as stale operational state; and
6. run the existing readiness-drift comparison only for open tasks.

Replace the current-owned ordering rule with: resumable task first, then open tasks by priority, reverse-dependency impact, and ID. Replace `claimed by another live session` with session-controller wording that does not infer liveness. Rename `pre-claim external gate` to `pre-start external gate` and state that execution admission checks run after guarded controller acquisition.

- [ ] **Step 3: Replace lease recovery with controller diagnosis in `doctor.md`**

Detect and cite:

```text
multiple in_progress tasks in one sequential scope
in_progress without controller metadata or a coherent legacy owner
controller metadata on a non-in_progress task
checkpoint disagreement with Git, comments, notes, or provenance
handoff/result controller_session mismatch
handoff/result candidate_sha mismatch
```

Remove `bd reclaim --id` from permitted corrections and remove lease expiry as a reason to wait. One legacy `in_progress` task is Loop-resumable and needs no Doctor approval. Doctor may propose a guarded status or assignee correction only when a separate inconsistency remains, using exact observed `--if-status` and `--if-assignee` values. Rename every pre-claim term to pre-start.

- [ ] **Step 4: Run the five ownership GREEN scenarios**

Repeat Step 1 with fresh agents. Require:

```text
1. one coherent in-progress task is resumable immediately;
2. one legacy leased task is resumable without reclaim or waiting;
3. two in-scope tasks produce one Doctor finding containing both IDs;
4. out-of-scope work does not contaminate scoped selection;
5. metadata/status contradiction is stale operational state and receives no guessed mutation.
```

A response that uses time, liveness inference, heartbeat, or reclaim is RED.

- [ ] **Step 5: Run focused Tree and Doctor checks**

Run:

```bash
! rg -n 'bd reclaim|verified expired lease|pre-claim|claim first|claimed by another live session' \
  skills/roadmap/references/tree.md skills/roadmap/references/doctor.md
rg -n 'resumable|ownership ambiguity|roadmap_controller_session|controller_session|candidate_sha|pre-start external gate' \
  skills/roadmap/references/tree.md skills/roadmap/references/doctor.md
rg -n 'include-comments|bd comments|bd provenance' \
  skills/roadmap/references/tree.md skills/roadmap/references/doctor.md
git diff --check
```

Expected: reclaim and stale claim vocabulary are absent from live recovery; session and evidence classifications are present; diff check is silent.

- [ ] **Step 6: Commit Tree and Doctor semantics**

```bash
git add skills/roadmap/references/tree.md skills/roadmap/references/doctor.md
git commit -m "docs(roadmap): resume work by session controller"
```

### Task 3: Lock the new behavior into Roadmap verification

**Files:**
- Modify: `skills/roadmap/README.md:1-106`
- Modify: `skills/roadmap/SKILL.md:1-39`
- Reference without editing: `.workspace/docs/adr/0057-reemplazar-leases-roadmap-por-fencing-de-sesion.md`
- Reference without editing: `.workspace/docs/specs/2026-09-26-roadmap-non-temporal-session-fencing-design.md`
- Reference without editing: `.workspace/docs/plans/2026-09-26-roadmap-non-temporal-session-fencing.md`

**Interfaces:**
- Consumes: Tasks 1-2 Markdown behavior, provider smoke evidence, accepted ADR 0057, and the approved spec.
- Produces: durable pressure scenarios, mechanical regression commands, updated skill metadata, and a review-ready branch.

- [ ] **Step 1: Update README verification scenarios and oracles**

Keep every existing non-lease regression. Replace `claim loss` with `controller loss`, `pre-claim external gate` with `pre-start external gate`, and v1 payload checks with v2.

Add these fresh-agent scenarios:

```text
concurrent guarded start
automatic takeover
old-controller finalization
checkpoint reconstruction
candidate SHA invalidation
stale-session handoff
single legacy leased task
multiple in-progress ambiguity
scoped takeover isolation
missing PI_SESSION_ID
```

Require all agents to report commands, status/assignee/metadata transitions, evidence accepted or rejected, stopping condition, and whether any timer or retry occurred. Disagreement is failure.

Add mechanical checks for:

```text
no --claim, heartbeat, or reclaim in normal Loop
no claim_lost or pre-claim vocabulary in live Roadmap files
PI_SESSION_ID and all six checkpoint keys present
ROADMAP_HANDOFF v2 and ROADMAP_RESULT v2 present
controller_lost present
```

Retain the rule that Roadmap adds no unit, integration, or E2E test harness.

- [ ] **Step 2: Update the public skill invariant and metadata**

In `skills/roadmap/SKILL.md`, change the Beads invariant from `claims` to session controller ownership and checkpoints. Keep routing and approval transitions unchanged. Set:

```yaml
metadata:
  author: pablontiv
  updated: "2026-09-26"
```

- [ ] **Step 3: Run the complete fresh-agent regression matrix**

Run the ten new scenarios plus the existing Plan approval, false frontier, Doctor ambiguity, Doctor contract backfill, missing workspace authority, Loop-to-Doctor-to-Loop, readiness drift, Plan mismatch, comment ambiguity, canonical evidence, and mechanical retry scenarios from README.

Each scenario uses a fresh read-only agent with only `SKILL.md`, `contracts.md`, and the routed reference. A scenario passes only when every sample agrees on selection, transition, guards, evidence authority, stop/continue result, and created files. Fix only implicated Markdown and rerun only the failed scenario with another fresh agent.

- [ ] **Step 4: Run full repository verification**

Temporarily hydrate the sparse worktree paths needed by local CI:

```bash
git sparse-checkout set .workspace packages profiles skills src test
```

Then run:

```bash
test/ci-local.sh
rootline validate --all .workspace/docs -o json
git diff --check
```

Run the final Roadmap mechanical suite from the edited README. Expected: CI reports 19 passed and 0 failed, Rootline reports every governed document valid, all positive surfaces are present, all forbidden normal-loop surfaces are absent, and diff check is silent.

- [ ] **Step 5: Request independent whole-branch review**

Dispatch a fresh `superpowers-final-reviewer` against `merge-base(origin/main, HEAD)..HEAD` with this brief:

```text
Review ADR 0057, the approved session-fencing spec, the implementation plan, and every live Roadmap change. Focus on one-winner CAS, automatic takeover, scoped ambiguity, legacy lease handling, checkpoint/SHA reconstruction, stale-session evidence, conditional finalization, preservation of existing Roadmap transitions, and accidental runtime additions. Report findings by severity with exact paths and lines.
```

Fix every valid finding, rerun affected pressure scenarios and checks, and request one scoped re-review on the new SHA. Create no empty fix commit.

- [ ] **Step 6: Commit verification and review fixes**

```bash
git add skills/roadmap/README.md skills/roadmap/SKILL.md skills/roadmap/references
git commit -m "test(roadmap): verify non-temporal session fencing"
```

If Step 5 required later fixes, use a separate conventional `fix(roadmap): ...` commit after rerunning the affected checks.

## Final delivery

1. Rebase or merge the current implementation branch onto fresh `origin/main` according to `.workspace/config.yaml`; stop on unresolved conflicts.
2. Push the branch and open a PR against `pablontiv/a4s` `main`.
3. Record the exact candidate SHA and the result of every delivery gate in the PR or canonical Bead if execution was attached to one.
4. Apply `Delivery-Override: ci-billing` only when remote jobs show the configured billing annotation with zero steps and local CI is green for the candidate SHA.
5. Merge by squash with `--match-head-commit` only when the candidate SHA satisfies every autonomous gate in `.workspace/config.yaml`.
6. Pull `origin/main`, verify local `main` and `origin/main` point to the same commit, and verify a clean tree.
7. Offer the branch and worktree as explicit cleanup targets. Delete neither without operator selection.
