# Pending-tree mode

Bare Roadmap is read-only. Build the pending tree from complete provider state; provider readiness is evidence, not an unexplained verdict.

## Read the graph

Run:

```bash
bd list --status open,in_progress,blocked,deferred --brief --limit 0 --json
bd dep list bd-a bd-b --json
bd list --ready --brief --sort priority --limit 0 --json
bd count --status closed --json
git log -5 --format='%s%n%b'
```

Resolve the active scope before classification. Bare Roadmap uses the complete pending graph. A scoped Loop uses only the named task or the direct task children of the named epic for ownership classification and candidate selection. Keep out-of-scope records visible when rendering the complete graph, but never let their `in_progress` state create a scoped ownership ambiguity or candidate.

Collect Bead IDs for the git log output: every ID appearing in the subject, body, or trailers of any of those commits (exact literal match, delimited, not as prefix; for example, `a4s-knt` does not match `a4s-knt.1`).

The dependency command is illustrative. Collect every literal non-closed ID returned by the first JSON response and pass each as its own `bd dep list` argument. Never copy `bd-a` or `bd-b` unless those strings are real returned IDs. For each epic and each non-epic root record with children, run `bd list --parent <id> --all --json --limit 0` and count how many have `status == closed` (closed count) versus total. If needed to validate a contract or explain ordinary state, use `bd show <id> --json` for that literal ID.

Keep ordinary tree rendering cheap: do not load every historical comment or provenance row. Read canonical execution evidence explicitly only when needed to explain candidate completeness, stale operational state, a failed gate, closure inconsistency, a stale satisfied prerequisite, or a Doctor finding:

```bash
bd show "$ID" --include-comments --json
bd provenance log "$ID" --json
```

Use `bd comments "$ID" --json` when only the thread is required. Bound every read to the literal affected ID and report which comment, notes result, or provenance row supports the explanation.

Read edge direction as `contracts.md` defines it. Edge types other than `parent-child` and `blocks` are not rendered.

An edge is broken only when `bd show <target> --json` fails. Run it for every edge target absent from the non-closed list; never infer a broken edge from that list alone. A `blocks` edge to an ordinarily completed closed record is a satisfied prerequisite. It is instead a consistency finding when the target was closed as a duplicate, superseded record, or normalized container while its notes or closure evidence disavow outcome completion or identify open successor work. **Provider-ready** means the literal ID appears in the `bd list --ready` response.

Return only the decision tree, candidate result, per-record reasons, and findings in this mode. Route any proposed status, dependency, ownership, or content change through Doctor or Plan; Tree performs no mutation.

## Derive ownership and readiness

1. Account for every non-closed record and all of its dependency edges.
2. Validate type and hierarchy. Exclude epics from execution; they are aggregates even if the provider reports them ready.
3. Validate every task against `contracts.md`. Keep an incomplete task visible, but exclude it from execution.
4. Reject cycles, invalid or broken edges, and stale satisfied-prerequisite edges as findings rather than guessing an order.
5. Before open-task readiness, classify every `in_progress` task inside the active scope from its literal status, assignee, `roadmap_controller_session`, checkpoint metadata, comments, notes, provenance, and Git state. Do not infer whether a session or process is live.
   - Exactly one coherent `in_progress` task is **resumable**. A controller-owned task and a legacy human-assigned task without controller metadata use the same classification. Lease and `started_at` values are non-authoritative.
   - More than one in-scope `in_progress` task is one **ownership ambiguity** finding containing every literal in-scope ID. Produce no candidate and route that complete set to Doctor.
   - An `in_progress` task whose owner or checkpoint evidence is contradictory is not resumable; emit the exact contradiction as a Doctor finding.
   - Controller or checkpoint metadata on a task whose status is not `in_progress` is **stale operational state**. Keep the record's literal status and readiness classification, cite the mismatched fields, and propose no mutation from their presence alone.
6. If exactly one resumable task exists, render it as the next candidate before considering open tasks. This is an explanation of immediate takeover, not a liveness claim or mutation.
7. For tasks whose literal status is `open`, derive topology-ready tasks whose effective `blocks` prerequisites from `contracts.md` are closed and whose pre-start external gates are satisfied. Status alone must not replace a known edge. Execution admission checks do not remove a task from this set.
8. Apply type, hierarchy, deferred-status, and pre-start-external-gate filters equally to topology-ready open tasks and provider-ready open tasks. A provider-ready task excluded solely by a declared pre-start external gate is **externally gated**, not readiness drift; record the provider blind spot explicitly. Never mix an `in_progress` task into this comparison.
9. Compare the remaining literal topology-ready open task IDs with the remaining literal provider-ready open task IDs. On an unexplained difference, emit a **readiness drift** block containing `topology_ready`, `provider_ready`, `topology_only`, and `provider_only`, followed by one classification line for every differing literal ID. Produce no candidate from either set or their intersection; emit a Doctor finding over those IDs and stop selection.
10. Apply the contract-completeness filter to the open-task intersection. The remaining complete open tasks are executable. An incomplete task in the pre-contract intersection is an **incomplete candidate** only when it would outrank every complete executable open task under step 11. Blocked, externally gated, deferred, invalid, or lower-ranked incomplete records remain visible findings but do not stop selection.
11. When more than one open task is executable, render one deterministic next candidate using Beads priority, then greatest reverse-dependency impact, then ID. A resumable task from step 6 always precedes this ordering.

## Render the decision tree

Render the historical Rootline Roadmap decision tree over Beads: an epic is the Outcome, a root task is a direct task, and a `blocks` edge is `blocked_by`. Show what can start and what each start unblocks.

### Terms

- **Topology-ready**: an open task whose effective `blocks` prerequisites are closed and whose pre-start external gates are satisfied. Contract, type, hierarchy, and deferred-state checks do not affect this graph fact; they appear as markers.
- **Pre-start external gate**: a condition the record declares outside its authorized task steps and that can be evaluated before guarded controller acquisition, for example a human, billing, or third-party decision. Read description, design, acceptance criteria, and current notes; name the condition; never infer one from a title. A fresh observation, lock, clean task worktree, validation, or similar check explicitly assigned to the task is an execution admission check instead.
- **Resumable**: the only coherent `in_progress` task inside the active scope. Its current controller or legacy human assignee is observed state for guarded takeover, not evidence of liveness.
- **Ownership ambiguity**: more than one `in_progress` task inside one sequential active scope. The finding contains every literal in-scope ID and prevents selection.
- **Stale operational state**: `roadmap_controller_session` or checkpoint metadata whose record status is not `in_progress`, or execution evidence that contradicts the current owner or checkpoint. Preserve it as evidence; its presence alone authorizes no cleanup or lifecycle change.
- **Incomplete candidate**: a contract-incomplete open task that is otherwise valid, topology-ready, provider-ready, and higher-ranked than every complete executable open task. Other incomplete records remain findings but are not candidates.
- **Contract-complete**: the content of every element of the task list in `contracts.md` is explicitly stated in the Bead. Check each element by content, such as out-of-scope boundaries, initial state, invariants, and sources of truth. Non-empty description or acceptance fields alone are not enough.

### Placement

A **root record** has no `parent-child` parent. It is unrelated to a chain root.

Each non-closed record has exactly one home. `BLOQUEADAS` is an additional index, not a home.

1. **Branch `├─► <id> <title> — <closed>/<total> completadas, N pendientes`**: every epic with non-closed children, and every non-epic record with non-closed children, which gets `⚠jerarquía` on its header. Its children are its members. An epic with exactly one non-closed child, where that child has no `blocks` edge to or from another open record, is not a branch; that child goes to `QUICK WINS`.
2. **`TASK DIRECTA`**: root records without children that have at least one `blocks` edge to or from another open record.
3. **`QUICK WINS`**: root records without children and without `blocks` edges to or from another open record, plus the single child from rule 1.
4. **`BLOQUEADAS`**: every record that is not topology-ready, listed again as `<id> [blocked_by: <ids and/or gate>]`. A gated record without `blocks` edges lives only here.

Inside a branch or `TASK DIRECTA`, a **chain root** is a topology-ready member that is the prerequisite of at least one open record. Render members in this order:

1. For each chain root, write its line. Then, for each open dependent that it unblocks, write an indented `↓ desbloquea` followed by the dependent's line, and repeat the step for that dependent's own dependents. A dependent appears once, under its first prerequisite in ID order, followed by `(+ also waits on <ids>)` when it has other open prerequisites.
2. Then list members that have no `blocks` edge to or from another open record.

Never list a dependent again at branch level. A branch whose members share an open `blocks` edge must show at least one `↓ desbloquea`; a flat list of such a branch is wrong.

### Node format

Every node is `<id> <title> [<status>]`, where status is the literal Beads status. Follow it with `[resumable]`, `[ownership ambiguity]`, or `[stale?]` when that operational classification applies. A `blocked` status whose prerequisites are all closed also receives `[stale?]`. Then show at most one marker. When several marker rules apply, show only the first applicable one:

1. `⚠tipo`: type other than `epic` or `task`.
2. `⚠jerarquía`: parent is not an epic, or the record is a non-epic with children.
3. `controller:<session|legacy-owner>`: the literal controller session or legacy owner observed on an `in_progress` task; it never asserts liveness.
4. `⚠deferred`: deferred to a declared time or condition.
5. `⚠contrato`: task that is not contract-complete.

One coherent `[resumable]` task is executable by guarded takeover before open work. An open topology-ready node without an exclusion marker that is also provider-ready is executable now. A task acquires its controller before performing contract execution admission checks; a failed check stops the task stage without retroactively turning the task into externally gated work.

### Ordering

Sort branches by score, descending, then by the best Beads priority among members, then by pending count ascending, then by ID. Always put `TASK DIRECTA` after the branches and `QUICK WINS` last:

```text
score = + 50 if a member's ID appears in the subject, body, or trailers of the last 5 commits
        + 10 × total dependents across the members' outgoing blocks edges
        + 5  if any member is in_progress
        - 3  × non-closed members
        - 100 if no member is topology-ready
```

where *total dependents* is the count of unique open dependent records (a record unblocked by several members, or via several edges, counts once).

Order chain roots and quick wins by Beads priority, then by ID. Use `├──` for every `BLOQUEADAS` entry except the last, which uses `└──`.

### Layout

```text
ROADMAP DECISION TREE — <closed>/<closed + non-closed> completados

Qué objetivo priorizar?
│
├─► <epic-id> <title> — <closed>/<total> completadas, N pendientes
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
├─ Hay exactamente una task resumable en scope? → tomarla primero
├─ Hay task que desbloquea muchas otras? → priorizarla
├─ Quiero progreso rápido? → quick win
└─ Si no → siguiente candidato determinista
```

Resolve each `CRITERIOS` line with literal IDs from this backlog. After the tree, give the resumable candidate from step 6, otherwise the open-task candidate from step 11, or **no executable task**, then findings.

### Reasons and findings

A record's home, status, and marker must give it one primary reason, naming the relevant IDs or declared condition:

- executable now;
- blocked by named tasks;
- externally gated;
- resumable by guarded takeover, naming the observed controller or legacy owner;
- ownership ambiguity, naming every literal in-scope `in_progress` ID;
- deferred to a declared time or condition;
- contract-incomplete;
- invalid hierarchy or type;
- stale operational state; or
- aggregate epic, which is the branch header.

Also report cycles, broken edges, stale satisfied-prerequisite edges, and readiness drift as findings. When provider-ready is empty but non-closed records exist, print a bounded reason table with one row per non-closed task (`id`, literal status, primary reason, named blocker or gate) before **no executable task**. Report **no executable task** only after the full non-closed graph has been inspected and every record has one reason. Report backlog completion only when the complete non-closed list itself is empty.
