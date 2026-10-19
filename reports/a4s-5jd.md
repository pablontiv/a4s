# a4s-5jd — Pyright typing in the Superpowers adapter test

- **Bead:** `a4s-5jd`
- **Candidate SHA:** `7fc8a9fc3dd5691d850d6bc258ef7319f3bc363e`
- **Verdict:** pass (pre-review). The following are appended to the Bead notes at closure:
  - the head-SHA review verdict (`superpowers-task-reviewer`);
  - ci-local on the head;
  - the merge and post-check.

## Delivered

`test/test_superpowers_claude_code_agents.py` narrows `canonical_tools_str` to `str` before `map_tools`. A non-`str` value calls `self.fail(...)`, which is `NoReturn`, so Pyright narrows the type and the test fails loudly.

The implementer's first attempt (`e13f21b`) silently replaced a non-`str` value with `""`. The controller replaced that fallback with `self.fail`, because a silent default weakens the tools-mapping invariant.

## Acceptance

| Criterion | Result |
| --- | --- |
| Pyright reports no error in the file | pass: `0 errors, 0 warnings, 0 informations`. Before: 1 error at 116:58, `object` not assignable to `str` |
| The test passes 5/5 | pass: `Ran 5 tests … OK` (`unittest discover -s test -p test_superpowers_claude_code_agents.py`) |
| Negative proof: altering an adapter body in a disposable copy still fails | pass: appending `tamper` to `claude-code/superpowers-debugger.md` gives `AssertionError … risks\ntamper\n' != …` and `FAILED (failures=1)` |
| `test/ci-local.sh` green | pass: 19/19 |

Extra negative check: turning the canonical `tools` into a YAML list in a disposable copy also fails (`FAILED (failures=1)`). The manual frontmatter parser yields `""` for that key, so the tools assertion catches it.

## Invariants

The test still verifies:
- the exact adapter set;
- name and description;
- the tools mapping;
- the byte-for-byte body identity.

It still uses stdlib only. Adapters and the tools mapping logic are untouched.

## Security review

Not triggered. Evaluated paths: `test/test_superpowers_claude_code_agents.py`, `reports/a4s-5jd.md`.

## Process

- Implementer: `superpowers-mechanical-implementer` (`.superpowers/roadmap/reports/a4s-5jd-implementer.md`).
- The controller's bounded fix is `7fc8a9fc3dd5691d850d6bc258ef7319f3bc363e`.
- The disposable copies were deleted.
- Delivery: PR with autonomous merge under ADR 0047. CI is billing-blocked (`a4s-1cy`, `Delivery-Override: ci-billing`).
