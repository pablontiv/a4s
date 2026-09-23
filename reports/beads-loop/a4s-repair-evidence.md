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

### Fix round 2: domain evidence and completed mutations

The second fix round broadened evidence discovery to each Bead's actual code, tests, documentation, ADR and operational domain. That research closed all seven prior gaps. It also applied the five source-complete descriptions that fix round 1 had left unchanged after its serial stop, so all 12 remaining lint targets were repaired.

Every criterion inserted in this round maps to the following exact evidence:

| ID | Pre-mutation revision | Criterion source(s) | Outcome |
| --- | --- | --- | --- |
| `a4s-3nf` | `-5952035839008759337` | `skills/herdr/scripts/README.md` §§ `Tick`, `Mission Control safety gate`, `Usage`, and `Tests`, plus `skills/herdr/SKILL.md` § `Heartbeat H2`, at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad`, define the current deterministic reconciler, its MC gate, opt-in dispatch, in-progress/redispatch/result harvest, protected reaper, AttentionTickets, dry-run default, and external launchd/cron executor. The complete `skills.herdr.tests.test_reconcile` suite passed 70 tests in this round. | Repaired; revision `2745290661909174667`. |
| `a4s-5ib` | `-6380434537460906507` | Responsiveness criterion: canonical `.workspace/docs/history/handbook/superpowers/specs/2026-09-09-firstmate-factory-recipe.md` § `3. Native execution and parallelism` says to keep the user-facing session responsive and not let blocked work block unrelated work. Response-content criterion: approved `.workspace/docs/history/handbook/superpowers/specs/2026-09-08-mission-control-attention-panel-design.md` §§ `Panel content` and `Update rules` require project, owner, last confirmed state, evidence, next event, and prohibit treating `SENT` as completion. Both are reachable at commit `352cf858b99b9f5d39f42822edafcd5382df6086`; accepted ADR 0010 assigns responses to Mission Control. | Repaired; revision `-313190083871522988`. |
| `a4s-9s2` | `5464860455960945591` | Priority/responsiveness criterion: the same canonical Firstmate recipe § `3. Native execution and parallelism`, reachable at `352cf858b99b9f5d39f42822edafcd5382df6086`. Status representation and `SENT` boundary: the same approved Mission Control attention-panel design §§ `Panel content` and `Update rules` at that commit. | Repaired; revision `5697938358105022875`. |
| `a4s-tvz` | `-9142887585499206718` | Global-status shape: approved Mission Control attention-panel design §§ `Panel content` and `Update rules`, commit `352cf858b99b9f5d39f42822edafcd5382df6086`, requires one entry per followed work item or pending decision, the five named fields, and no Factory backlog mirror. Observed-state criterion: target `notes` record the stale-MC diagnosis; this round's read-only `python3 skills/herdr/scripts/a4s-reconcile --dry-run --repo [REDACTED:shared-root]/harness/a4s --callback ''` snapshot reported `in_progress=18 ready=38 ... closed-with-tab=6`, `MC-GATE ... CLOSED (STALE)` because lease `a4s-t9p.1` expired and pane `w4R:p1` was absent, then `planned=0 tickets=0 errors=0`. | Repaired; revision `7559428759774017701`. |
| `a4s-28t` | `-4846720740054081192` | Reaper selection/guard criterion: `skills/herdr/scripts/a4s-reconcile` functions `reap` and `reap_blocker` and `skills/herdr/scripts/README.md` tick action 3 at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad`. Exact regression tests `test_reaper_closes_finished_tab_but_respects_guards` and `test_reaper_never_closes_mc_tab` passed, as did all 70 tests in that module. Snapshot criterion: the same read-only probe observed six `closed-with-tab` candidates and a stale MC gate with zero planned mutations. | Repaired; revision `-6989615357330725953`. |
| `a4s-r25` | `-6803447774151017375` | Plugin/timer boundary criterion preserves target `notes` exactly: event-driven plugin capabilities do not replace stale timer, Beads-change, sandbox, or durable MC-owner heartbeat concerns. Current-boundary criterion: `skills/herdr/scripts/README.md` opening and `Usage` at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad` specify launchd/cron and never an agent; `skills/herdr/scripts/dev.a4s.reconcile.plist` at reachable commit `7a0810cbd725f0249c277cbfbc35e8ef3df3eedf` is explicitly a template with `StartInterval=45` and passed `plutil -lint`. Read-only `herdr --help` exposed built-in `integration` commands but no top-level plugin command. | Repaired; revision `-1796055027803981982`. |
| `a4s-pgm` | `4137852468358179466` | Default-policy and no-op `--once` criteria come from the target `description`; the defect is independently visible in ref-reachable branch commit `2a3fd4d` at `skills/herdr/scripts/dispatch-reconcile` lines 43–55, 214–233, and 290–309. Workspace criterion is stated in the target and implemented by the current `skills/herdr/scripts/a4s-reconcile::resolve_workspace` at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad`: it calls `herdr workspace list`, matches repo basename, and requires exactly one result. Current `--help` exposes no `--once` no-op. | Repaired; revision `-3564390277153843801`. |
| `a4s-3ix` | `-7250169819373921645` | Target `notes` state `worker → orquestador, nunca worker → Human Operator`; `skills/herdr/SKILL.md` § `Worker escalation — orchestrator_target only` and `skills/herdr/tests/test_reconcile.py::test_prompt_routes_escalations_to_the_target_only_and_forbids_human_and_mc` at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad` define and test the exact no-fallback route. | Repaired; revision `-6594344256378060278`. |
| `a4s-9uw` | `-7612795570920970542` | Target `notes` require receipt time and start time. `skills/herdr/SKILL.md` § `Task acknowledgement — TASK_ACK / TASK_STARTED`, `skills/herdr/helper/task_ack.py`, and `skills/herdr/tests/test_task_ack.py` at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad` define the exact receipt/start fields, ordering, correlation, and idempotency; all 29 `test_task_ack` tests passed in this round. | Repaired; revision `8904298162167867389`. |
| `a4s-w2c` | `-8237609982204144402` | Target `description` supplies both the trigger (`list(target_model)` sends punctuation as key tokens) and the bounded alternatives (named-key mapping or paste/literal entry). Ref-reachable commit `2a3fd4d`, `skills/herdr/scripts/dispatch-reconcile::send_model_switch`, independently shows the character-list implementation. | Repaired; revision `3532945868074470212`. |
| `a4s-1to` | `-454677210295099523` | Target `description` `## Design` supplies event teardown after callback/verdict and an OS-scheduled fail-closed dry-run orphan reaper; `## Constraints` keeps worktree/branch/PR lifecycle in `sweep`. Current `a4s-reconcile::reap` and its passing reaper tests at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad` independently implement the tab-side boundary. | Repaired; revision `9023941305896097436`. |
| `a4s-q2y` | `-1299548843390035892` | Target `description` supplies the absolute-path join trigger/result and explicitly requires a repo label/basename. Current `a4s-reconcile::resolve_workspace` at reachable commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad` independently uses `os.path.basename(ctx.repo.rstrip('/'))`. | Repaired; revision `-1621823523259785249`. |

For each update, all 12 remaining targets were re-read first (144 pre-update reads). Each full body came from a temporary regular file and was applied only with `bd update "$ID" --body-file "$DESCRIPTION_FILE" --json`; immediate read-back proved the only changed fields were `description`, Beads-managed `revision`, and `updated_at`.

| ID | Revision before → after | Body SHA-256 |
| --- | --- | --- |
| `a4s-3nf` | `-5952035839008759337` → `2745290661909174667` | `278b4a0d12bc4f0dd29255738660701527ca2f04beb466d999c40a3a189f0f21` |
| `a4s-5ib` | `-6380434537460906507` → `-313190083871522988` | `0ae5f1a5ab864c3c93ac898d8a8818903832dfab96d7604881f07ccdffd14a27` |
| `a4s-9s2` | `5464860455960945591` → `5697938358105022875` | `efdadbc3d30c892fb937bea6bd1290f5f63f7fe02a1aa47b090d32e23e23a436` |
| `a4s-tvz` | `-9142887585499206718` → `7559428759774017701` | `f6495a8e2c679d5f627658aec8370843f2d4c0a6c19e364a867a17018b2074cf` |
| `a4s-28t` | `-4846720740054081192` → `-6989615357330725953` | `4988e1e0adf0e6eb859917b4bb40aae14061d968f413de3952383a7cf807e9e6` |
| `a4s-r25` | `-6803447774151017375` → `-1796055027803981982` | `5c5de2bad195323c3fdcb578b9bb22c355e349310f5853af3b656d42b71e9b60` |
| `a4s-pgm` | `4137852468358179466` → `-3564390277153843801` | `9316fae4ab6ea4f566a5d85658a012c228d905b0f4d7e1dc32285447b9cdbf4f` |
| `a4s-3ix` | `-7250169819373921645` → `-6594344256378060278` | `65e6a53cbaed90488f1e1483ec3c7c47e387f33b34bf3decbe98ad854b52b693` |
| `a4s-9uw` | `-7612795570920970542` → `8904298162167867389` | `11f66fa22d3a54ddaa24abdf0f36a218911d17e9a9833cd4a1f9e996fca65bee` |
| `a4s-w2c` | `-8237609982204144402` → `3532945868074470212` | `0bc964193ce2143250fd5ba5a552d5ed00c24e1c47edb9a989c06ff1a2590c0f` |
| `a4s-1to` | `-454677210295099523` → `9023941305896097436` | `a1216353a1772f4d14bf7471811fafc068734377edb189cad9d96953fb6fdf41` |
| `a4s-q2y` | `-1299548843390035892` → `-1621823523259785249` | `94fed8ee4eba75559e570e8a1392065f6ee7b42869501dec0e336e22e67336b4` |

## Orphan evidence

### a4s-ya4.11

Closure evidence targets implementation commit `e344c3ec550d2b016b27ad0aa922d51ada7fd3ad` (`e344c3e`) and the repository-relative evidence path `reports/beads-loop/a4s-repair-evidence.md`.

Changed artifacts in the implementation commit:

- `skills/herdr/SKILL.md`
- `skills/herdr/helper/task_result.py`
- `skills/herdr/scripts/README.md`
- `skills/herdr/scripts/a4s-reconcile`
- `skills/herdr/tests/test_reconcile.py`
- `skills/herdr/tests/test_task_result.py`

Historical implementation verification at worktree revision `8e4f2296b14191f6c70aae2ba714909e8d753a2c`:

- `git merge-base --is-ancestor e344c3e HEAD` — exit `0`.
- `git show --stat --oneline e344c3e` — exit `0`; identified commit `e344c3e feat(herdr): TASK_RESULT record gates reconciler harvest-close (a4s-ya4.11)` and the six changed artifacts listed above (`923 insertions`, `34 deletions`).
- `python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v` — exit `0`; `Ran 52 tests in 38.001s`, `OK`.

Live state operation:

- `bd show a4s-ya4.11 --json` — exit `0`; the single returned issue was exactly `a4s-ya4.11`, with precondition `status: "in_progress"`, `assignee: "Pablo"`, and revision `-740097444547002792`.
- The authorized guarded command was executed once:

  ```sh
  bd update a4s-ya4.11 \
    --status closed \
    --if-assignee Pablo \
    --if-status in_progress \
    --append-notes "PASS evidence=reports/beads-loop/a4s-repair-evidence.md commit=e344c3e" \
    --json
  ```

  It exited `0` and returned `status: "closed"`, `assignee: "Pablo"`, and the exact note `PASS evidence=reports/beads-loop/a4s-repair-evidence.md commit=e344c3e`.
- Immediate read-back with `bd show a4s-ya4.11 --json` — exit `0`; it independently returned `status: "closed"`, `assignee: "Pablo"`, the exact evidence note above, revision `-931522777481773440`, and `closed_at: "2026-09-23T19:44:53Z"`.
- No `bd close`, force flag, retry, or mutation of another Bead was used.

## Adapter matrix

Added deterministic contract tests for malformed doctor JSON, failed `prime`, unavailable `ready`, repository change after the prime gate, non-list atomic claim output, unresolved actor, invalid finalization verdict, and `claim_lost` CLI serialization. Each test asserts the returned `Envelope` and the bounded provider-call sequence; no adapter source correction was required.

## Smoke checks

- Prior uncommitted run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print` — exit `0`; final envelope: `{"details":{},"kind":"doctor_failed","schema_version":1}`. Pi loaded the explicit skill and ran only the read-only adapter `prime` gate; the terminal envelope stopped dispatch without selecting or changing work.
- Prior uncommitted run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed` — exit `0`; the bounded PTY observation found `Beads Autonomous Loop` within `4,241` transcript bytes, then sent the required double Ctrl-C. The installed Pi keymap did not exit from those bytes or the Ctrl-D compatibility fallback, so bounded cleanup ended the child with signal `9`; no adapter operation was dispatched in headed mode.
- Recovery run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print` — exit `1`; no final envelope was accepted because the last non-empty stdout line was not JSON. The exact bounded diagnostic was `Pi print probe final stdout line is not JSON.` No claim, update, finalize, or close operation was requested.
- Recovery run: `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed` — exit `0`; `observed='Beads Autonomous Loop' transcript_bytes=4241 exit=-9`. The skill heading was observed before the required double Ctrl-C; bounded cleanup ended the unresponsive child, and no adapter operation was dispatched.

## Validation

### Historical validation retained from repair tasks

- Focused contract tests: 5 passed.
- Additional Task 1 boundary tests: 3 passed.
- Complete adapter suite: `python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v` — 52 passed, 0 failed.
- `python3 -m py_compile skills/beads-loop/tests/smoke_pi_dispatch.py skills/beads-loop/tests/test_beads_loop.py` passed.
- Task 3 fix round 1: 11 description updates; 11 immediate read-backs; 253 pre-mutation target/revision reads. Every direct target diff was limited to `description`, `revision`, and `updated_at`; lint fell to 12 issues / 15 warnings.
- Task 3 fix round 2: 12 description updates; 12 immediate read-backs; 144 pre-update target/revision reads. Every direct target diff was limited to `description`, `revision`, and `updated_at`.
- Domain tests: `python3 -m unittest skills.herdr.tests.test_reconcile -v` — 70 passed; `python3 -m unittest skills.herdr.tests.test_task_ack -v` — 29 passed.
- Read-only runtime evidence: `a4s-reconcile --dry-run` observed the stale MC gate and planned zero mutations; `plutil -lint skills/herdr/scripts/dev.a4s.reconcile.plist` returned `OK`.
- Final repair-task `bd lint`: exit `0`, `✓ No template warnings found (47 issues checked)`.
- Final repair-task read-back: all 12 round-2 records have descriptions at the revisions listed above.
- Repair-task `git diff --check` passed.

### Task 5 fresh acceptance run

The commands below were executed once, in the specified order, from worktree revision `7576108f2b28196e71bb6b4f5a83a3329c2f5ff4`. Output is bounded to the complete result for short commands and the unittest summary for the verbose suite.

1. `bd lint` — exit `0`.

   ```text
   ✓ No template warnings found (47 issues checked)
   ```

2. `bd orphans --json` — exit `0`.

   ```json
   null
   ```

   This does not meet the required exact output predicate `[]`.

3. `bd doctor --check conventions --agent --json` — exit `0`.

   ```json
   {
     "checks": [
       {
         "category": "Conventions",
         "message": "all 47 open issues pass template checks",
         "name": "conventions.lint",
         "status": "ok"
       },
       {
         "category": "Conventions",
         "message": "no issues inactive for 14+ days",
         "name": "conventions.stale",
         "status": "ok"
       },
       {
         "category": "Conventions",
         "message": "no orphaned issues found",
         "name": "conventions.orphans",
         "status": "ok"
       }
     ],
     "overall_ok": true,
     "path": "[REDACTED:shared-root]/harness/a4s",
     "schema_version": 1
   }
   ```

   `overall_ok` is the JSON boolean `true`.

4. `python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v` — exit `0`.

   ```text
   ----------------------------------------------------------------------
   Ran 52 tests in 38.005s

   OK
   ```

5. `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print` — exit `1`.

   ```text
   Pi print probe final stdout line is not JSON.
   ```

   The strict final-line JSON gate was preserved. This failed smoke was not rerun.

6. `python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed` — exit `0`.

   ```text
   observed='Beads Autonomous Loop' transcript_bytes=5711 exit=-9
   ```

7. `rootline validate .workspace/docs/specs/2026-09-23-beads-loop-repair.md -o json` — exit `0`.

   ```json
   {"version":2,"kind":"rootline/validate-batch","results":[{"version":1,"kind":"rootline/validate","path":".workspace/docs/specs/2026-09-23-beads-loop-repair.md","valid":true,"errors":[],"warnings":[]}],"structural":[],"stem_health":[],"drift_warnings":[],"notices":[],"summary":{"total":1,"valid":1,"invalid":0,"errors_count":0,"warnings_count":0,"drift_warnings_count":0,"structural_errors_count":0,"structural_warnings_count":0,"stem_health_errors_count":0,"stem_health_warnings_count":0,"stem_health_info_count":0}}
   ```

8. `git diff --check` — exit `0`; output was silent.

After this report update, `git diff --check` was run again as a pre-commit check; it also exited `0` with silent output.

Fresh read-back: `bd show a4s-ya4.11 --json` — exit `0`. Bounded fields from the single returned record:

```json
{
  "id": "a4s-ya4.11",
  "notes": "PASS evidence=reports/beads-loop/a4s-repair-evidence.md commit=e344c3e",
  "status": "closed",
  "assignee": "Pablo",
  "closed_at": "2026-09-23T19:44:53Z",
  "revision": "-931522777481773440"
}
```

**Acceptance verdict: FAILED.** The first failed predicate is command 2: `bd orphans --json` returned `null`, not the required `[]`, despite exiting `0`. Command 5 is an additional failure because the strict Pi print smoke exited `1`. No Bead was mutated and neither failed gate was relaxed or retried.

## Exceptions

- No description evidence gap remains for the 23-record inventory. The earlier `a4s-3nf`, `a4s-5ib`, `a4s-9s2`, `a4s-tvz`, `a4s-28t`, `a4s-r25`, and `a4s-pgm` exceptions were superseded by fix-round-2 domain research; no criterion was derived from a title alone.
- The initial repository-change test setup consumed only one patched `repository_root` observation because `prime` was mocked. The test was corrected to model the gate's first repository observation and the claim's second observation; `skills/beads-loop/scripts/beads_loop.py` remained unchanged. No retries, provider diagnostics, global selection, second fake provider, or live Bead mutation were introduced.
