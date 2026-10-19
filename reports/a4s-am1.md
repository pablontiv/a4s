# a4s-am1 — ADR 0048 and activation runbook

- **Bead:** `a4s-am1` (epic `a4s-ann`)
- **Candidate SHA:** `0d3728337b1796e032898848ff6399dc49ad505a`
- **Verdict:** pass (pre-merge). The `ci-local.sh` result on the PR head, the merge, and the post-check results are appended to the Bead notes at closure.

## Delivered

- `.workspace/docs/adr/0048-roadmap-skill-autonomous-loop.md`: created with `adr.sh` and accepted. It partially replaces 0044; 0044 remains accepted and its file is unchanged.
- ADR 0048 decides:
  - roadmap is Markdown-only, and the beads-loop logic and tests are not migrated;
  - the loop is autonomous by default until a stop condition;
  - pacing and re-dispatch belong to the reconciler (`a4s-knt`), and the skill does not use `ScheduleWakeup`.
- ADR 0048 cites ADR 0047.
- `skills/roadmap/README.md`: the activation runbook is marked as executed on 2026-09-24 with the verified state:
  - `~/.agents/skills/roadmap -> [REDACTED:shared-root]/harness/a4s/skills/roadmap`;
  - `~/.agents/skills/beads-loop` absent.

  The runbook is kept as history.

## Deviation

- The ADR number is 0048, not 0047 as planned, because `adr.sh` numbering is sequential (see `reports/a4s-785.md`).
- `metadata.updated` of `skills/roadmap/SKILL.md` already reads 2026-09-24, so it needed no change.

## Acceptance

| Criterion | Result |
|---|---|
| ADR accepted, links 0044, rootline clean | PASS: 143/143 valid |
| README no longer presents the runbook as pending; date and verified symlink state recorded | PASS: the controller and the reviewer independently verified the symlinks |
| ci-local.sh green | PASS on the implementer run (19/19); the result on the head is in the Bead notes |

## Invariants

- ADR 0044 has zero diff.
- Out-of-scope recipes are untouched.

## Reviews

- Implementer: fresh subagent, confined to the worktree; the main checkout was verified clean.
- Reviewer: fresh subagent, APPROVE with 0 findings.

## Workspace controls

- Sync: pull `--ff-only` (`fa01759`).
- Isolation: worktree `.workspace/worktrees/adr-roadmap-markdown`.
- Commits: conventional, with trailers.
- Backscroll: not required; the history came from git and the ADRs.

## Delivery

- Pull request under ci-billing.
- This task supersedes part of an accepted ADR, so under ADR 0047 it keeps the human gate.
- The operator explicitly authorized the merge on 2026-09-24 (pre-autonomy tasks T1, TA, T2 of epic `a4s-ann`).
