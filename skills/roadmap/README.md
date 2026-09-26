# Roadmap

Roadmap is a Markdown-only workflow over the repository's Beads backlog. It has no custom runtime, parser, adapter, schema, or test suite.

## Commands

Invoke the skill in the repository whose backlog you intend to inspect or change:

```text
/skill:roadmap plan <requirements>  propose a complete graph, ask approval, then create it
/skill:roadmap                      render the pending decision tree read-only
/skill:roadmap doctor               diagnose alignment; backfill incomplete contracts via Plan elicitation; preview and approval-gate corrections
/skill:roadmap loop                 autonomous loop: chain ready tasks one at a time until stopping condition
/skill:roadmap loop <id>            autonomous loop limited to epic or task <id>
```

Plan and Doctor do not mutate before explicit approval. Bare Roadmap never mutates. Loop is autonomous by default: chains ready tasks one at a time until an explicit stopping condition is met, publishes a final SUMMARY, and combines each Bead's acceptance contract with the effective repository Definition of Done. On stop condition 2, the same invocation transitions internally through Doctor read-only proposal, payload approval, authorized repair and verification, then returns to Loop for a fresh tree read. Loop follows all approval gates literally; human gates are stopping conditions.

When invoked as `loop <id>`, the loop limits its scope to a single epic or task: if `<id>` is an epic, loop chains only its direct task children; if `<id>` is a task, loop operates only on that task. Stop condition 1 (no executable tasks) is evaluated within the scope; Doctor findings, including readiness drift, stop the loop only when they involve a scoped task or an effective `blocks` prerequisite of a scoped task (fail closed). Invalid or non-existent IDs are rejected without mutation.

## Direct dependencies

- the installed Beads 1.3.x `bd` CLI for durable backlog state and all graph operations;
- Git for repository and candidate state; and
- the effective `.workspace/config.yaml` for mutating loop work, including review, delivery, and post-check policy.

Rootline may govern ADRs, specs, and plans, but it is not a Roadmap backlog dependency. Temporary graph input may exist under ignored `.superpowers/roadmap/`; Beads remains the only durable backlog.

## Verification

Verify prose behavior with the `writing-skills` pressure method, not a Roadmap test harness:

1. For every behavior-shaping wording change, run at least five fresh-context baseline samples before editing. Accept RED only when the sample exhibits the targeted failure. If a baseline already behaves correctly, strengthen or replace the scenario. Preserve bounded transcript references and exact rationalizations outside repository report files.
2. Give each fresh agent only `SKILL.md`, `contracts.md`, and the entry reference routed by the scenario. Every sample must report exact commands, status/assignee/metadata transitions, evidence accepted or rejected, stopping condition, whether any timer or retry occurred, and created files. Disagreement on any field is failure.
3. Run these session-controller scenarios:
   - **concurrent guarded start**: two sessions start one open task; exactly one guarded transition wins and the loser stops;
   - **automatic takeover**: one interrupted session-owned task transfers immediately to the new `PI_SESSION_ID`;
   - **old-controller finalization**: the former controller cannot checkpoint, block, or close after takeover;
   - **checkpoint reconstruction**: a new controller verifies branch, worktree, base SHA, candidate SHA, comments, and provenance, then resumes the first incomplete stage;
   - **candidate SHA invalidation**: changing the candidate SHA invalidates review and all later results from the old SHA;
   - **stale-session handoff**: a late passing handoff from the former controller remains history and satisfies no gate;
   - **single legacy leased task**: one human-assigned legacy `in_progress` task is resumable without waiting or reclaim;
   - **multiple in-progress ambiguity**: two in-scope `in_progress` tasks produce one Doctor finding containing both literal IDs and no candidate; cover both two coherent tasks and one coherent plus one contradictory task;
   - **single contradictory execution**: one in-scope `in_progress` task whose checkpoint, owner, or Git evidence cannot be reconstructed enters Doctor with its literal ID and exact contradiction before any open-task selection;
   - **scoped takeover isolation**: an out-of-scope `in_progress` task remains visible but cannot contaminate scoped ambiguity or selection;
   - **epic finalization race**: an epic gets no task controller or checkpoint; two finalizing sessions bind `candidate_sha=none` and exactly one observed-status/assignee CAS close wins; and
   - **missing PI_SESSION_ID**: Loop retains the unknown control and stops before mutation.
4. Rerun every existing non-lease regression:
   - Plan approval and Plan mismatch;
   - false empty frontier;
   - Doctor ambiguity and Doctor contract backfill;
   - missing workspace authority, including 65 pending tasks and a complete P0 candidate stranded only by `repo.path`/`verified_revision`;
   - Loop-to-Doctor-to-Loop recovery for an incomplete child, cross-epic cycle, cross-epic stale edge, and multi-group readiness drift;
   - readiness drift with both ready sets, both differences, and per-ID classifications;
   - ambiguous comment response with one read-only confirmation and no second write;
   - successful close plus a complete next task plus an operator status question: before responding, start the next executable action or complete its §2 guarded start or takeover, verify the ownership triple and checkpoint, dispatch the fresh §3 role pass, and verify that worker is active; real cancellation, completion, configured human gates, Doctor approval questions, `controller_lost`, gate failure, implementation error, and failed start, takeover, or dispatch remain valid turn-ending paths;
   - canonical evidence across comments, guarded notes, typed provenance, and provider-owned logs; and
   - confirmed no-effect mechanical retry plus ambiguous-rejection control.
5. Preserve these readiness and output-shape checks:
   - a complete executable task plus unrelated blocked contract-incomplete records;
   - a provider-ready open task whose fresh observation and writer lock are execution admission checks;
   - a provider-ready open task excluded solely by a genuine pre-start external gate;
   - a child whose parent epic has an open `blocks` prerequisite;
   - a Doctor-added prerequisite before and after hypothetical closure;
   - a satisfied edge to a closed superseded container whose outcome is incomplete;
   - an open record with `started_at` but no controller or checkpoint evidence;
   - a complete Doctor proposal ending with `approve exactly`, `request adjustments`, or `reject`;
   - ambiguous scope preserving the literal known scope and asking one material question; and
   - `BACKLOG EMERGENCY` with pending count, stranded candidate, literal blocker, retained authority fields, and one concrete `CONTINUE` decision.
6. Run each failed scenario again with a fresh agent after changing only the implicated Markdown. Record pass/fail and exact rationalization.

Supplement, but never replace, those pressure scenarios with this mechanical suite:

```bash
legacy='roadmap/'"reports|EVIDENCE_"'REF|PASS '"evidence=|repository-contained Markdown (evidence )?"'report'
! rg "$legacy" skills/roadmap

legacy_commands='--'"claim|bd heart"'beat|bd re'"claim"
! rg -n -- "$legacy_commands" skills/roadmap/references/loop.md

legacy_ownership='claim_'"lost|pre-"'claim'
! rg -n "$legacy_ownership" skills/roadmap

rg 'include-comments|bd comments' skills/roadmap/references/doctor.md skills/roadmap/references/tree.md
rg 'bd provenance' skills/roadmap/references/contracts.md skills/roadmap/references/doctor.md skills/roadmap/references/tree.md skills/roadmap/references/loop.md
rg 'PI_SESSION_ID|roadmap_controller_session|roadmap_stage|roadmap_branch|roadmap_worktree|roadmap_base_sha|roadmap_candidate_sha' skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
rg 'append-notes|ROADMAP_HANDOFF v2|ROADMAP_RESULT v2|controller_lost' skills/roadmap/references/contracts.md skills/roadmap/references/loop.md
rg 'resumable|ownership ambiguity|pre-start external gate' skills/roadmap/references/tree.md skills/roadmap/references/doctor.md
rg 'BACKLOG EMERGENCY|Pending tasks|Stranded next candidate|CONTINUE' skills/roadmap/SKILL.md skills/roadmap/references/doctor.md skills/roadmap/references/loop.md
rg 'approve exactly|request adjustments|reject|origin=loop|topology_only|provider_only|MISMATCH|TEMP_COMMENT_BASELINE' skills/roadmap
test -z "$(find skills/roadmap -type f ! -name '*.md' -print)"
git diff --check
```

The provider CAS smoke in the approved implementation plan remains required when controller-transition commands change. Existing repository checks remain applicable. Roadmap adds no unit, integration, or E2E test harness.

## Activation boundary

Repository merge and global activation are separate operations. Only after the change is merged, and only with explicit operator authorization, install a global `roadmap` symlink that targets the stable A4S checkout. Never point a global skill symlink at an implementation worktree. Remove the retired global predecessor only after the new stable target has been verified. The implementation workflow must not alter global runtime symlinks.

### Post-merge activation runbook (executed 2026-09-24)

**Status: Activation completed and verified.**

Executed 2026-09-24 with verified state:
- `~/.agents/skills/roadmap` → `[REDACTED:shared-root]/harness/a4s/skills/roadmap` ✓
- `~/.agents/skills/beads-loop` absent ✓

Historical record (operator reference):

```bash
set -euo pipefail
test "$(git -C [REDACTED:shared-root]/harness/a4s branch --show-current)" = main
test -f [REDACTED:shared-root]/harness/a4s/skills/roadmap/SKILL.md
test ! -e "$HOME/.agents/skills/roadmap"
test ! -e "$HOME/.agents/skills/roadmap.new"
test "$(readlink "$HOME/.agents/skills/beads-loop")" = [REDACTED:shared-root]/harness/a4s/skills/beads-loop
ln -s [REDACTED:shared-root]/harness/a4s/skills/roadmap "$HOME/.agents/skills/roadmap.new"
mv "$HOME/.agents/skills/roadmap.new" "$HOME/.agents/skills/roadmap"
test "$(readlink "$HOME/.agents/skills/roadmap")" = [REDACTED:shared-root]/harness/a4s/skills/roadmap
unlink "$HOME/.agents/skills/beads-loop"
test ! -e "$HOME/.agents/skills/beads-loop"
test "$(readlink "$HOME/.agents/skills/roadmap")" = [REDACTED:shared-root]/harness/a4s/skills/roadmap
```
