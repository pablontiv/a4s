# Tree mode

Bare Roadmap is read-only: it renders the pending backlog as a decision tree and names the next candidate.

## Read the graph

```bash
bd list --status open,in_progress,blocked,deferred --brief --limit 0 --json
bd dep list <each non-closed id> --json
bd list --ready --brief --sort priority --limit 0 --json
bd count --status closed --json
git log -5 --format='%s%n%b'
```

Pass every literal non-closed ID to `bd dep list`. For each epic, count closed versus total children with `bd list --parent <id> --all --json --limit 0`. Use `bd show <id> --json` only when a record's fields are needed. Read comments or provenance only to explain one specific record.

## Classify

For each open task:

- **topology-ready**: every effective prerequisite is closed and no pre-start external gate is pending;
- **provider-ready**: its ID is in the `bd list --ready` response;
- **ready**: it meets `definition_of_ready` from the effective config (`contracts.md`);
- **executable**: topology-ready, provider-ready, ready, and not deferred.

For `in_progress` tasks: exactly one coherent task in scope is **resumable**; more than one, or one whose owner or checkpoint contradicts Git, is an **ownership finding** and is excluded.

A task that is topology-ready but not provider-ready, or the reverse, is a **readiness drift** finding for that ID only; it is excluded, and the rest of the tree is unaffected.

Findings never hide other executable work.

## Render

An epic is a branch; a `blocks` edge renders as `↓ desbloquea`. Each non-closed record has one home:

1. **Branch** `├─► <id> <title> — <closed>/<total> completadas, N pendientes`: each epic with non-closed children (a non-epic with children also gets `⚠jerarquía`). An epic with a single open child that has no `blocks` edges is not a branch; the child goes to `QUICK WINS`.
2. **`TASK DIRECTA`**: root tasks with a `blocks` edge to or from another open record.
3. **`QUICK WINS`**: root tasks with no such edges, plus the single child from rule 1.
4. **`BLOQUEADAS`**: an extra index of records that are not topology-ready, as `<id> [blocked_by: <ids or gate>]`.

Inside a branch or `TASK DIRECTA`, write each topology-ready prerequisite, then its dependents indented under `↓ desbloquea`, recursively; a dependent appears once, under its first prerequisite by ID, with `(+ also waits on <ids>)` when needed. Then list members without edges.

Node: `<id> <title> [<status>]`, then `[resumable]` when it applies, then at most one marker in this order: `⚠tipo`, `⚠jerarquía`, `controller:<session>`, `⚠deferred`, `⚠contrato` (fails `definition_of_ready`), `⚠drift`.
For `controller:<session>`, render the concrete resolved session value rather than the placeholder.

Order branches by score (descending), then best priority, then fewer pending, then ID; `TASK DIRECTA` and `QUICK WINS` go last.

```text
score = + 50 if a member's ID appears in the last 5 commits
        + 10 × unique open dependents of the members
        + 5  if a member is in_progress
        - 3  × non-closed members
        - 100 if no member is topology-ready
```

Before rendering the topology skeleton, present every existing Bead in it with the primary human Description, literal Bead ID, observable Result, and Scope together. Read those values from the record; display an absent value as missing or unknown without inference, readiness impact, mutation, or backfill. Roadmap may add UI details such as Difference. The skeleton omits these adjacent presentation details only to keep topology visible.

```text
ROADMAP DECISION TREE — <closed>/<closed + non-closed> completados

├─► <epic-id> <title> — <closed>/<total> completadas, N pendientes
│   <id> <title> [open]
│      ↓ desbloquea
│   <id> <title> [open] (+ also waits on <id>)
│   <id> <title> [open] ⚠contrato
│
├─► TASK DIRECTA
│   <id> <title> [open]
│
└─► QUICK WINS
    <id> <title> [open]

BLOQUEADAS
└── <id> [blocked_by: <ids>]
```

## Candidate

After the tree, name the next candidate: the resumable task if there is one, otherwise the first executable task in tree order (priority, then unique open dependents, then ID). If none is executable, give one line per open task with its reason (blocked by, gated, deferred, not ready, ownership, drift). Then list findings: cycles, broken edges, invalid types or hierarchy, ownership, drift, and tasks failing `definition_of_ready`.
