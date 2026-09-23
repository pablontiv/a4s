## Inventory

Task 3 captured `bd lint` at worktree revision `ff2b5015f14a939ac4a62203ef4979bb46540629`. It reported 23 issues and 31 warnings:

```text
a4s-cxk.3, a4s-uy7.2, a4s-uy7.1, a4s-uy7, a4s-fm9.1, a4s-qvh,
a4s-fm9, a4s-j11, a4s-6ak.10, a4s-ya4.3, a4s-uy7.3, a4s-3nf,
a4s-5ib, a4s-9s2, a4s-3ix, a4s-9uw, a4s-tvz, a4s-28t, a4s-r25,
a4s-w2c, a4s-1to, a4s-pgm, a4s-q2y
```

| ID | Missing headings | Warning count |
| --- | --- | ---: |
| `a4s-cxk.3` | `## Goal`; `## Findings` | 2 |
| `a4s-uy7.2` | `## Acceptance Criteria` | 1 |
| `a4s-uy7.1` | `## Goal`; `## Findings` | 2 |
| `a4s-uy7` | `## Success Criteria` | 1 |
| `a4s-fm9.1` | `## Acceptance Criteria` | 1 |
| `a4s-qvh` | `## Steps to Reproduce`; `## Acceptance Criteria` | 2 |
| `a4s-fm9` | `## Acceptance Criteria` | 1 |
| `a4s-j11` | `## Acceptance Criteria` | 1 |
| `a4s-6ak.10` | `## Acceptance Criteria` | 1 |
| `a4s-ya4.3` | `## Decision`; `## Rationale`; `## Alternatives Considered` | 3 |
| `a4s-uy7.3` | `## Acceptance Criteria` | 1 |
| `a4s-3nf` | `## Acceptance Criteria` | 1 |
| `a4s-5ib` | `## Acceptance Criteria` | 1 |
| `a4s-9s2` | `## Acceptance Criteria` | 1 |
| `a4s-3ix` | `## Acceptance Criteria` | 1 |
| `a4s-9uw` | `## Acceptance Criteria` | 1 |
| `a4s-tvz` | `## Acceptance Criteria` | 1 |
| `a4s-28t` | `## Acceptance Criteria` | 1 |
| `a4s-r25` | `## Acceptance Criteria` | 1 |
| `a4s-w2c` | `## Steps to Reproduce`; `## Acceptance Criteria` | 2 |
| `a4s-1to` | `## Success Criteria` | 1 |
| `a4s-pgm` | `## Steps to Reproduce`; `## Acceptance Criteria` | 2 |
| `a4s-q2y` | `## Steps to Reproduce`; `## Acceptance Criteria` | 2 |

## Description evidence

All targets were snapshotted with `bd show <id> --json` before any mutation. The following records, in inventory order, had eligible source material for every missing heading encountered before the stop condition:

| ID | Target revision | Missing heading | Exact eligible source |
| --- | --- | --- | --- |
| `a4s-cxk.3` | `410949277455370890` | `## Goal` | Target `description`, beginning `Materializar la superficie canónica decidida...`. |
| `a4s-cxk.3` | `410949277455370890` | `## Findings` | Target `notes`, beginning `PRECONDICION: ADR 0020 NO esta en main...`; these are observations rather than projected acceptance. |
| `a4s-uy7.2` | `-7049661242752543763` | `## Acceptance Criteria` | Target `description`, existing `## Criterios de aceptación` block. |
| `a4s-uy7.1` | `-9116626699638527550` | `## Goal` | Target `description`, existing `## Objetivo` block. |
| `a4s-uy7.1` | `-9116626699638527550` | `## Findings` | Accepted ADR 0025, `.workspace/docs/adr/0025-usar-worktrees-sparse-bajo-workspace.md`, `## Decisión` and `## Consecuencias`, reachable commit `68ca0672520d40a4e44e0e7651ffb3e122d7b65e`. This avoids relabeling the target's prospective criteria as completed findings. |
| `a4s-uy7` | `-4396956084376332440` | `## Success Criteria` | Target `description`, existing `## Criterios de aceptación` block. |
| `a4s-fm9.1` | `-9199166730729342713` | `## Acceptance Criteria` | Target `description` defines the approved role boundary; parent `a4s-fm9` revision `-5373831160250543823`, `description` scope and final `Acceptance:` sentence, supplies the documentation outcome. |
| `a4s-qvh` | `-2927835661368094243` | `## Steps to Reproduce` | Target `description`: the trigger is an `in_progress` Bead with a declared worker but no live agent; Pattern 3 at lines 265–281 writes an AttentionTicket and escalates. |
| `a4s-qvh` | `-2927835661368094243` | `## Acceptance Criteria` | Target `description`, exact bounded outcome choice beginning `Decide: implement auto re-dispatch... or update docs...`. |
| `a4s-fm9` | `-5373831160250543823` | `## Acceptance Criteria` | Target `description`, final `Acceptance:` sentence. |
| `a4s-j11` | `-2813359493568754434` | `## Acceptance Criteria` | Target `design`, exact PoC requirement beginning `PoC: forzar/simular limite...` and the following failover condition. |
| `a4s-6ak.10` | `-5722702302783650683` | `## Acceptance Criteria` | Target `design`, exact `Deliverables:` list `(a)` through `(c)`. |
| `a4s-ya4.3` | `5752151494722383298` | `## Decision` | Parent `a4s-ya4` revision `6426898938080748453`, `description` section `## Decision and sequence`, especially item 3; target `description` `## Scope` bounds the proposed ADR/spec change. |
| `a4s-ya4.3` | `5752151494722383298` | `## Rationale` | Target `description` `## Context`; parent `a4s-ya4` revision `6426898938080748453`, `description` section `## Evidence`. |
| `a4s-ya4.3` | `5752151494722383298` | `## Alternatives Considered` | Accepted ADR 0015, `.workspace/docs/adr/0015-mantener-orquestador-delgado-con-handoffs-por-puntero.md`, `## Alternativas descartadas`, reachable commit `040de9de9b9c4069b70e9f8b0a1c0db69ccc1d19`; its queue alternative cites accepted ADR 0009 at reachable commit `352cf858b99b9f5d39f42822edafcd5382df6086`. |
| `a4s-uy7.3` | `2549885241521080191` | `## Acceptance Criteria` | Target `description`, existing `## Criterios de aceptación` block. |
| `a4s-3nf` | `-5952035839008759337` | `## Acceptance Criteria` | **Evidence gap:** the target has a title only—no `description`, `design`, `notes`, `parent`, or linked records. `git log HEAD -S'a4s-3nf'` finds only commit `35787bb6bdebd2849734ee72d513dc8f47a63f81`, where the ID appears in this repair plan's lint inventory; it contains no acceptance contract. |

**Zero Bead mutations occurred.** No Bead description was mutated. The first missing source in inventory order was `a4s-3nf` / `## Acceptance Criteria`; the fail-closed stop condition therefore prevented all `bd update` calls. Records after `a4s-3nf` were not evaluated for mutation.

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

- **Task 3 bounded content decision:** `a4s-3nf` requires `## Acceptance Criteria`, but revision `-5952035839008759337` contains only the title `Status: versión y capacidades del reconciler actual`. It has no description, design, notes, parent, or linked record. The only reachable commit containing the ID is `35787bb6bdebd2849734ee72d513dc8f47a63f81`, which merely inventories the lint warning. Required operator input: provide or identify the acceptance contract for this status task. No synthetic prose was added, no `bd update` was run, and the embedded lint gate remains unrepaired.
- The initial repository-change test setup consumed only one patched `repository_root` observation because `prime` was mocked. The test was corrected to model the gate's first repository observation and the claim's second observation; `skills/beads-loop/scripts/beads_loop.py` remained unchanged. No retries, provider diagnostics, global selection, second fake provider, or live Bead mutation were introduced.
