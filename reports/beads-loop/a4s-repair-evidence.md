## Inventory

Task 1 covers the existing deterministic Beads adapter and its single `FakeBd` provider fixture. No live Bead records were read or changed.

## Description evidence

No description or provider-state changes were made by this task.

## Orphan evidence

No orphan inspection was performed; it is outside Task 1 scope.

## Adapter matrix

Added deterministic contract tests for malformed doctor JSON, failed `prime`, unavailable `ready`, repository change after the prime gate, non-list atomic claim output, unresolved actor, invalid finalization verdict, and `claim_lost` CLI serialization. Each test asserts the returned `Envelope` and the bounded provider-call sequence; no adapter source correction was required.

## Smoke checks

- Prior uncommitted run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print` — exit `0`; final envelope: `{"details":{},"kind":"doctor_failed","schema_version":1}`. Pi loaded the explicit skill and ran only the read-only adapter `prime` gate; the terminal envelope stopped dispatch without selecting or changing work.
- Prior uncommitted run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed` — exit `0`; the bounded PTY observation found `Beads Autonomous Loop` within `4,241` transcript bytes, then sent the required double Ctrl-C. The installed Pi keymap did not exit from those bytes or the Ctrl-D compatibility fallback, so bounded cleanup ended the child with signal `9`; no adapter operation was dispatched in headed mode.
- Recovery run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print` — exit `1`; no final envelope was accepted because the last non-empty stdout line was not JSON. The exact bounded diagnostic was `Pi print probe final stdout line is not JSON.` No claim, update, finalize, or close operation was requested.
- Recovery run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed` — exit `0`; `observed='Beads Autonomous Loop' transcript_bytes=4241 exit=-9`. The skill heading was observed before the required double Ctrl-C; bounded cleanup ended the unresponsive child, and no adapter operation was dispatched.

## Validation

- Focused contract tests: 5 passed.
- Additional Task 1 boundary tests: 3 passed.
- Complete adapter suite: `python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v` — 52 passed, 0 failed.
- `python3 -m py_compile skills/beads-loop/tests/smoke_pi_dispatch.py skills/beads-loop/tests/test_beads_loop.py` passed.
- `git diff --check` passed.

## Exceptions

The initial repository-change test setup consumed only one patched `repository_root` observation because `prime` was mocked. The test was corrected to model the gate's first repository observation and the claim's second observation; `skills/beads-loop/scripts/beads_loop.py` remained unchanged. No retries, provider diagnostics, global selection, second fake provider, or live Bead mutation were introduced.
