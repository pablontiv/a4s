# a4s-y8f — Momentum bonus and epic progress in the decision tree

- **Bead:** `a4s-y8f` (epic `a4s-ann`)
- **Candidate SHA:** `e4ddc72067cc64b48d0aca15c9da6b07eadc4e02`
- **Verdict:** pass (pre-review). The following are appended to the Bead notes at closure:
  - the head-SHA review verdict (`superpowers-task-reviewer`);
  - the fresh-agent execution over the real backlog;
  - ci-local on the head;
  - the merge and post-check.

## Delivered

`skills/roadmap/references/tree.md`:
- **Momentum bonus:** +50 to a branch when a member's Bead ID appears, as an exact delimited match, in `git log -5 --format='%s%n%b'`.
- **Branch headers:** show `<closed>/<total> completadas, N pendientes`, computed from `bd list --parent <epic-id> --all --json --limit 0`.
- The graph-read commands, scoring, and layout are updated to match.

## Security review

Not triggered. Evaluated paths: `skills/roadmap/references/tree.md` and `reports/a4s-y8f.md`.

## Invariants

- The rest of the score is unchanged.
- The mode stays read-only.
- Placement rules are unchanged.
- Markdown only.
- `SKILL.md` is untouched.

## Process

- Implementer: native `superpowers-mechanical-implementer`.
- Report: `.superpowers/roadmap/reports/a4s-y8f-implementer.md`.
- The implementer ran ci-local: 19/19.
