# a4s-mka — Sizing and vocabulary guidance in plan

- **Bead:** `a4s-mka` (epic `a4s-ann`)
- **Candidate SHA:** `7310837da0985a25f175dc1bd44e3cf415df10df`
- **Verdict:** pass (pre-review). The following are appended to the Bead notes at closure:
  - the head-SHA review verdict (`superpowers-task-reviewer`);
  - ci-local on the head;
  - the merge and post-check.

## Delivered

`skills/roadmap/references/plan.md` gains a "Sizing and vocabulary" section:
- epic vs. direct tasks, with Rootline scale ranges: 1–5 direct, 6–20 under an epic, 20+ split by objective;
- one session per task;
- a vocabulary table mapping Outcome, objective, feature, spike, bug, chore, and decision to `epic` or `task`.

The section cites Rootline Roadmap (`b0fe817^`): `framework-reference.md` "Escala" and `autonomous-mode.md` "Normalizar vocabulario".

## Security review

Not triggered. Evaluated paths: `skills/roadmap/references/plan.md` and `reports/a4s-mka.md`.

## Invariants

- Only `epic` and `task`.
- Plan gates and recipe steps 1–10 are unchanged.
- No contradiction with `contracts.md`.
- Markdown only.
- `SKILL.md` is untouched.

## Process

- Implementer: native `superpowers-mechanical-implementer`.
- Report: `.superpowers/roadmap/reports/a4s-mka-implementer.md`.
- The implementer ran ci-local: 19/19.
