# Plan mode

Plan turns a requested outcome into Beads. It reads freely and mutates nothing before approval.

1. **Read context.** Read the repository paths, workspace config, governed documents and related Beads the request needs (`bd list`, `bd show`, `bd dep list`). If the request only completes existing Beads, use Doctor instead. Ask about missing requirements before proposing. Whenever an existing related Bead is shown to the operator, keep its primary human Description, literal Bead ID, observable Result, and Scope together; show an absent value as missing or unknown without inference, readiness impact, mutation, or backfill.
2. **Propose the graph.** Show every epic and task with the fields `definition_of_ready` requires (`contracts.md`), priorities, `parent-child` links and `blocks` edges. Each task maps to one Bead and fits one session. This is the exact proposed Beads payload; prospective nodes are not existing Beads and do not receive the config's existing-Bead display treatment. Roadmap may label their ID as unassigned or add richer UI as specialization, but never invents a literal provider ID.
3. **Validate.** Only `epic` and `task`, no nested epics, no cycles, every task ready, and every connected group has a task that can start or a named external gate.
4. **Ask for approval** of exactly that graph. A revision needs a new approval.
5. **Create.** Write the approved graph to a temporary file outside the repository (`mktemp`), using `acceptance_criteria` as the field name, then run `bd create --graph "$FILE" --dry-run --json`. Any warning or difference from the approved graph stops here. Otherwise run `bd create --graph "$FILE" --json`.
6. **Verify.** Re-read every created ID (`bd show`, `bd dep list`) and compare types, fields, priorities, parents and edges with the approved graph. Report each created Bead with its primary human Description, real Bead ID, observable Result, and Scope together, using missing or unknown for an absent value without inference, readiness impact, mutation, or backfill. Report any mismatch as `record / field / approved / observed` and leave its repair to Doctor.

## Sizing

- 1–5 independent tasks: root tasks, no epic.
- 6–20 related tasks with one objective: one epic.
- Several objectives: several epics. More than ~20 tasks: split by observable objective.
- A task that needs context from a previous session is too big: split it with `blocks` edges.
- Spikes, bugs, chores and decisions are tasks: "Research …", "Fix …", "Refactor …", "Decide …", each with evidence-based acceptance criteria.
