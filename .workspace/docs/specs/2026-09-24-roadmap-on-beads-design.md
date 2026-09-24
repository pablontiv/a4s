---
tipo: spec
---
# Roadmap on Beads Design

## Goal

Replace the separate `beads-loop` execution interface with one global `roadmap`
skill that owns the complete planning lifecycle while keeping Beads as the
durable backlog and dependency graph.

The interface is intentionally small:

```text
roadmap plan    propose epic/task work, obtain approval, materialize in Beads
roadmap         show and explain the pending decision tree
roadmap doctor  diagnose and approval-gate alignment of existing Beads
roadmap loop    implement one topologically ready task at a time
```

## Governing decisions

- ADR 0043 replaces the Herdr-only topology with bounded in-session
  Superpowers subagents as the general A4S topology.
- ADR 0044 replaces the non-leasing `beads-loop` projection with this unified
  Roadmap interface.
- ADR 0033 remains the closure race guard: final state transitions are
  conditional on the exact task still being owned and `in_progress`.
- ADR 0015 and ADR 0019 apply only when a workflow explicitly invokes Herdr.

## Authority boundaries

| Concern | Authority |
| --- | --- |
| Planning process and task-quality rules | `roadmap` skill |
| Backlog records, hierarchy, status, priority, ownership and dependencies | Beads |
| Repository workflow and Definition of Done | Effective `.workspace/config.yaml` |
| Governed ADRs, specs and plans | Rootline under `.workspace/docs/` |
| Code, commits and delivery artifacts | Git and the configured delivery provider |
| Session-only progress projection | Pi `todo` and Superpowers workspace ledgers |
| Reusable and episodic memory | Engram and Backscroll respectively |

Roadmap never creates another durable queue or mirrors Beads state into Markdown.
Rootline does not store Roadmap backlog items.

## Canonical data model

Roadmap creates and executes only the core Beads types `epic` and `task`.

```text
epic          optional non-executable aggregate
└── task      executable unit

task          may also exist directly at repository root
```

New Roadmap materialization forbids nested epics. Existing nested epics are a
Doctor finding and are normalized only after the proposed reparenting is
approved.

`parent-child` expresses hierarchy only. `blocks` is the only relationship
that controls execution order.

### Epic contract

An epic declares:

- an observable objective;
- verifiable success criteria;
- shared invariants;
- explicit in-scope and out-of-scope boundaries;
- child tasks.

An epic is never claimed or implemented. It closes only after all child tasks
are closed and its own success criteria and invariants have fresh evidence.

### Task contract

A task must be executable in one session and contain enough information for a
fresh agent to act without conversational history:

- actionable title;
- context and expected result;
- explicit in-scope and out-of-scope boundaries;
- observable expected initial state;
- binary acceptance criteria;
- invariants to preserve;
- source-of-truth paths or interfaces;
- `blocks` dependencies when applicable;
- required evidence for closure.

Roadmap treats an incomplete task as `contract_incomplete`; it does not claim,
implement or silently enrich it. Missing requirements are returned to
`roadmap plan` or `roadmap doctor` for an approval-gated correction.

A task that contains multiple independently deliverable outcomes is not valid.
It must be replaced by an epic and separate tasks.

## Workspace Definition of Done

Task-specific correctness belongs to the Bead. Repository-wide completion
belongs to the effective `.workspace/config.yaml` resolved through workspace,
group and repository precedence.

The effective Definition of Done includes the applicable values of:

- context sources;
- sync strategy;
- isolation strategy;
- development workflow;
- commit policy;
- pre-checks;
- acceptance checks;
- review checks;
- delivery mode and delivery gate;
- post-checks;
- monitoring and cleanup policy when applicable.

A repository without a resolvable `.workspace/config.yaml` has an `unknown`
Definition of Done. `roadmap plan` and read-only tree inspection may continue,
but `roadmap loop` fails before mutating work and `roadmap doctor` reports the
missing adoption contract. There is no implicit fallback to README, AGENTS,
package scripts or a standalone Definition-of-Done document.

A prose-only workspace control cannot be reported as automatically executed.
Every closure receipt records each required control as `passed`, `failed`,
`unknown`, `skipped` or `not_applicable`. A required `failed` or `unknown`
control prevents closure.

Deterministic controls require a stable identifier, executor kind, condition,
working directory, postcondition, failure behavior and bounded evidence. Until
a control has that shape, the controller may evaluate it procedurally but must
retain `unknown` when the postcondition cannot be verified.

## Command behavior

### `roadmap plan`

`roadmap plan` consumes the current conversation and optional plan arguments,
reads bounded repository context and related open Beads, and proposes a complete
`epic/task` graph.

The proposal includes:

- every epic and task title;
- each task contract;
- hierarchy;
- `blocks` edges;
- acceptance criteria and preserved invariants;
- the expected initial topological frontier.

Roadmap presents the full proposal and asks the user to authorize
materialization. Before approval it performs no Beads mutation.

After approval it:

1. creates exactly one Bead per proposed epic or task;
2. creates `parent-child` hierarchy and `blocks` edges;
3. validates task contracts and rejects a partial materialization;
4. checks dependency cycles;
5. verifies that every active graph component has at least one executable root
   or one explicit external gate;
6. commits and pushes the coherent Beads mutation according to the repository's
   Beads storage contract.

A list of tasks embedded in one Bead is never valid materialization.

### `roadmap`

Bare `roadmap` is read-only. It renders the pending decision tree from the full
non-closed graph, not only from `bd ready`.

Every non-closed record is classified as one of:

- executable now;
- blocked by named tasks;
- externally gated with a canonical reason;
- actively owned by another session;
- deferred until a declared condition or time;
- contract-incomplete;
- invalid hierarchy or type;
- stale operational state;
- aggregate epic.

The view shows the next deterministic candidate, reverse dependency impact and
why every other task is not executable. It never reports “no ready work” unless
it can provide one canonical reason for every non-closed task.

### `roadmap doctor`

Doctor is read-only by default. It audits existing Beads against this spec and
reports:

- types other than `epic` or `task`;
- nested epics;
- aggregate records mis-typed as tasks;
- executable records mis-typed as epics;
- incomplete task or epic contracts;
- `blocked` or `deferred` status used instead of `blocks` edges;
- broken dependencies and cycles;
- executable epics;
- stale assignees, claims or leases;
- graph components with no executable root and no explicit external gate;
- disagreement between the computed topological frontier and `bd ready`;
- missing or unresolved `.workspace` Definition of Done.

Doctor divides findings into:

1. deterministic corrections whose result is fully established;
2. decisions requiring user input;
3. unresolvable findings where evidence is insufficient.

It presents the complete correction plan and asks for authorization before any
mutation. It preserves Bead IDs, history, notes, evidence and external
references; it never fabricates missing requirements. After approval it applies
only the accepted corrections, validates cycles and contracts, recomputes the
frontier and compares it with `bd ready`.

`roadmap loop` may invoke Doctor diagnostics, but it never applies Doctor fixes
implicitly.

### `roadmap loop`

Loop executes tasks sequentially. “Sequential” means one claimed Beads task is
active in Roadmap at a time; fresh Superpowers implementer and reviewer agents
operate inside that task boundary.

#### Preflight

Before selecting work, Roadmap:

1. resolves the repository root and Beads provider;
2. resolves effective `.workspace` configuration;
3. reads all non-closed `epic/task` records and all `blocks` edges;
4. checks cycles and contract completeness;
5. computes the expected topological frontier;
6. reads `bd ready` and compares both frontiers;
7. stops with `readiness_drift` when they disagree;
8. reports Doctor classifications when no executable task exists.

The computed frontier contains open tasks whose `blocks` predecessors are all
closed, whose contract is complete and whose external gates are satisfied.
Roadmap selects only from the intersection of the computed frontier and
provider-ready work.

Within that intersection, ordering is deterministic: resume the current
session's owned task first, then Beads priority, reverse dependency impact and
ID as the final tie-break.

#### Ownership

Roadmap claims exactly one selected task through Beads. A failed atomic claim is
a race loss and causes a fresh frontier calculation; Roadmap never overwrites an
active owner.

The controller renews the native lease while implementation, review or delivery
is active. Heartbeat loss, changed assignee or changed status stops the task
before another mutation. Only an expired lease may be reclaimed, using the
provider's explicit reclaim operation.

#### Superpowers execution envelope

For each claimed task, the controller:

1. creates one outer Pi todo bound to the Bead ID;
2. reads the full task contract;
3. activates the concrete Superpowers disciplines required by the task;
4. dispatches a fresh implementer subagent;
5. receives a bounded report by file;
6. dispatches an independent task reviewer for specification and quality;
7. resumes or replaces the implementer through the bounded fix/re-review loop;
8. dispatches final branch review when the delivery boundary requires it;
9. runs verification-before-completion.

Subagents never dispatch subagents. The controller alone owns sequencing,
ownership and review routing. Exact requirements live in bounded files rather
than accumulated prompt history.

Roadmap asks for confirmation before moving to the next topologically ready
task.

#### Closure

A task may close only when all of the following are true:

```text
Bead acceptance criteria passed
AND Bead invariants preserved
AND required Superpowers reviews accepted
AND effective workspace pre/acceptance/review checks passed
AND configured delivery completed and verified
AND required workspace post-checks passed or are not applicable
AND ownership and in_progress state still match
```

The evidence receipt contains:

- Bead ID and revision;
- effective workspace configuration digest;
- candidate commit SHA and base revision;
- acceptance-criterion results;
- invariant results;
- review producer and verdict bindings;
- delivery receipt appropriate to the configured mode;
- post-check results;
- bounded paths to retained evidence.

The final Beads update uses compare-and-set guards for assignee and
`in_progress`, appends the receipt path and changes status to `closed`. A stale
guard returns `claim_lost` without retry.

A failed task appends bounded failure evidence and enters the contract-required
non-closed state. An ambiguous external effect, ownership loss or required
`unknown` workspace control stops the loop without selecting another task.
After successful closure, Roadmap recomputes the complete graph before offering
the next task.

## Readiness reconciliation

`bd ready` remains required provider evidence, but it is not accepted as an
unexplained terminal verdict.

Roadmap independently derives the expected frontier from the full graph and
compares IDs with the provider frontier:

```text
expected == provider  → select from the common frontier
expected != provider  → readiness_drift; diagnose before execution
both empty             → explain every non-closed record or report graph defect
```

Status parking is not dependency modeling. Functional prerequisites use
`blocks`. `blocked` is reserved for an observed failed or external condition;
`deferred` requires an explicit wake condition or date. Closing a blocker causes
a fresh graph calculation rather than a precomputed static queue.

## Packaging and migration

A4S is the source of the global skill under `skills/roadmap/`. The skill is
self-contained and does not depend on a sibling skill.

Implementation migrates the useful deterministic provider adapter and tests
from `skills/beads-loop/` into Roadmap-owned paths, then removes
`skills/beads-loop/`. No compatibility alias or second public entry point is
kept.

Global installation points to the stable A4S checkout only after the Roadmap
skill passes its complete contract and end-to-end suite. Historical ADRs,
specs and plans remain versioned; they are not rewritten.

Existing repository backlogs are never bulk-mutated during installation.
Operators run `roadmap doctor` per repository and approve each correction plan.

## Failure handling

| Condition | Result |
| --- | --- |
| Missing Beads repository/provider | Stop before mutation |
| Missing effective workspace DoD | Doctor finding; loop stops before implementation |
| Incomplete task contract | Withhold and route to Plan or Doctor |
| Dependency cycle | Stop and report cycle |
| Computed/provider frontier mismatch | `readiness_drift`; Doctor diagnostics |
| Claim race | Recompute once from fresh provider state |
| Heartbeat or ownership loss | Stop task; no further mutation |
| Test or acceptance failure | Preserve evidence; task does not close |
| Review finding | Enter bounded fix/re-review loop |
| Required workspace check `failed` or `unknown` | Do not deliver or close |
| Delivery or post-check ambiguous | Stop; do not retry mutating effects |
| Conditional finalization race | `claim_lost`; no retry |

## Test strategy

Skill changes follow the writing-skills RED-GREEN-REFACTOR contract. Pressure
scenarios are run before the new skill exists to capture baseline failures.

Deterministic unit and contract coverage includes:

- command routing for `plan`, bare tree, `doctor` and `loop`;
- strict `epic/task` hierarchy and task contracts;
- materialization approval and no-write-before-approval;
- graph cycle and root validation;
- topological frontier calculation;
- provider-ready parity and `readiness_drift`;
- complete no-ready explanations;
- Doctor classification, dry-run, approval and preservation rules;
- atomic claim races, heartbeat renewal, expiry and reclaim;
- one active task at a time;
- subagent role routing and recursive-delegation rejection;
- workspace configuration resolution and missing-config failure;
- task AC plus workspace DoD closure receipts;
- conditional finalization and claim loss;
- complete removal of the public `beads-loop` interface.

Disposable end-to-end repositories prove:

1. Plan creates an approved `epic/task` graph with correct `blocks` edges.
2. Bare Roadmap explains the entire pending graph.
3. Doctor diagnoses and approval-gates a legacy mixed-type/status-parking graph.
4. Two competing loop processes cannot own the same task.
5. Closing task A makes blocked task B enter the next computed frontier.
6. A repository without `.workspace/config.yaml` cannot start mutating loop work.
7. A workspace-configured repository produces a closure receipt and closes only
   after its configured delivery boundary.
8. No live repository backlog, remote or external system is mutated by tests.

## Success criteria

- `roadmap` is the only public planning/execution skill.
- Plan, tree, Doctor and loop operate on Beads without a second durable store.
- New Roadmap records use only `epic` and `task` with no nested epics.
- No task starts with an incomplete contract or unresolved workspace DoD.
- No-ready results explain every non-closed record.
- Provider readiness and computed topology must agree before selection.
- Exactly one task is claimed and heartbeated at a time.
- Superpowers implementer/reviewer routing is bounded and non-recursive.
- Closure requires task acceptance plus repository-configured delivery and
  postconditions.
- Existing backlogs migrate only through approval-gated Doctor plans.
- The `beads-loop` skill, alias and global installation are removed after
  Roadmap verification succeeds.
