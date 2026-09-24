# Pending-tree mode

Bare Roadmap is read-only. Build the pending tree from complete provider state; provider readiness is evidence, not an unexplained verdict.

## Read the graph

Run:

```bash
bd list --status open,in_progress,blocked,deferred --brief --limit 0 --json
bd dep list bd-a bd-b --json
bd list --ready --brief --sort priority --limit 0 --json
bd count --status closed --json
```

The dependency command is illustrative. Collect every literal non-closed ID returned by the first JSON response and pass each as its own `bd dep list` argument. Never copy `bd-a` or `bd-b` unless those strings are real returned IDs. If needed to validate a contract or explain state, use `bd show <id> --json` for that literal ID.

Read edge direction as `contracts.md` defines it. Edge types other than `parent-child` and `blocks` are not rendered.

An edge is broken only when `bd show <target> --json` fails. Run it for every edge target absent from the non-closed list; never infer a broken edge from that list alone. A `blocks` edge to a closed record is a satisfied prerequisite, not a finding. **Provider-ready** means the literal ID appears in the `bd list --ready` response.

Do not mutate status, dependencies, ownership, or content in this mode.

## Derive readiness

1. Account for every non-closed record and all of its dependency edges.
2. Validate type and hierarchy. Exclude epics from execution; they are aggregates even if the provider reports them ready.
3. Validate every task against `contracts.md`. Keep an incomplete task visible, but exclude it from execution.
4. Reject cycles and invalid or broken edges as findings rather than guessing an order.
5. Derive the topology frontier: complete tasks whose `blocks` prerequisites are closed and whose explicit external gates are satisfied. Status alone must not replace a known edge.
6. Compare literal frontier task IDs with literal provider-ready IDs. The executable set is their intersection after contract, type, hierarchy, ownership, and external-gate checks.
7. A difference between the valid topology frontier and provider-ready set is **readiness drift**. Do not select through it; route the diagnosis to Doctor.
8. When more than one task is executable, render one deterministic next candidate using: a currently owned valid task first, then Beads priority, then greatest reverse-dependency impact, then ID. This is an explanation, not a claim.

## Render the decision tree

Render the historical Rootline Roadmap decision tree over Beads: an epic is the Outcome, a root task is a direct task, and a `blocks` edge is `blocked_by`. Show what can start and what each start unblocks.

### Terms

- **Topology-ready**: every `blocks` prerequisite is closed and every explicit external gate is satisfied. Contract, type, hierarchy, and ownership checks do not affect it; they appear as markers.
- **External gate**: a condition the record itself declares outside repository work, for example an acceptance criterion that requires a human, billing, or third-party action. Read the description and acceptance criteria of each task; name the declared condition; never infer one from a title alone.
- **Stale claim**: any of assignee, claim, or session metadata on a record whose status is not `in_progress`; or a claim whose session no longer exists.
- **Contract-complete**: the content of every element of the task list in `contracts.md` is explicitly stated in the Bead. Check each element by content, such as out-of-scope boundaries, initial state, invariants, and sources of truth. Non-empty description or acceptance fields alone are not enough.

### Placement

A **root record** has no `parent-child` parent. It is unrelated to a chain root.

Each non-closed record has exactly one home. `BLOQUEADAS` is an additional index, not a home.

1. **Branch `├─► <id> <title> — N pendientes`**: every epic with non-closed children, and every non-epic record with non-closed children, which gets `⚠jerarquía` on its header. Its children are its members. An epic with exactly one non-closed child, where that child has no `blocks` edge to or from another open record, is not a branch; that child goes to `QUICK WINS`.
2. **`TASK DIRECTA`**: root records without children that have at least one `blocks` edge to or from another open record.
3. **`QUICK WINS`**: root records without children and without `blocks` edges to or from another open record, plus the single child from rule 1.
4. **`BLOQUEADAS`**: every record that is not topology-ready, listed again as `<id> [blocked_by: <ids and/or gate>]`. A gated record without `blocks` edges lives only here.

Inside a branch or `TASK DIRECTA`, a **chain root** is a topology-ready member that is the prerequisite of at least one open record. Render members in this order:

1. For each chain root, write its line. Then, for each open dependent that it unblocks, write an indented `↓ desbloquea` followed by the dependent's line, and repeat the step for that dependent's own dependents. A dependent appears once, under its first prerequisite in ID order, followed by `(+ also waits on <ids>)` when it has other open prerequisites.
2. Then list members that have no `blocks` edge to or from another open record.

Never list a dependent again at branch level. A branch whose members share an open `blocks` edge must show at least one `↓ desbloquea`; a flat list of such a branch is wrong.

### Node format

Every node is `<id> <title> [<status>]`, where status is the literal Beads status, followed by `[stale?]` for a stale claim, or for a `blocked` status whose prerequisites are all closed, and at most one marker. When several rules apply, show only the first applicable one:

1. `⚠tipo`: type other than `epic` or `task`.
2. `⚠jerarquía`: parent is not an epic, or the record is a non-epic with children.
3. `⚠owned`: claimed by another live session.
4. `⚠deferred`: deferred to a declared time or condition.
5. `⚠contrato`: task that is not contract-complete.

A topology-ready node without a marker that is also provider-ready is executable now.

### Ordering

Sort branches by score, descending, then by the best Beads priority among members, then by pending count ascending, then by ID. Always put `TASK DIRECTA` after the branches and `QUICK WINS` last:

```text
score = + 10 × total dependents across the members' outgoing blocks edges
        + 5  if any member is in_progress
        - 3  × non-closed members
        - 100 if no member is topology-ready
```

Order chain roots and quick wins by Beads priority, then by ID. Use `├──` for every `BLOQUEADAS` entry except the last, which uses `└──`.

### Layout

```text
ROADMAP DECISION TREE — <closed>/<closed + non-closed> completados

Qué objetivo priorizar?
│
├─► <epic-id> <title> — N pendientes
│   <id> <title> [open] ⚠tipo
│      ↓ desbloquea
│   <id> <title> [open]
│      ↓ desbloquea
│   <id> <title> [open] (+ also waits on <id>)
│   <id> <title> [open] ⚠contrato
│
├─► TASK DIRECTA
│   <id> <title> [open] ⚠contrato
│      ↓ desbloquea
│   <id> <title> [open]
│
└─► QUICK WINS
    <id> <title> [open] [stale?]

BLOQUEADAS
├── <id> [blocked_by: <ids>]
└── <id> [blocked_by: gate <declared condition>]

CRITERIOS
├─ Hay trabajo in_progress? → cerrarlo primero
├─ Hay task que desbloquea muchas otras? → priorizarla
├─ Quiero progreso rápido? → quick win
└─ Si no → siguiente candidato determinista
```

Resolve each `CRITERIOS` line with literal IDs from this backlog. After the tree, give the next executable candidate from step 8 or **no executable task**, then findings.

### Reasons and findings

A record's home, status, and marker must give it one primary reason, naming the relevant IDs or declared condition:

- executable now;
- blocked by named tasks;
- externally gated;
- owned by another session;
- deferred to a declared time or condition;
- contract-incomplete;
- invalid hierarchy or type;
- stale operational state; or
- aggregate epic, which is the branch header.

Also report cycles, broken edges, and readiness drift as findings. An empty provider-ready response alone never means complete. Report **no executable task** only after the full non-closed graph has been inspected and every record has one reason. Report backlog completion only when the complete non-closed list itself is empty.
