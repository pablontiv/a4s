# a4s-4im — Scoped loop (`loop <id>`)

- **Bead:** `a4s-4im` (epic `a4s-ann`)
- **Candidate SHA:** `424d6b8d643a6ceb02878c6b30c0b2ce07d640a6`
- **Verdict:** pass (pre-review; the controller found a router defect after the first APPROVE, and the bounded fix commit follows the candidate). The following are appended to the Bead notes at closure:
  - the head-SHA review verdict (`superpowers-task-reviewer`);
  - the result of the fresh-agent pressure scenario;
  - ci-local on the head;
  - the merge and post-check.

## Delivered

- `skills/roadmap/SKILL.md`: routing accepts `loop <id>` with exactly one ID and rejects other `loop` forms.
- `skills/roadmap/references/loop.md` §1.1 covers:
  - scope validation: the ID must exist and be an epic or a task, otherwise rejected before any mutation;
  - frontier calculation over the epic's direct children, or over the single task;
  - drift, validation, and stop conditions evaluated only inside the scope.
- `skills/roadmap/README.md`: documents the command.

## Invariants

- Bare `loop` is unchanged.
- An epic is never executed.
- The scope frontier uses the same tree recipe.
- Markdown only.
- `metadata.updated` is 2026-09-24.

## Process

- Implementer: native `superpowers-integration-worker`.
- Report: `.superpowers/roadmap/reports/a4s-4im-implementer.md`.
- The implementer ran ci-local.sh: 19/19.
