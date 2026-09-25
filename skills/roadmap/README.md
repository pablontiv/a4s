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

Plan and Doctor do not mutate before explicit approval. Bare Roadmap never mutates. Loop is autonomous by default: chains ready tasks one at a time until an explicit stopping condition is met, publishes a final SUMMARY, and combines each Bead's acceptance contract with the effective repository Definition of Done. Loop follows all approval gates literally; human gates are stopping conditions.

When invoked as `loop <id>`, the loop limits its scope to a single epic or task: if `<id>` is an epic, loop chains only its direct task children; if `<id>` is a task, loop operates only on that task. Stop condition 1 (no executable tasks) is evaluated within the scope; Doctor findings, including readiness drift, stop the loop only when they involve a scoped task or an effective `blocks` prerequisite of a scoped task (fail closed). Invalid or non-existent IDs are rejected without mutation.

## Direct dependencies

- the installed Beads 1.3.x `bd` CLI for durable backlog state and all graph operations;
- Git for repository and candidate state; and
- the effective `.workspace/config.yaml` for mutating loop work, including review, delivery, and post-check policy.

Rootline may govern ADRs, specs, and plans, but it is not a Roadmap backlog dependency. Temporary graph input may exist under ignored `.superpowers/roadmap/`; Beads remains the only durable backlog.

## Verification

Verify prose behavior with the `writing-skills` pressure method, not a Roadmap test harness:

1. preserve the bounded pre-skill response for each review-focus scenario;
2. load `SKILL.md` and only the routed reference in a fresh agent;
3. rerun Plan approval, false empty frontier, Doctor ambiguity, Doctor contract backfill, missing-workspace-DoD, and parallelism-pressure scenarios; for missing workspace authority, include a backlog with 65 pending tasks and a complete P0 candidate stranded only by `repo.path`/`verified_revision`, and require `BACKLOG EMERGENCY`, the pending count, the stranded candidate, the literal fields, and one concrete `CONTINUE` action;
4. rerun these Roadmap-readiness regressions with fresh agents:
   - a complete executable task plus unrelated blocked contract-incomplete records;
   - a provider-ready task whose fresh observation and writer lock are execution admission checks;
   - a provider-ready task excluded solely by a genuine pre-claim external gate;
   - a child task whose parent epic has an open `blocks` prerequisite;
   - a Doctor-added prerequisite both before and after its hypothetical closure;
   - an incoming `blocks` edge to a closed superseded container whose outcome is explicitly incomplete; and
   - an open record with `started_at` but no assignee, claim, lease, or live session metadata;
5. rerun the canonical-evidence scenarios with fresh agents:
   - **normal close**: use comments, typed provenance and atomic structured notes; create no execution report file;
   - **claim loss**: do not close, write PASS, retry or force; report `claim_lost`;
   - **blocking review**: retain the failed comment and append a guarded blocked result; write no PASS;
   - **reconstruction**: read comments and provenance explicitly;
   - **external evidence**: bind SHA, branch, PR, CI and transcript references by type without copying logs; and
   - **file pressure**: refuse role/final report documents and use Beads;
   - **mechanical rejection**: after a provider-confirmed no-write schema rejection of an idempotent provenance command, deterministically expand an abbreviated SHA, make exactly one corrected attempt, and verify readback;
   - **ambiguous rejection control**: stop without retry when insertion status, idempotency, authority, target, payload, or authorization is unknown;
6. require all fresh agents to agree on stop/continue, gate classification, effective prerequisites, transition result, Doctor finding, storage surface, lifecycle result, retry behavior, and created files; disagreement is a failed pressure scenario;
7. record pass/fail and the exact rationalization;
8. if one fails, change only the implicated Markdown and rerun that scenario with another fresh agent.

Supplement, but never replace, those pressure scenarios with:

```bash
legacy='roadmap/'"reports|EVIDENCE_"'REF|PASS '"evidence=|repository-contained Markdown (evidence )?"'report'
! rg "$legacy" skills/roadmap
rg 'include-comments|bd comments' skills/roadmap/references/doctor.md skills/roadmap/references/tree.md
rg 'append-notes|ROADMAP_HANDOFF v1|ROADMAP_RESULT v1' skills/roadmap/references/loop.md
rg 'bd provenance' skills/roadmap/references/contracts.md skills/roadmap/references/doctor.md skills/roadmap/references/tree.md skills/roadmap/references/loop.md
rg 'BACKLOG EMERGENCY|Pending tasks|Stranded next candidate|CONTINUE' skills/roadmap/SKILL.md skills/roadmap/references/doctor.md skills/roadmap/references/loop.md
```

Also confirm the bundle contains only Markdown, the public router stays concise, forbidden legacy commands are absent, and `git diff --check` is clean. Existing repository checks remain applicable; do not add a Roadmap unit, integration, or E2E test harness.

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
