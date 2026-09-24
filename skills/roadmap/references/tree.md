# Pending-tree mode

Bare Roadmap is read-only. Build the pending tree from complete provider state; provider readiness is evidence, not an unexplained verdict.

## Read the graph

Run:

```bash
bd list --status open,in_progress,blocked,deferred --brief --limit 0 --json
bd dep list bd-a bd-b --json
bd list --ready --brief --sort priority --limit 0 --json
```

The dependency command is illustrative. Collect every literal non-closed ID returned by the first JSON response and pass each as its own `bd dep list` argument. Never copy `bd-a` or `bd-b` unless those strings are real returned IDs. If needed to validate a contract or explain state, use `bd show <id> --json` for that literal ID.

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

## Render every record

Show epic/task hierarchy and `blocks` relationships. Give every non-closed record one primary reason, naming relevant IDs or the declared condition:

- executable now;
- blocked by named tasks;
- externally gated;
- owned by another session;
- deferred to a declared time or condition;
- contract-incomplete;
- invalid hierarchy or type;
- stale operational state; or
- aggregate epic.

Also report cycles, broken edges, and readiness drift as findings. An empty provider-ready response alone never means complete. Report **no executable task** only after the full non-closed graph has been inspected and every record has one reason. Report backlog completion only when the complete non-closed list itself is empty.
