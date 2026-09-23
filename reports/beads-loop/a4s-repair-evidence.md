## Inventory

Task 1 covers the existing deterministic Beads adapter and its single `FakeBd` provider fixture. No live Bead records were read or changed.

## Description evidence

No description or provider-state changes were made by this task.

## Orphan evidence

No orphan inspection was performed; it is outside Task 1 scope.

## Adapter matrix

Added deterministic contract tests for malformed doctor JSON, failed `prime`, unavailable `ready`, repository change after the prime gate, non-list atomic claim output, unresolved actor, invalid finalization verdict, and `claim_lost` CLI serialization. Each test asserts the returned `Envelope` and the bounded provider-call sequence; no adapter source correction was required.

## Smoke checks

No live or smoke check was added by this task.

## Validation

- Focused contract tests: 5 passed.
- Additional Task 1 boundary tests: 3 passed.
- Complete adapter suite: `python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v` — 49 passed, 0 failed.
- `git diff --check` passed.

## Exceptions

The initial repository-change test setup consumed only one patched `repository_root` observation because `prime` was mocked. The test was corrected to model the gate's first repository observation and the claim's second observation; `skills/beads-loop/scripts/beads_loop.py` remained unchanged. No retries, provider diagnostics, global selection, second fake provider, or live Bead mutation were introduced.
