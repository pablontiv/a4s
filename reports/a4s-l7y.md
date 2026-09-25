# a4s-l7y — Selective security review in the loop

- **Bead:** `a4s-l7y` (epic `a4s-ann`)
- **Candidate SHA:** `4719665e07a9e4bd07b96b6ce22a22133397c0cd`
- **Verdict:** pass (pre-review). The following are appended to the Bead notes at closure:
  - the head-SHA review verdict (`superpowers-task-reviewer`);
  - ci-local on the head;
  - the merge and post-check.

## Delivered

`skills/roadmap/references/loop.md`:
- **§3 pipeline:** gains "selective security review (if triggered)".
- **§3.1 trigger:** a case-insensitive literal match of `secret`, `credentials`, `.env`, `auth`, or `crypto` in any `git diff --name-only <base>...HEAD` path, or an explicit request in the task contract.
- **§3.1 when triggered:** a fresh security reviewer runs on the head SHA; a HIGH finding blocks closure and autonomous merge (stop condition 5).
- **§4 evidence:** records whether the review was triggered; if it was, the verdict and findings; if not, the evaluated paths.

## Security review

Not triggered. Evaluated paths: skills/roadmap/references/loop.md, plus `reports/a4s-l7y.md`.

## Invariants

- The general task review is unchanged.
- The security review is additive.
- One task at a time.
- Markdown only.
- `SKILL.md` is untouched.

## Process

- Implementer: native `superpowers-mechanical-implementer`.
- Report: `.superpowers/roadmap/reports/a4s-l7y-implementer.md`.
- The implementer ran ci-local: 19/19.
