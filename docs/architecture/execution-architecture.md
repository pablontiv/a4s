# Objective-driven execution architecture

## Status and authority

This document is the canonical **normative target**, not a description of a
completed implementation or a claim of deployed acceptance. MUST and MUST NOT
identify required behavior; SHOULD identifies a default requiring justification
when changed. Initial productive operation on SQLite is the planning baseline.
Formal engine and placement adoption remains open; Temporal with an OMP extension
is the provisional recommendation. Actual provisioning and deployment still
require authorization; none is enacted by this document.

**Dagu is not used.** Its code and lifecycle documents are historical reference,
not an installed execution authority or an operational migration source. There
is no Dagu backup, drain, migration, shutdown or shutdown-validation work in this
roadmap, and reduced Dagu is not a fallback target. Reuse applicable repository
gate contracts without carrying forward the old orchestration graph.

`main` is the development line of this architecture. The previous line is
preserved in the `legacy2` branch. The roadmap and branch decisions in
[omp-temporal.md](omp-temporal.md) take precedence over this document.

The primary outcome is sustained completion of an authorized objective across
work items without repeated operator prompts. Recovery supports that outcome;
recreating every existing recovery mechanism is not the selection criterion.
This contract introduces no CLI, configuration schema or package API.

## Objective and authorization

An objective MUST identify its repository, desired outcome, observable acceptance
checks, finite work-selection rule, permissions and stopping conditions.
Selection MUST be a fixed snapshot or explicitly bounded intake with an end
condition; a changing issue filter alone is not a finite mandate.
The mandate MUST distinguish read-only audit, ticket publication, implementation,
integration and publication permissions, including any required approvals.

Findings, issue text, tool output and agent proposals are data, not authority.
Audit findings may become tickets only when publication is authorized and the
required review accepts the exact proposed units. Authorization to audit or
publish tickets MUST NOT implicitly authorize their implementation.
Combined audit-to-implementation work requires that whole chain in the mandate.
Changed scope, permissions or acceptance obligations require an attributed
operator decision; the controller MUST NOT silently expand them.

The run record MUST retain the mandate, selected items, dependencies, acceptance
obligations, policy version, decisions and outcome evidence. New intake consumes
the authorized bound. Deduplication MUST prevent the same accepted finding from
creating repeated tickets or repeated implementation obligations on redelivery.

## Logical responsibilities and placement

These are capabilities, not mandatory processes, packages or SDK boundaries:

| Capability | Responsibility |
| --- | --- |
| Objective policy | Own scope, permissions, selection, dependencies, acceptance and stop rules. |
| Application controller | Admit, synchronize, materialize, dispatch, reconcile evidence and select successors until terminal. |
| Execution engine | Supply scheduling, concurrency, timers, waits and execution-state facilities. |
| Harness integration | Deliver assignments/results, enforce tool permissions, translate events and expose operator interaction. |
| Git and issue integrations | Observe external state and perform authorized effects with attributable evidence. |

There MUST be exactly one authoritative decision owner for each transition.
An engine workflow may encode domain transitions and host the controller.
An extension may host the controller, including next-item selection and dispatch,
if its lifecycle can satisfy this contract. Another process may do so instead.
Colocation is allowed; competing controllers advancing the same obligation are not.
No mandatory SDK-neutral framework follows from these logical responsibilities.

The placement decision MUST address host turn termination, context rotation,
extension reload and automatic successor dispatch. A topology that becomes idle
until a human sends another prompt does not satisfy sustained execution.
**omp is the first host.** OmO portability is unproven and requires exercising
the same behavior and permission boundaries; adapter similarity is not evidence.

## Authoritative execution loop

Admission MUST validate the mandate and materialize its finite obligations.
Before LLM work, establish a safe synchronized baseline and bind the assignment
to the admitted objective, item, stage, revision and attempt.
The controller then dispatches eligible work within authorized capacity, validates
its result, advances the obligation and selects the next eligible action.
After every result, failure, approval or timed wake, this progression MUST occur
deterministically without a new operator prompt when authority is sufficient.

An LLM may produce analysis, plans, findings, changes or proposed repairs.
It MUST NOT be polled to decide whether a known transition should run, whether
a child has finished or whether an already-authorized next item should start.
Those decisions follow recorded state, policy and validated external evidence.
Natural-language claims of completion are not gate evidence.

| Item state | Meaning and permitted progression |
| --- | --- |
| `pending` | Selected obligation; prerequisites still need classification. |
| `ready` | Dependencies and authority permit dispatch after safety checks. |
| `running` | One current attempt owns the stage; valid results advance it. |
| `retry_wait` | A bounded retry is scheduled with its wake condition. |
| `blocked` | A named dependency, authorization or external condition prevents progress. |
| `succeeded` | Every required item acceptance and integration obligation is evidenced. |
| `failed` | A required obligation failed and permitted repair is exhausted or disallowed. |
| `cancelled` | Further work is revoked; completed effects remain accounted for. |

Stage completion may return an item to `ready` for its next stage; it does not
mean item success. Dependency satisfaction or valid approval may unblock an item;
a retry wake creates a new attempt. Terminal items cannot be reopened by a late
result; renewed work requires an explicit authorized transition and new attempt.

Every nonterminal run MUST have executing or eligible queued work, an executable
scheduled wait/retry, or a named external blocker with a concrete resume event.
An empty queue, agent turn end, successful tool exit or idle coordinator is not
objective completion. Independent authorized items SHOULD continue when another
item blocks or fails; dependent items retain the blocking cause. Shared safety
constraints may stop affected work, but not unrelated work without justification.

## Progress reconciliation and bounded repair

The controller MUST reconcile recorded intent with worker, engine, Git and issue
state after relevant events and scheduled deadlines. Monitoring MUST cause an
authorized transition, scheduled action or explicit blocked state, not just logs.
Each dispatch records its attempt and expected result before relying on delivery.
Duplicate delivery MUST NOT create a second authoritative attempt or duplicate
external effects. Ambiguous effects require observation before another attempt.
An unknown external-command outcome MUST enter reconciliation before any retry:
retain the intent and observed result separately, inspect external state, and
either establish the outcome or name the unresolved blocker. Worker loss or a
timeout is not evidence that an effect did not happen. Durable execution history,
authority to act and correctness of the observed result are separate obligations;
none substitutes for the others.

No-output attempts, terminated turns and missing completion events MUST trigger
reconciliation rather than silent idleness. Policy MUST define finite attempt,
repair and no-progress budgets, deadlines and retry/backoff conditions; this
contract specifies no arbitrary numerical defaults. A repair assignment MUST
carry bounded failure evidence and remain within the original authorized scope.
Exhaustion produces `failed` or a named escalation wait, never an infinite loop.
An unrelated failed item does not reset another item's budget or erase its result.

A restart-capable implementation SHOULD reconstruct outstanding intents and
reconcile effects before resuming. Full worker-restart recovery is secondary to
proving uninterrupted sustained execution. Delivery guarantees MUST be stated
honestly: at-least-once execution needs deduplication or effect reconciliation,
not an exactly-once claim.

## Baseline, isolation and revision-bound gates

Before an LLM receives a mutable task baseline, the controller MUST verify a
clean, correctly owned baseline checkout, fetch and synchronize using the
repository's authorized safe strategy. A failed fetch, dirty checkout or divergent
baseline blocks affected dispatch; it does not authorize destructive repair.
Synchronization is an admission/dispatch boundary, **not every tool invocation**.
A bound attempt works against its recorded baseline, not an unobserved moving one.

Independent modifications MUST use isolated worktrees. Reuse requires validated
repository, owner, item, branch and revision bindings. Unknown ownership MUST NOT
be resolved by killing a process, removing its worktree, stashing or discarding
changes. Read-only audit may share an immutable revision; generated changes need
the same isolation rules as other modification work.

Required review, targeted checks, repository gates and operator validation MUST
be bound to the exact candidate revision, stage and attempt, with command or
procedure identity and observed outcome. A changed candidate invalidates affected
evidence and approvals; stale passes cannot authorize integration. Replayed or
late evidence from a superseded attempt MUST NOT satisfy the current gate.

Integration policy MUST come from explicit repository configuration, not checkout
topology. The existing line uses trunk-based local integration into `main`, without
a mandatory PR. Development of this architecture is on `main`;
assignments and integration evidence MUST name their authorized target explicitly,
not infer it from checkout topology. Other repositories may require a different integration route, whose gates
and completion evidence remain binding.

The target trunk path is: **tested candidate → local merge into the configured
trunk → gate on the integrated revision → push that integrated revision**.
Integration MUST serialize conflicting publication effects and verify the expected
trunk baseline. The integrated gate MUST pass before push; candidate evidence is
reusable only if the revision and applicable gate inputs are identical.
Conflicts or changed gate inputs require bounded correction and fresh evidence.
No mandatory PR is imposed by this target; repository-required review still applies.

Push MUST publish the expected integrated SHA without force and confirm the remote
result. Concurrent remote movement requires safe reconciliation and fresh gates
where the revision changes, or a named blocker; it must not overwrite others.
Required post-push checks, issue closure and owned-resource cleanup MUST be
observed before item success when included in repository acceptance policy.
A local merge or green candidate alone is not completed delivery.

## Approval, cancellation and terminal accounting

Approval waits MUST name the missing authority, exact proposed action, objective,
item, applicable revision, attempt, authenticated decision maker and resume event.
An existing mandate replaces repeated prompts only for actions it actually covers.
A changed action or revision invalidates its approval. Denial MUST produce the
recorded stop or alternate authorized action, not repeated requests indefinitely.

Cancellation MUST stop future dispatch and cooperatively stop owned active work.
Already committed or published effects MUST be reported; cancellation is not
rollback authority. Late output from cancelled, superseded or revoked attempts
may be retained as evidence but MUST NOT advance state or publish further effects.
Ambiguous in-flight effects remain subject to reconciliation and safety checks.

A run is `succeeded` only when every required obligation is satisfied and every
required integration/publication check is verified. Otherwise terminal accounting
MUST distinguish `failed`, `partial` and `cancelled`; externally blocked runs are
nonterminal unless an explicit authorized stop closes them with unsatisfied work.
Reports MUST preserve counts and identities for succeeded, failed, cancelled,
blocked and pending items, accepted findings and published tickets as applicable.
Exhausting runnable work is not success, and failed items MUST NOT be relabelled
successful merely because independent work completed.

## Acceptance and engine decision

- **Audit:** traverse every scoped file with the named lenses; retain coverage,
  reviewed findings and authorized ticket-publication evidence with terminal
  counts. Do not implement published tickets without that permission.
- **Implement:** select the bounded ticket set; isolate, implement, review, gate,
  integrate, gate the integrated revision and push; observe required closure.
  Dispatch subsequent eligible tickets automatically and preserve failed items.
- **Combined:** carry accepted findings through authorized publication and bounded
  implementation without another human prompt inside the mandate; pause only
  where authority, safety, external dependencies or exhausted budgets require it.
- **Continuity:** demonstrate automatic succession across the full objective,
  including after child failure, no-output attempt, turn end and context rotation.
  Reject any idle nonterminal state missing an executable successor or named
  external blocker. Blocked items must not strand independent authorized work.
  Exercise negative paths: stale result/approval rejection, cancellation, gate
  failure, exhausted retries and remote movement; none may falsely report success.

The formal engine decision remains open, with **Temporal provisionally recommended**
subject to the feasibility gate below. Failed feasibility requires correction or
an explicit operator decision on alternatives, not automatic Dagu adoption. Select
the minimum complexity satisfying sustained-loop and safety acceptance, not maximal
recovery equivalence or a copy of the old graph. Domain logic may live in workflows
and the extension; no separate SDK-neutral controller framework is required.

## Recommended technical design (not adopted)

| Component | Recommended technology and placement |
| --- | --- |
| Durable control | Temporal TypeScript SDK: an objective workflow owns finite selection, dependencies and successor dispatch; item workflows own stage progression, waits and bounded repair. Workflows own authoritative transitions; activities perform external observations and effects. |
| OMP integration | Reuse and adapt relevant pi-temporal session-bridge internals first. An OMP extension hosts the Temporal worker and its activity bridge in the interactive OMP process. An activity requests a main-agent turn through `nextTurn`; that agent invokes native `task` subagents, and the bridge correlates their results. The extension does not directly invoke `task`. No headless agents are proposed. |
| Workflow runtime | Prebuild a separate workflow artifact and load it through `workflowBundle`, using the same pinned TypeScript SDK for build and load. Prebundling avoids runtime bundling; it does not determine thread placement. Explicitly use `debugMode: false` and leave `TEMPORAL_DEBUG` unset to retain normal workflow worker-thread execution. The recorded probe showed completion in that configuration, not measured thread placement or TUI responsiveness. |
| Evidence and effects | Activities independently validate receipts and external state, binding each accepted result to mandate, item, stage, attempt and exact revision. Agent completion text, job status and schema-validity flags alone cannot satisfy gates. Retain effect intent and result records; an unknown outcome requires external reconciliation using stable effect keys before any retry, never blind replay. |
| Worktree ownership | Use worktree-specific queues with a crash-safe lease and fencing generation for the authoritative worker. Reject stale owners at dispatch, result acceptance and effect boundaries; queue separation alone is not ownership. |
| Process lifecycle | A supervisor resumes the same persisted OMP session after abnormal exit and honors normal exit without relaunching. A lost native child is reconciled and retried as a new bounded attempt, not assumed restored by session resume. Activities must support cancellation and bounded shutdown. |
| Service and persistence | For the initial productive stage, run the Temporal Server binary under systemd with SQLite default and visibility stores, separate from OMP worker lifetime; run the UI separately if used. This is a single-host, non-HA deployment with localhost or private access, not the development CLI. Choose compatible exact server, SDK and optional UI pins at implementation; validate workload suitability, consistent backup/restore and restart before productive deployment. |

The exact SDK version used in the recorded probe is unavailable here: no version
is inferred. Selecting and recording compatible exact pins is an implementation
prerequisite, **not another experiment**. Temporal's official
[SQLite binary deployment tutorial](https://learn.temporal.io/tutorials/infrastructure/configuring-sqlite-binary/)
(July 8, 2024) describes a middle-ground production deployment using the core
Temporal Server binary, systemd and SQLite `sqlite-default` / `sqlite-visibility`
stores, with a separate UI. Its example server 1.24.2 and UI 2.28 versions are
historical examples, not pins to copy; select current compatible exact versions
when implementing. Do not copy an unauthenticated `0.0.0.0` bind: restrict access
to localhost or an appropriately protected private interface.

This deployment recommendation is not evidence of exercised operational
acceptance. Initial operation accepts single-host downtime and no HA, not loss
of durable effects or evidence. Validate the expected workload, consistent backup
of both stores and required configuration, restoration and restart behavior.
The [CLI server reference](https://docs.temporal.io/cli/command-reference/server.md)
restricts `start-dev` to development; `temporal server start-dev` with SQLite is
evaluation-only and is not the binary deployment above. The
[TypeScript worker guide](https://docs.temporal.io/develop/typescript/workers/run-worker-process.md)
documents prebuilt workflow bundles and worker shutdown controls.

Keep SQLite through the initial productive stage. Reassess PostgreSQL after
several productive weeks using observed workload and operational needs, not a
mandatory timed migration. A later database change requires its own approved
plan and acceptance; an in-place SQLite-to-PostgreSQL history copy is not assumed
or guaranteed.

OMP is the first target host. T3 is not the target; historical T3 visibility,
interruption and inactivity experiments are not blockers for this roadmap.
Tern may provide a terminal, but is not the controller or a required supervisor.
There is no running Dagu authority to replace or quiesce. New Temporal ownership,
effect reconciliation and persistence safety still require evidence; the absence
of a Dagu migration does not waive those obligations.

## Evidence and pending decision probes

The [recorded Temporal/OMP probes](t3-omp-roadmap.md#12-addendum-2026-11-04-temporal-loop-inside-the-omp-tui-with-native-role-subagents)
report passing extension-hosted workers, three-step native-task loops, subagent
guards/model routing, bundled workflows without debug mode, cancellable shutdown,
supervised session resume and isolated worktree queues. These are **recorded
results, not reverified here**: the listed temporary artifacts are absent and
were not inspected in this work. Their absence does not turn passed probes into
new experiments or justify rerunning them merely to recreate temporary files.

Their limits matter: the three-step loop was not an objective-level multi-item
acceptance run. Child status/schema handling had a reported upstream defect.
The tested worktree lock relied on clean exit, not crash-safe lease expiry.
Effect reconciliation passed against a local bare remote and fake PR store;
it did not prove real PR-backend concurrency or production deployment.

The six reusable parallel slices live under
[`poc/temporal-omp`](../../poc/temporal-omp/README.md): SQLite runtime, OMP
compatibility, objective succession, safety, ownership and update. Their portable
[`evidence-index.json`](../../poc/temporal-omp/evidence-index.json) separates
completed observations from pending acceptance, records exact commands, versions
and source evidence, and supplies the objective runner's fixed external-summary
manifest. Independent probes are not an end-to-end acceptance gate.

The first live dogfood use was observed: Main admitted six completed summaries
(SQLite, objective, safety, ownership, connected receipt gate and update) through
the index into the real objective command activities. The
[actual summary](../../poc/temporal-omp/objective/evidence/objective-proof-1793841268520/summary.json)
and [history](../../poc/temporal-omp/objective/evidence/objective-proof-1793841268520/history.json)
record exit 0, 53 history events, 6 transitions and 17 queries. Inventory and
dependent validation completed while `native-host-not-admitted` remained blocked.
This is retained-evidence validation only, not an integrated engineering gate.

After correcting local receipt deduplication and mandate binding, Main repeated
that admission: [latest summary](../../poc/temporal-omp/objective/evidence/objective-proof-1793841461459/summary.json)
and [history](../../poc/temporal-omp/objective/evidence/objective-proof-1793841461459/history.json),
exit 0 in 13.36 seconds, 53 events, 6 transitions and 16 queries. All six selected
summaries were checked with the corrected ownership evidence; the native-host
item remained blocked. The initial run remains a historical retained snapshot.

The final all-slice admission also included the minimal native-host report:
[final summary](../../poc/temporal-omp/objective/evidence/objective-proof-1793842176637/summary.json)
and [history](../../poc/temporal-omp/objective/evidence/objective-proof-1793842176637/history.json),
exit 0 in 13.50 seconds, seven summaries covering all six slices, 53 events,
6 transitions and 17 queries. Its native-host item remained blocked and
`nativeHostProof:false`: reading a native report is not executing its path.

After all final consumers finished, the owned SQLite server was gracefully
stopped with SIGTERM (exit 0); the endpoint is **not live at handoff**. The
[runtime evidence](../../poc/temporal-omp/sqlite/runtime-evidence.json) records the
stop and retained private database/cache, and the SQLite README supplies the
explicit local restart procedure. This is no deployed or managed service claim.

| Slice | Current observed scope | Still pending |
| --- | --- | --- |
| SQLite runtime | Passed official Server 1.32.2 with SQLite default/visibility stores and SDK 1.25.0 activity/workflow completion; after graceful server restart, the same run's result, 11 history events and visibility were read without a worker. | Productive systemd operation, backup/restore, workload suitability and crash/power-loss acceptance. |
| Pi/OMP compatibility | Passed actual interactive official compiled OMP 18.16.0 (embedded Bun 1.4.4, `NODE_PATH` unset) UI→embedded prebuilt Temporal worker (`debugMode:false`) loaded from self-contained bundles→`nextTurn`→main native `task`→correlated result→workflow completion; build-input, deployed-output and host hashes retained. An earlier npm OMP + Bun 1.4.4 pass is retained as history. | Bundling rewrites four SDK 1.25.0 load sites and must be reviewed per SDK update; addon is Linux x64 only. Async completion, context/reload/crash and other gate interoperability remain unproven. |
| Objective | Passed real command-bootstrap succession: independent inventory and dependent validation while a native-host item stays blocked; 53 history events, 6 state transitions, 17 live queries in the indexed run. Native succession then passed in the compiled OMP host ([`native-objective`](../../poc/temporal-omp/native-objective/README.md)): two dependent native `task` items, an independent command item and a named blocker; automatic successor, one send and one binding-exact receipt per binding, across root turn end, a committed `session_compact` and a same-version `/restart` while the handoff was pending. | Crash/child loss after dispatch (sent marker and `sendMessage` are not atomic), async task completion, adversarial receipts, extension self-update (`/reload-plugins` does not reinitialize extensions), Git-bound receipts and the complete engineering/audit gate chain. |
| Safety | Passed 19 local Git/receipt cases, including commit/push result loss with no repeated operation. | Atomic authority/effect integration, native runtime crash recovery and real external-backend concurrency where applicable. |
| Ownership | Passed generic owner SIGKILL, fenced takeover, bounded attempts and SQLite reopen. Connected local gate validates Safety receipts inside current-generation SQLite acceptance; stale/invalid evidence leaves zero rows, valid evidence one row. Corrected follow-on proves second-connection/terminal duplicate observation, conflict rejection and wrong-mandate completion rejection. | Native OMP supervisor/session recovery. Git observation precedes the transaction: local acceptance is fenced, not atomic Git plus SQLite or external effect dispatch. |
| Update | Passed actual compatible workflow-v1→v2 continuation with old activity in flight: old sum10 rejected, new squares38 accepted; 21 events and retained workflow bundles. | Native extension self-update, incompatible workflow changes and a shared safety receipt binding. |

Final ProbeReview reported **pass with limits**, with no actionable defect or
source-hash mismatch. Native receipt correlation is substring-based, not ownership
binding-field/schema equality; the summarizer's marker/runtime strings were not
independently rechecked. Local receipt deduplication relies on transactional
logic, not a SQL unique constraint. The independent seven-summary dogfood pass
remains evidence validation, not an operational gate.

The runtime placement is the installed compiled OMP binary. The unbundled
extension failed there because Bun's compiled resolver could not load
`@temporalio/common` inside the workflow worker thread; `poc/temporal-omp/omp/build.ts`
removes that boundary by shipping the extension and worker thread as
self-contained bundles with the native addon and WASM beside them. The pass
still uses synchronous task execution, and the build depends on exact SDK 1.25.0
source needles that fail the build if they change. The
next supported development use connects that proven handoff to bounded objective
and receipt authority, retaining command-only evidence validation until the
native integrated path itself passes. Async completion, context/reload/crash and
safe self-update remain their own pending gates.

Safety has observed 19 local Git/receipt cases, including a real commit and push
followed by result loss and read-only reconciliation without repeating the effect.
Its revision is a real Git SHA. Numeric revisions in the independent Temporal
experiments are experiment counters, not candidate Git bindings; source-content
hashes do not make those bindings interchangeable. The following broader
obligations remain pending unless their exact native boundaries are evidenced:

| Pending acceptance | Trigger and observable pass/fail | Decision consequence |
| --- | --- | --- |
| Objective succession and host handoff | Admit a bounded multi-item objective once; include a blocked item with an independent successor. End turns, rotate context and reload the extension while a native-task handoff is pending or in flight. Pass only if every eligible successor dispatches without another operator prompt, each request/result remains correlated, and every nonterminal item has executable work/wait or a named blocker. Idle nonterminal state or lost/duplicate authoritative handoff fails. | Required Temporal/OMP feasibility evidence; failure requires correcting the bridge/placement and repeating the failed case, or an explicit operator decision on alternatives. |
| Independently validated receipts | Supply malformed output, a false completion claim, a status/schema mismatch, and receipts from the wrong mandate, item, attempt or revision. Pass only if independent validation rejects each and only current revision-bound external evidence advances a gate; a misleading host flag must not bypass it. | Define the validator boundary despite the reported upstream bug. Inability to establish trustworthy acceptance fails feasibility; waiting for an upstream fix alone is not a gate implementation. |
| Crash, child loss and fenced ownership | Kill the owning OMP process with a native child in flight, resume the persisted session through the supervisor, then let an expired owner attempt a late result/effect after a replacement acquires the lease. Pass only if ownership transfers safely, the stale generation is rejected, completed effects are reconciled, the lost child receives a bounded new attempt, and normal exit does not relaunch. | Required before claiming crash-safe execution. Acceptance of stale authority, blind effect replay or false success fails safety feasibility; inability to reconstruct the session or transfer the lease blocks the recovery claim, not the engine choice by itself. Recovery remains secondary to sustained execution. |
| Self-update and reload version safety | Change the controller/extension or workflow artifact during an authorized development objective, with an old-version attempt pending or in flight. Reload or restart through the supported path. Pass only if the running code and workflow versions are recorded, compatible work resumes or incompatible work explicitly blocks, and old-version results cannot advance a superseded attempt or duplicate effects. Demonstrate successor dispatch after the update. | Pending evidence; ordinary session resume or reload alone does not prove safe self-update. Unsupported updates remain explicit bootstrap work, not hidden manual autonomy. |
| PR-backend concurrency (conditional) | Only if a repository selects a PR backend: race two deliveries of the same authorized effect against that backend. Pass only if observation shows one logical PR/effect and correct revision binding, including the ambiguous-response path; duplicate publication fails. | Blocks that PR integration until reconciliation is safe, not this repository's trunk-only path. Local sequential records do not prove this result. |

## External precedents and selection limits

[Temporal's framework announcement](https://temporal.io/blog/ai-framework-integrations)
confirms GA integrations, not a dominant stack or a ready-made OMP adapter.
No LangGraph or OpenAI Agents SDK layer is required by this design.

[pi-temporal](https://github.com/temporalio/pi-temporal) is a concrete Pi-session
implementation to inspect and reuse before writing bespoke bridge or controller
internals. Pi capabilities are available to OMP as a superset host; this is not
a claim that every Pi API is drop-in compatible or that both hosts use identical
compiled packages. Investigate adapting its intent/result persistence, fencing
and session bridge, including importing or porting relevant controller internals
where suitable. No whole-repository fork is required. The a4s mandate, objective
selection, item progression and gate obligations remain a4s responsibilities.

Its [guarantees](https://github.com/temporalio/pi-temporal/blob/main/docs/guarantees.md)
describe tool dispatch claims, retained results and stale-attempt fencing, with
explicit limits. A claim without a retained result is an unknown outcome, not
permission to rerun an arbitrary command. Conversation files, project Git bundles
and workflow history have different persistence responsibilities. Preserve those
boundaries when adapting the implementation. Upstream checks are reusable
evidence of those capabilities, not a reason for blanket revalidation. Perform
only the minimal compatibility smoke at OMP binding, hook and session boundaries,
then exercise the missing a4s objective and safety obligations above. Exact OMP
API/package compatibility and the adapted integration remain unproven; upstream
SDK pins do not establish compatible implementation pins for a4s.

Temporal history replay is not a guarantee against duplicated external effects;
its [activity contract](https://docs.temporal.io/activity-definition.md) still
requires application idempotency and reconciliation. Historical Dagu mechanisms
are not an operational dependency or a reason to reproduce its graph.

Treat authority, durability and correctness as separate acceptance obligations.
Neither adoption statistics nor an engine's durable-execution label selects the
engine. During end-to-end acceptance, inject loss after a local commit or trunk
push but before result persistence: recover from intent and observed Git state,
reject obsolete attempts, and never blindly repeat an unknown effect. Unresolvable
outcomes become named blockers rather than fabricated success or unsafe retries.

## Staged delivery roadmap

Superseded by the roadmap in [omp-temporal.md](omp-temporal.md); retained as the
historical rationale of the baseline tests.

1. **Run decision-changing tests first, in parallel where independent.** Begin
   with the SQLite runtime, Pi/OMP compatibility, objective succession and safety
   proofs above before production controller development. Inspect the relevant
   pi-temporal intent/result, fencing and session-bridge internals to select what
   to reuse; adapt only what the minimal real compatibility slice requires.
   Retain upstream evidence instead of repeating all Pi proofs. Record exact
   compatible pins, commands, durable artifacts and pending/observed outcomes.
   Reuse and adapt productive proof code rather than rebuild it as throwaway work.
2. **Dogfood incrementally from the earliest validated capability.** Bootstrap
   unsupported steps explicitly under the existing operator mandate; record the
   action, actor, inputs and evidence without calling it autonomous execution.
   As soon as a capability passes its gate, use it for subsequent supported real
   roadmap steps, not only a final demonstration. For example, a validated bounded
   dispatch/result path can run an authorized development item while unsupported
   selection or integration remains explicitly bootstrapped. Update this roadmap
   live with observed capability, limits, evidence and the next supported use.
   Do not claim objective autonomy until successor selection and the full required
   gate chain are demonstrated without hidden manual dispatch or state repair.
   The first supported use, **`command_activity` evidence validation only**, has
   now run: completed summaries were admitted through the index and checked by
   fixed inventory and independent reread operations (evidence above). The native
   host obligation stayed blocked. Next reuse this validator for supported real
   evidence work and connect the proven npm-host synchronous handoff to an
   authorized bounded objective and source/SHA-bound receipt authority; prove
   automatic succession and missing async/context/reload boundaries before
   expanding authority. Independent probe passes do not
   establish an integrated gate or autonomous OMP execution. Reuse the SQLite
   runtime, objective workflow/activities, safety validator and reconciliation,
   ownership authority/receipt gate and version-binding artifacts at their proven
   boundaries.
3. **Extend the validated slice into sustained engineering and audit paths.**
   Reuse the proven artifacts and applicable gate logic to build objective/item
   workflows, admission and finite selection, persisted attempt bindings,
   independent receipt validation, baseline/worktree guards, bounded retries,
   approval/cancellation and terminal accounting. Each newly validated capability
   MUST drive the next supported development work. Implement the bounded ticket
   path through candidate review/checks, local integration into the explicitly
   authorized target, integrated-revision gate, non-force push and observed
   closure/cleanup. Implement read-only audit coverage and reviewed, deduplicated
   ticket publication only when authorized; connect audit to implementation only
   for a mandate authorizing that whole chain. Add a PR route and its conditional
   probe only for a repository requiring it. Preserve automatic succession and
   named blockers throughout, not just completion of isolated tasks.
4. **Prove development continuity and self-update safety.** Exercise missing
   sustained-loop, independent-validation and crash/ownership obligations as the
   implementation grows. Unsafe authority or blind effect replay fails safety;
   incomplete restart recovery remains a named limitation, not an automatic
   engine switch. Prove reload/update version and attempt binding with actual
   in-flight work before using the system to autonomously update its own running
   controller. A successful build, session resume or extension reload alone is
   insufficient. Until proven, make that unsupported boundary explicit and retain
   bootstrap evidence; do not silently bridge it with operator prompts or edits.
5. **Demonstrate end-to-end acceptance and new deployment readiness.** Run Audit,
   Implement, Combined and Continuity across multiple items with durable evidence,
   all named negative paths and exact terminal accounting. Exercise the selected
   systemd/Temporal Server binary deployment with SQLite default and visibility
   stores: workload suitability, private access, consistent backup and restore,
   restart and operator procedures. These are safeguards for new Temporal state,
   not Dagu backup or migration tasks. A separate UI, if used, needs compatible
   pins and protected access. Do not extrapolate from a dev server or fake effects.
   Approve productive use only within the capabilities and permissions actually
   demonstrated; documentation or passing basic probes does not deploy the system.
6. **Reassess storage after several productive weeks.** Keep the initial SQLite
   deployment unless observed needs justify PostgreSQL. Any change requires a
   separately approved data-transition and acceptance plan, not an automatic
   deadline or an assumed in-place history migration.

## Productive readiness and branch intent

`main` is the development line; `legacy2` preserves the previous line. Deployment
and productive readiness MUST be recorded separately from branch work.

Productive readiness requires an approved engine/placement decision, exercised
acceptance scenarios, revision-bound Git and gate behavior, explicit ownership
of new work, operator procedures and retained evidence for unmet obligations and
safe recovery. SQLite binary/systemd operational acceptance is sufficient for
the initial productive stage; PostgreSQL is not a prerequisite. Unknown effects
require external reconciliation, and new ownership MUST reject stale authority.

There is no Dagu operational migration, backup, drain or shutdown-validation gate.
The historical line is preserved rather than operated as a fallback execution
plane. New Temporal persistence and ownership guarantees remain binding. Pending
proofs, productive deployment, safe self-update and the remote default switch
MUST NOT be reported as completed without their respective observed evidence.
