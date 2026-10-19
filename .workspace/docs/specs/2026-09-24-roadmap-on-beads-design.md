---
tipo: spec
---
# Roadmap on Beads Design

## Goal

Restore Roadmap as a Markdown-only global skill and replace its former Rootline
backlog operations with direct Beads CLI operations.

Roadmap owns the planning process. Beads owns durable work records, hierarchy,
dependencies, status, priority and claims. Rootline remains responsible only
for governed Markdown such as ADRs, specs and implementation plans.

The public interface is:

```text
roadmap plan    propose epic/task work, ask approval, then materialize in Beads
roadmap         show and explain the pending tree
roadmap doctor  diagnose and approval-gate alignment of existing Beads
roadmap loop    implement one topologically ready task at a time
```

## Artifact boundary

Roadmap consists only of Markdown:

```text
skills/roadmap/
├── SKILL.md
├── README.md
└── references/
    ├── contracts.md
    ├── plan.md
    ├── tree.md
    ├── doctor.md
    └── loop.md
```

This change does not create Python, JavaScript or shell helpers; custom parsers;
JSON-envelope protocols; daemons; extensions; runtime dependencies; or new unit
and integration test suites.

Roadmap calls the installed `bd` CLI directly. Temporary files required by a
specific Beads command may be written below the repository's ignored
`.superpowers/roadmap/` directory and are never a second durable store.

Skill verification follows the `writing-skills` contract: pressure scenarios
are run before and after the Markdown change. Existing repository validation
continues to run, but Roadmap introduces no test framework of its own.

## Governing decisions

- ADR 0043 allows the Roadmap controller to use bounded Superpowers subagents.
- ADR 0044 replaces the public `beads-loop` interface with Roadmap.
- ADR 0033 remains the finalization race guard: close only when the exact task
  is still assigned to the current actor and `in_progress`.
- ADR 0015 and ADR 0019 continue to govern workflows that explicitly use Herdr.

## Authority boundaries

| Concern | Authority |
| --- | --- |
| Planning process and task-quality rules | Roadmap Markdown skill |
| Backlog records and graph | Beads |
| Repository Definition of Done and delivery policy | Effective `.workspace/config.yaml` |
| ADRs, specs and plans | Rootline-governed Markdown |
| Code and delivery artifacts | Git and configured delivery provider |
| Session-only execution coordination | Pi todo and Superpowers subagents |
| Reusable and episodic memory | Engram and Backscroll |

Roadmap never mirrors Beads state into Markdown records. Rootline never stores
Roadmap epics or tasks.

## Canonical Beads model

Roadmap creates and executes only the core Beads types `epic` and `task`.

```text
epic          optional non-executable aggregate
└── task      executable unit

task          may also exist directly at repository root
```

New Roadmap plans do not create nested epics. Existing nested epics are Doctor
findings and are changed only through an approved correction proposal.

`parent-child` expresses hierarchy only. `blocks` is the only execution-order
relationship.

### Epic contract

An epic declares an observable objective, success criteria, shared invariants,
explicit scope and child tasks. It is never claimed or implemented directly.
It closes only after every child task and the epic's own success criteria have
fresh evidence.

### Task contract

A task must fit one session and contain:

- actionable title;
- context and expected result;
- explicit in-scope and out-of-scope boundaries;
- observable expected initial state;
- binary acceptance criteria;
- invariants to preserve;
- source-of-truth paths or interfaces;
- `blocks` dependencies when applicable;
- evidence required for closure.

A contract-incomplete task is shown but not claimed. Roadmap never invents the
missing content; Plan or Doctor must present a correction for approval.

A task containing independently deliverable outcomes must be decomposed into an
epic and separate tasks.

## Repository Definition of Done

The Bead defines task-specific correctness. The effective
`.workspace/config.yaml` defines repository-wide completion: context, sync,
isolation, development workflow, commits, acceptance checks, review, delivery,
post-checks, monitoring and cleanup.

Roadmap reads and applies the prose-first workspace contract directly. It does
not implement a merge engine or automatic control executor. It identifies the
workspace, group and repository layers, follows their declared precedence and
records bounded evidence for every applicable control.

A missing, inaccessible or ambiguous required workspace control remains
`unknown`. Required `failed` or `unknown` controls prevent delivery and Bead
closure. There is no inferred fallback to README, AGENTS, package scripts or a
standalone Definition-of-Done document.

Closure evidence is a repository-contained Markdown report linking the Bead,
candidate SHA, acceptance results, review verdicts, configured delivery and
post-checks.

## `roadmap plan`

Plan consumes the current conversation and bounded repository context, then
proposes a complete `epic/task` tree with task contracts and `blocks` edges.

It presents the full proposal and asks the user to authorize materialization.
No `bd` mutation occurs before approval.

After approval Roadmap:

1. writes a temporary Beads graph input below `.superpowers/roadmap/`;
2. runs `bd create --graph ... --dry-run --json`;
3. stops on warning, unknown field, invalid hierarchy or cycle;
4. runs `bd create --graph ... --json` only for the unchanged approved graph;
5. reads back the new records and dependency edges;
6. reports exact IDs and any mismatch.

Every proposed task becomes one Bead. A list of tasks embedded in one Bead is
not valid materialization.

## Bare `roadmap`

Bare Roadmap is read-only. It obtains the complete non-closed graph with direct
`bd list`, `bd dep list`, `bd show` when detail is needed, and `bd ready`.

It renders epics, tasks, `blocks` relationships and one deterministic next
candidate. Every non-closed record receives a reason:

- executable now;
- blocked by named tasks;
- externally gated;
- owned by another session;
- deferred to a declared time or condition;
- contract-incomplete;
- invalid hierarchy or type;
- stale operational state;
- aggregate epic.

Roadmap never treats an empty `bd ready` result as proof the backlog is done. It
reports “no executable task” only after explaining every non-closed record.

## `roadmap doctor`

Doctor is read-only first. Using direct `bd` inspection, it detects:

- types other than `epic` or `task`;
- nested epics;
- aggregate records typed as tasks;
- executable records typed as epics;
- incomplete contracts;
- `blocked` or `deferred` used instead of known `blocks` edges;
- broken dependencies or cycles;
- executable epics;
- stale assignees, claims or leases;
- graph components with no executable root and no explicit external gate;
- disagreement between the topology and `bd ready`;
- missing or ambiguous `.workspace` DoD.

Doctor classifies findings as deterministic corrections, decisions requiring
user input or unresolvable gaps. It presents the exact `bd` commands it proposes
and asks authorization before applying any of them.

Doctor preserves IDs, history, notes, evidence and external references. It
never fabricates missing requirements, infers ambiguous dependencies or uses
`bd reclaim --any-replica`.

After authorized corrections it re-reads the affected Beads, runs
`bd dep cycles`, recalculates the pending tree and reports residual findings.

`roadmap loop` may invoke Doctor diagnosis but never applies Doctor corrections
implicitly.

## `roadmap loop`

Loop executes exactly one task at a time.

### Selection

Before selecting, Roadmap:

1. resolves `.workspace/config.yaml` and required context;
2. lists all non-closed epics/tasks and `blocks` edges;
3. rejects cycles and contract-incomplete candidates;
4. identifies tasks whose blockers are closed;
5. compares that topological frontier with `bd ready`;
6. stops for Doctor when the sets disagree.

It selects only a task present in both sets. Ordering is current owned task,
Beads priority, reverse dependency impact and ID.

### Ownership

Roadmap runs `bd update <id> --claim --json` for the selected task. A failed
claim is a race loss; Roadmap refreshes the tree instead of overwriting another
owner.

Roadmap runs `bd heartbeat <id>` before and after each bounded implementation,
review and delivery stage. Heartbeat failure, changed assignee or changed
status stops further mutation. Only Doctor may propose reclaiming a verified
expired lease.

### Superpowers execution

Inside the claimed task, the controller uses relevant Superpowers skills and
fresh implementer/reviewer subagents. The controller alone delegates; workers
do not create subagents. Reports are bounded and returned by artifact path or
concise final result rather than accumulated transcripts.

The task flow is:

```text
read full Bead contract
→ implementer
→ task reviewer
→ fix/re-review when required
→ repository validation
→ configured delivery and post-checks
→ conditional Bead finalization
```

Roadmap asks for confirmation before selecting the next topologically ready
task.

### Closure

A task closes only when:

```text
Bead acceptance criteria passed
AND invariants preserved
AND required reviews accepted
AND effective workspace checks passed
AND configured delivery verified
AND required post-checks passed or are not applicable
AND ownership still matches
```

Roadmap writes the Markdown evidence report, then performs one conditional
update:

```text
bd update <id> --status closed \
  --if-assignee <actor> --if-status in_progress \
  --append-notes "PASS evidence=<repo-relative-path>" --json
```

A stale conditional guard is `claim_lost` and is never retried. Failed or
ambiguous effects preserve evidence and use the contract-required non-closed
state. After successful closure Roadmap re-reads the graph before offering the
next task.

When all child tasks close, Roadmap verifies the epic's success criteria and
evidence before conditionally closing the epic.

## Readiness discipline

The sequential topology is not the source of historical no-progress incidents.
Those incidents arose from manual status parking, stale ownership, aggregate
records exposed as executable work and missing `blocks` edges.

Roadmap therefore treats `bd ready` as necessary provider evidence but not as an
unexplained terminal verdict. A topology/provider disagreement is a Doctor
finding. Functional prerequisites use `blocks`; `blocked` is reserved for an
observed failed or external condition; `deferred` requires an explicit wake
condition or date.

## Migration and distribution

A4S is the canonical source under `skills/roadmap/`. Implementation adapts the
historical Roadmap Markdown bundle and the useful operational rules from
`skills/beads-loop/SKILL.md`; it does not migrate the Beads-loop Python adapter
or tests.

The active `skills/beads-loop/` directory is removed after Roadmap pressure
scenarios pass. Historical ADRs, specs, plans and reports remain unchanged.
There is no alias.

Current Markdown consumers such as A4S README, the Pablontiv profile and
context-save are updated from `beads-loop` or Rootline-roadmap assumptions to
the new Roadmap/Beads contract.

Global installation changes only after merge and explicit authorization. A
runtime symlink must target the stable A4S checkout, never a worktree.

## Verification

Verification is documentation-focused:

1. Run pressure scenarios without Roadmap and preserve observed failures.
2. Write the Markdown skill and references.
3. Run the same scenarios with explicit Roadmap loading.
4. Amend only guidance implicated by an observed failure.
5. Confirm all pressure scenarios pass.
6. Run existing A4S validation, Rootline validation and `git diff --check`.
7. Verify no active global path points to a worktree.

No new Roadmap unit, integration or E2E test suite is introduced.

## Success criteria

- Roadmap is a Markdown-only skill bundle.
- Beads replaces Rootline only as backlog storage and graph provider.
- `roadmap plan`, bare Roadmap, Doctor and loop match the approved interface.
- New materialization uses only `epic/task` and `blocks`.
- Empty readiness is always explained from the complete graph.
- Loop executes one claimed task at a time and uses direct heartbeat commands.
- Closure combines Bead acceptance with `.workspace` DoD.
- Existing backlogs change only through an approved Doctor recipe.
- Pressure scenarios pass without a custom runtime or new unit tests.
- `beads-loop` is removed without a compatibility alias.
