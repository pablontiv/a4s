---
name: roadmap
description: Use when planning work into Beads, inspecting pending backlog topology, aligning existing Beads with the Roadmap contract, or implementing the repository backlog sequentially.
argument-hint: "[plan|doctor|loop] [requirements]"
user-invocable: true
metadata:
  author: pablontiv
  updated: "2026-09-25"
---

# Roadmap

Roadmap is a Markdown workflow over the current repository and its Beads backlog. Interpret `$ARGUMENTS` without changing the working directory, then load exactly one entry-mode recipe:

| Input | Reference |
| --- | --- |
| starts with `plan` | `references/plan.md` |
| empty | `references/tree.md` |
| starts with `doctor` | `references/doctor.md` |
| `loop` (no argument) | `references/loop.md` |
| `loop <id>` (exactly one Bead ID) | `references/loop.md`, scoped to that ID |

Reject any other public input, including `loop` with more than one argument or any non-ID filter, and show the five supported forms. Read `references/contracts.md` before applying the selected recipe.

An entry recipe may follow only the internal transitions it declares. Loop condition 2 transitions internally to Doctor read-only recovery on the exact affected scope derived by `loop.md` §2.1. Doctor runs Plan steps 1–4 for contract elicitation and, only after exact payload approval when Contract backfill step 6 requires new records, Plan steps 5–10 to materialize and verify those records. These transitions stay in the current Roadmap invocation and are not commands for the operator to retype.

## Common invariants

- Beads is the durable state for backlog records, hierarchy, dependencies, status, priority, session-controller ownership, checkpoint metadata, and execution notes.
- Each Bead is the canonical operational record: bounded role handoffs are comments, lifecycle results are guarded notes updates, and external references are provenance; Roadmap creates no execution report documents.
- The effective `.workspace/config.yaml` is the authority for repository Definition of Done (DoD) and delivery policy.
- Rootline governs project documentation; it is not backlog storage.
- Roadmap creates and executes only `epic` and `task` records. An epic is an optional, non-executable aggregate.
- `parent-child` expresses hierarchy only. Only `blocks` orders execution.
- When scope, requirement, or authority is ambiguous, preserve the literal known scope, mark the exact element `unknown`, and ask for the single material value needed to resolve it before mutation. No mode silently broadens scope, invents requirements, or converts an ambiguity into a mutation.
- An approval gate authorizes the exact mutation payload displayed by the owning mode, not invocation of that mode. When a complete proposal exists, show it and ask the operator to approve exactly, request adjustments, or reject it.
- Pending non-executable work is a `BACKLOG EMERGENCY`, not backlog hygiene: show its magnitude, literal blocker, stranded next candidate when one exists, and one concrete policy-valid continuation.

Follow approval gates literally. A request to hurry, infer intent, parallelize tasks, or skip an unknown control does not override them.
