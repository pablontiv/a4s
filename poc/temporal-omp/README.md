# Temporal/OMP decision probes

These six slices retain reusable code and observed evidence for the provisional Temporal/OMP design. They are not a production controller, deployment, or end-to-end acceptance gate. The canonical contract and live roadmap are in [execution architecture](../../docs/architecture/execution-architecture.md).

## Evidence entrypoint

[`evidence-index.json`](evidence-index.json) is the portable manifest. All indexed paths are relative to the repository root, not this directory. `selectedPaths` is the fixed external-summary input accepted by the objective runner; `slices` records exact commands, versions, source provenance, results and limits. `pendingAcceptance` remains separate from completed probe evidence. A probe passing does not discharge its native-host or productive-readiness boundaries.

Each `selectedPaths` entry has `name`, `path`, `expectedScenario`, optional
`references` (retained as source bytes), optional `expectedBinding`, and optional
`expectedAcceptance` (`accepted` by default). Accepted summaries must have a real
`observedAt`, matching `scenario`, observed `result`, and nonempty `limitations`;
the validator also understands `evidence`/`scenarios` arrays. Completed SQLite
restart evidence requires both phases. `reported` can retain an honest incomplete
observation but is not accepted completion evidence; this index selects completed
proof scenarios and keeps unmet native acceptance separately visible. The runner
copies selected files, inventories their bytes/schema/digests, then independently
rereads them; it does not rerun the independent experiments or authenticate an
arbitrary producer's completion claim as a full repository gate.

| Slice | Reusable artifacts | Evidence scope |
| --- | --- | --- |
| [SQLite](sqlite/README.md) | Official server configuration, private runtime launcher, SDK workflow/activity and history observer | Binary/SQLite operation and the specifically recorded restart observations; not deployment, backup or HA. |
| [OMP compatibility](omp/README.md) | Real interactive extension, self-contained deployment build, prebuilt worker bundle preparation, correlated native task receipt | Passed minimal synchronous UI→nextTurn→main task→result→workflow smoke inside the official compiled OMP 18.16.0 binary using self-contained bundles; the earlier npm OMP + Bun 1.4.4 pass is history. Async/context/reload/crash and gate interoperability remain pending. |
| [Objective](objective/README.md) | Finite objective workflow, command activities, fixed retained-evidence inventory/validator | Independent successor execution while another item blocks; command bootstrap, not native OMP acceptance. |
| [Native objective](native-objective/README.md) | Mandate-derived objective workflow on the compiled OMP extension worker, durable SQLite handoff controller, binding-exact native receipts, separate command worker, stage reconciler | Passed native succession (two dependent native `task` items, independent command, named blocker) across turn end, committed `session_compact` and same-version `/restart` while pending. Not dispatch-time crash/child loss, async completion, self-update or Git-bound authority. |
| [Safety](safety/README.md) | Typed receipt validation, adapted dispatch claims/fences, read-only Git reconciliation | Real local Git push/result loss, rejection and fencing cases; not an atomic distributed Git fence. |
| [Ownership](ownership/README.md) | SQLite lease/generation authority, process-loss scenarios and `receipt-gate.mjs` | Generic owned processes plus Safety validation inside transactional current-generation local acceptance; Git observation is outside that transaction, not OMP supervisor recovery or atomic external fencing. |
| [Update](update/README.md) | Version-bound workflow workers, retained actual bundles and update scenarios | Compatible actual workflow/code-version continuation only; not native extension self-update or arbitrary incompatible replay. |

Do not recreate historical temporary probes simply to obtain new files. Use each slice's retained evidence and source hashes; runtime paths inside old reports are historical context, not prerequisites for reading the checked-in summaries.

## First supported dogfood use

The first use is **`command_activity` retained-evidence validation only**. Main admits the fixed completed summaries into the real objective workflow, which inventories and independently rereads their retained artifacts. The unsupported native-host item stays blocked. This is useful roadmap work under explicit bootstrap authority, not an autonomous native engineering objective or an integrated candidate→merge→gate→push claim.

From the repository root, with the indexed dependencies installed and the authorized SQLite server already running:

```sh
OBJECTIVE_SELECTED_PATHS="$(node -p 'JSON.stringify(require("./poc/temporal-omp/evidence-index.json").selectedPaths)')" node poc/temporal-omp/objective/runner.mjs
```

`TEMPORAL_ADDRESS` defaults to `127.0.0.1:17233`; `TEMPORAL_NAMESPACE` defaults to `default`. Use a new `OBJECTIVE_WORKFLOW_ID` and evidence directory for each admission. Main owns execution and server lifetime.

**Observed first use:** Main ran the command above successfully (exit 0, 14.36 s).
The [actual summary](objective/evidence/objective-proof-1793841268520/summary.json)
and [service-fetched history](objective/evidence/objective-proof-1793841268520/history.json)
record six selected completed summaries: SQLite, objective, safety, ownership,
connected receipt gate and update. Inventory and dependent independent validation
completed with 53 history events, 6 state transitions and 17 live queries, while
`native-host-not-admitted` remained blocked. The owned worker stopped. This proves
the retained-evidence command use, **not native OMP acceptance or an integrated
engineering gate**. The run's retained `selected-paths.json` is the authoritative
selection snapshot even if the live index later acquires native proof.

This run checked 32 retained files. Its copies and inventory digests describe the
bytes admitted then; later ownership fixes or new native evidence do not
retroactively enter that run. Current module correctness/idempotency still needs
its own targeted evidence, and a later admission must retain its own snapshot.

**Latest corrected admission:** Main reran the same command after receipt-gate
deduplication and mandate-binding corrections: exit 0 in 13.36 s. The
[latest actual summary](objective/evidence/objective-proof-1793841461459/summary.json)
and [history](objective/evidence/objective-proof-1793841461459/history.json)
retain all six current selections, 53 events, 6 transitions and 16 queries. The
native-host obligation stayed blocked and the owned worker stopped. This supersedes
the initial snapshot for current evidence validation, not for native acceptance.

**Final all-slice admission:** Main admitted seven summaries covering all six
slices, now including the completed minimal native-host report: exit 0 in 13.50 s.
The [final summary](objective/evidence/objective-proof-1793842176637/summary.json)
and [history](objective/evidence/objective-proof-1793842176637/history.json)
record 53 events, 6 transitions and 17 queries; the owned worker stopped.
`nativeHostProof:false` remains correct for this admission: it validates the
independent native report but does not execute the native path. The native-host
item remains blocked, and no integrated engineering-gate claim follows.

**Runtime handoff:** the owned SQLite server is now **stopped**, not a live
endpoint. After the final consumers finished, PID 57795 received SIGTERM and
exited 0; [runtime evidence](sqlite/runtime-evidence.json) records the final stop.
The private databases/download cache remain at
`/tmp/a4s-temporal-sqlite.jcPWbdmy`. Use the exact restart command in
[SQLite README](sqlite/README.md) before another local admission; other machines
must install their own private runtime rather than depend on that temporary path.

Next reuse command validation for supported evidence work, and connect the proven
compiled-host synchronous native handoff to an authorized bounded objective with
source/SHA-bound receipt authority. Prove automatic succession and missing async,
context/reload boundaries before expanding authority; minimal native proof alone
does not authorize native integration/publication.

## Binding and authority limits

The safety receipt's `revision` is the actual 40-hex Git commit SHA observed locally and at its local bare remote. Numeric `revision: 1` values in independent Temporal/objective experiments are experiment sequences, **not Git candidate bindings**. Source SHA-256 hashes identify the bytes exercised; they do not convert an experiment counter into a Git approval or prove the enclosing dirty working tree equals a committed source revision. Do not join these independent bindings into an end-to-end gate.

Final ProbeReview reported **pass with limits**, with no actionable defect or
source-hash mismatch. The native receipt smoke uses substring correlation, not
ownership binding-field/schema equality; its summarizer's marker/runtime strings
were not independently rechecked. Local receipt deduplication is enforced by
transactional logic, not a SQL unique constraint. These limits remain distinct
from the independent seven-summary dogfood pass, which is not an operational gate.

Native objective succession across turn end, context rotation and same-version `/restart` while a handoff is pending has its own observed proof in [native-objective](native-objective/README.md). Async completion, crash-safe OMP session ownership after dispatch and safe autonomous extension self-update still require their own evidence. Productive systemd operation, consistent SQLite backup/restore, sustained Audit/Implement/Combined acceptance and revision-bound integration/publication remain separately gated. No remote default-branch switch or deployment is authorized here.
