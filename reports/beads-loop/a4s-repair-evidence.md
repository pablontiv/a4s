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

Fix round 1 started at reachable revision `e26651b49bb9c6e51e971a66910f5bbbdf15cafb`. Every target was re-read before evidence classification. The table is complete for all 23 targets; “gap” means the required heading cannot be populated from the permitted source classes without inventing a completion contract.

| ID | Pre-mutation revision | Required heading(s) | Exact eligible source or bounded gap | Outcome |
| --- | --- | --- | --- | --- |
| `a4s-cxk.3` | `410949277455370890` | `## Goal`; `## Findings` | Goal: target `description`, beginning `Materializar la superficie canónica decidida...`. Findings: target `notes`, beginning `PRECONDICION: ADR 0020 NO esta en main...`. | Repaired; revision `-3601070862089382564`. |
| `a4s-uy7.2` | `-7049661242752543763` | `## Acceptance Criteria` | Target `description`, exact existing `## Criterios de aceptación` block. | Repaired; revision `-1008961154052703481`. |
| `a4s-uy7.1` | `-9116626699638527550` | `## Goal`; `## Findings` | Goal: target `description`, exact `## Objetivo` block. Findings: accepted ADR 0025, `.workspace/docs/adr/0025-usar-worktrees-sparse-bajo-workspace.md`, exact `## Decisión` and `## Consecuencias` prose, reachable commit `68ca0672520d40a4e44e0e7651ffb3e122d7b65e`. | Repaired; revision `5990236745384002121`. |
| `a4s-uy7` | `-4396956084376332440` | `## Success Criteria` | Target `description`, exact existing `## Criterios de aceptación` block. | Repaired; revision `-7444700761361004514`. |
| `a4s-fm9.1` | `-9199166730729342713` | `## Acceptance Criteria` | Target `description` supplies the role boundary; parent `a4s-fm9` revision `-5373831160250543823` supplies the exact final `Acceptance:` sentence. | Repaired; revision `-8361949971115684424`. |
| `a4s-qvh` | `-2927835661368094243` | `## Steps to Reproduce`; `## Acceptance Criteria` | Target `description`: the first two sentences state the `in_progress`/declared-worker/no-live-agent trigger and Pattern 3 escalation; the `Decide: implement auto re-dispatch... or update docs...` sentence states the bounded accepted outcome. | Repaired; revision `-2160322062475418047`. |
| `a4s-fm9` | `-5373831160250543823` | `## Acceptance Criteria` | Target `description`, exact final `Acceptance:` sentence. | Repaired; revision `7415121194463033748`. |
| `a4s-j11` | `-2813359493568754434` | `## Acceptance Criteria` | Target `design`, including the exact PoC requirement beginning `PoC: forzar/simular limite...` and its failover condition. | Repaired; revision `4035088494396636149`. |
| `a4s-6ak.10` | `-5722702302783650683` | `## Acceptance Criteria` | Target `design`, exact `Deliverables:` list `(a)` through `(c)`. | Repaired; revision `7111154719858939858`. |
| `a4s-ya4.3` | `5752151494722383298` | `## Decision`; `## Rationale`; `## Alternatives Considered` | Decision: parent `a4s-ya4` revision `6426898938080748453`, exact item 3 under `## Decision and sequence`. Rationale: the same parent’s exact `## Evidence` paragraph. Alternatives: accepted ADR 0015 exact `## Alternativas descartadas` paragraph at `.workspace/docs/adr/0015-mantener-orquestador-delgado-con-handoffs-por-puntero.md`, reachable commit `040de9de9b9c4069b70e9f8b0a1c0db69ccc1d19`. | Repaired; revision `1059362296646021972`. |
| `a4s-uy7.3` | `2549885241521080191` | `## Acceptance Criteria` | Target `description`, exact existing `## Criterios de aceptación` block. | Repaired; revision `-123422069437267389`. |
| `a4s-3nf` | `-5952035839008759337` | `## Acceptance Criteria` | **Operator-approved exception:** title only; no `description`, `design`, `notes`, parent, linked record, accepted ADR, or reachable committed acceptance contract. | Unchanged by explicit operator choice. |
| `a4s-5ib` | `-6380434537460906507` | `## Acceptance Criteria` | **New evidence gap and stop condition:** title only; no `description`, `design`, `notes`, parent, or linked record. Accepted ADR 0010 assigns responses/steering to Mission Control but does not define status-query priority or this task’s completion contract. Reachable ID history contains only the repair plan/inventory reports. | Unchanged; stopped all later mutations. |
| `a4s-9s2` | `5464860455960945591` | `## Acceptance Criteria` | **Evidence gap:** title only; no target fields, parent, linked record, accepted ADR, or reachable committed artifact defines the completion contract. Reachable ID history contains only the repair plan/inventory reports. | Read-only evaluation after stop; unchanged. |
| `a4s-3ix` | `-7250169819373921645` | `## Acceptance Criteria` | Target `notes`, exact requirement: `El protocolo debe ser claro: worker → orquestador, nunca worker → Human Operator.` Reachable `skills/herdr/SKILL.md` § `Worker escalation` independently states the same route at commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad`. | Source complete, but after stop; unchanged. |
| `a4s-9uw` | `-7612795570920970542` | `## Acceptance Criteria` | Target `notes`, exact requirements that the receiver acknowledge receipt and the Bead record `(1) cuándo se conoció la tarea (recibido), (2) cuándo se inició`; reachable `skills/herdr/SKILL.md` § `Task acknowledgement` specifies those durable events at commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad`. | Source complete, but after stop; unchanged. |
| `a4s-tvz` | `-9142887585499206718` | `## Acceptance Criteria` | **Evidence gap:** target `notes` record the operator’s question and one historical MC answer, but no required status contents or completion contract; no parent or linked record exists, and reachable ID history contains only repair inventory. | Read-only evaluation after stop; unchanged. |
| `a4s-28t` | `-4846720740054081192` | `## Acceptance Criteria` | **Evidence gap:** target `notes` only record the question `estado del reaper en a4s`; no required answer/evidence or completion contract, parent, linked record, accepted ADR, or reachable committed artifact was found. | Read-only evaluation after stop; unchanged. |
| `a4s-r25` | `-6803447774151017375` | `## Acceptance Criteria` | **Evidence gap:** target `notes` contain an investigation idea and a result/boundary summary, but do not state the criterion by which this still-open task is accepted; no parent or linked record exists and reachable ID history contains only repair inventory. | Read-only evaluation after stop; unchanged. |
| `a4s-w2c` | `-8237609982204144402` | `## Steps to Reproduce`; `## Acceptance Criteria` | Target `description`: `send_model_switch does list(target_model)...` plus the non-letter target example states the trigger/result; `Map special chars... or type the string via a paste/literal mechanism` states the bounded repair. | Source complete, but after stop; unchanged. |
| `a4s-1to` | `-454677210295099523` | `## Success Criteria` | Target `description` `## Design`: event teardown closes the tab after callback/verdict; the orphan reaper is OS-scheduled, fail-closed, and dry-run, while `## Constraints` preserves the `sweep` boundary. | Source complete, but after stop; unchanged. |
| `a4s-pgm` | `4137852468358179466` | `## Steps to Reproduce`; `## Acceptance Criteria` | Steps: target `description` exactly states that `blocked_name_patterns` reads `model_switches.default` while policy exposes top-level `default_switch_target`, so the operator value is ignored. **Acceptance gap:** the same record also bundles unused `--once` and hard-coded workspace IDs but states no bounded accepted outcome for the combined bug. | Read-only evaluation after stop; unchanged. |
| `a4s-q2y` | `-1299548843390035892` | `## Steps to Reproduce`; `## Acceptance Criteria` | Target `description`: joining `Path(state_dir)/'tickets'/repo` with an absolute repo states the trigger/result; `Use a repo label/basename (like a4s-reconcile) instead of the raw abs path` states the bounded repair. | Source complete, but after stop; unchanged. |

### Fix-round mutation proof

For each repaired record, the complete replacement was written to a temporary regular file, applied only with `bd update "$ID" --body-file "$DESCRIPTION_FILE" --json`, and immediately re-read. Before each of the 11 updates, all 23 targets and revisions were freshly re-read (253 pre-mutation reads total). Every direct target comparison changed only `description` plus Beads-managed `revision` and `updated_at`; expanded dependency snapshots changed only where a referenced repaired record changed.

| ID | Revision before → after | Body SHA-256 |
| --- | --- | --- |
| `a4s-cxk.3` | `410949277455370890` → `-3601070862089382564` | `7d2636564b36ace1c61a11d6ef2752129511ac1a35a1143229835f0a08737a17` |
| `a4s-uy7.2` | `-7049661242752543763` → `-1008961154052703481` | `15697a880735c99ac351b9bb53e955c5dd6016f4a965e3572493f2d5678d259b` |
| `a4s-uy7.1` | `-9116626699638527550` → `5990236745384002121` | `00d380ef32beb9d4774f5180b7a6eed3ae020dff6348d88b291f255df3a53555` |
| `a4s-uy7` | `-4396956084376332440` → `-7444700761361004514` | `d88fb4f5b2e6ec3c98ea6f5632c7fa546ba1da27bbc6f733cce1d901300d3327` |
| `a4s-fm9.1` | `-9199166730729342713` → `-8361949971115684424` | `0acd972b294d5eaa9fa57bd0fbac4cb2af0a646f2b97bbdec42f78062e969304` |
| `a4s-qvh` | `-2927835661368094243` → `-2160322062475418047` | `f1fc9d087c2ef2fb7b9cb4822763ae075c1b3ee6dccc3b2c2d414f8a785713bf` |
| `a4s-fm9` | `-5373831160250543823` → `7415121194463033748` | `d19d753e99938be4576c6bfcc4bf899690c0ada43325ad08fcf55f8d2816616f` |
| `a4s-j11` | `-2813359493568754434` → `4035088494396636149` | `3d7f1fd9a8ef91fd89ba16420adb0db65bbdb9ef6c8ed6d866faa87993c5d843` |
| `a4s-6ak.10` | `-5722702302783650683` → `7111154719858939858` | `8945e675202e2912be6f2386cc7ea150f422d50519b33997a220610f264177f5` |
| `a4s-ya4.3` | `5752151494722383298` → `1059362296646021972` | `4b4bbc3a0223b0e3e3f854bf81f3b2c61586f9a2e041ca3a9dca3883262f373d` |
| `a4s-uy7.3` | `2549885241521080191` → `-123422069437267389` | `6030719b5f3654bb5a8effeeaaddac354b30fad1500b8a3d59aee40ca3cdee9d` |

`a4s-3nf` remained exactly unchanged at revision `-5952035839008759337`. `a4s-5ib` was the next new source gap; per the binding stop rule, no record after it was mutated.

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
- Task 3 fix round: 11 description updates; 11 immediate read-backs; 253 pre-mutation target/revision reads. Every direct target diff was limited to `description`, `revision`, and `updated_at`.
- Final `bd lint`: exit `1`, reduced from 23 issues / 31 warnings to 12 issues / 15 warnings. The embedded lint gate is explicitly not claimed repaired.
- Final state proof: `a4s-3nf` and all records from `a4s-5ib` onward exactly match their fix-round pre-mutation snapshots.
- `git diff --check` passed.

## Exceptions

- **Approved exception:** `a4s-3nf` remains unchanged at revision `-5952035839008759337` by operator decision. Its title-only record still lacks an allowed acceptance source; no synthetic prose was added.
- **New blocking source gap:** `a4s-5ib` remains unchanged at revision `-6380434537460906507`. It is title-only, and neither accepted ADR 0010 nor reachable committed artifacts define status-query priority or a completion contract. This triggered the required stop; no later Bead was mutated.
- Read-only completion of the all-ID inventory found additional acceptance gaps in `a4s-9s2`, `a4s-tvz`, `a4s-28t`, `a4s-r25`, and `a4s-pgm`. Later records `a4s-3ix`, `a4s-9uw`, `a4s-w2c`, `a4s-1to`, and `a4s-q2y` have complete sources but were intentionally left unchanged because they occur after the `a4s-5ib` stop condition.
- The initial repository-change test setup consumed only one patched `repository_root` observation because `prime` was mocked. The test was corrected to model the gate's first repository observation and the claim's second observation; `skills/beads-loop/scripts/beads_loop.py` remained unchanged. No retries, provider diagnostics, global selection, second fake provider, or live Bead mutation were introduced.
