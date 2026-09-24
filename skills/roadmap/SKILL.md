---
name: roadmap
description: Use when planning work into Beads, inspecting pending backlog topology, aligning existing Beads with the Roadmap contract, or implementing the repository backlog sequentially.
argument-hint: "[plan|doctor|loop] [requirements]"
user-invocable: true
metadata:
  author: pablontiv
  updated: "2026-09-24"
---

# Roadmap

Roadmap is a Markdown workflow over the current repository and its Beads backlog. Interpret `$ARGUMENTS` without changing the working directory, then load exactly one mode recipe:

| Input | Reference |
| --- | --- |
| starts with `plan` | `references/plan.md` |
| empty | `references/tree.md` |
| starts with `doctor` | `references/doctor.md` |
| starts with `loop` | `references/loop.md` |

Reject any other input and show the four supported forms. Read `references/contracts.md` before applying the selected recipe.

## Common invariants

- Beads is the durable state for backlog records, hierarchy, dependencies, status, priority, claims, and execution notes.
- The effective `.workspace/config.yaml` is the authority for repository Definition of Done (DoD) and delivery policy.
- Rootline governs project documentation; it is not backlog storage.
- Roadmap creates and executes only `epic` and `task` records. An epic is an optional, non-executable aggregate.
- `parent-child` expresses hierarchy only. Only `blocks` orders execution.
- No mode silently broadens scope, invents requirements, or converts an ambiguity into a mutation.

Follow approval gates literally. A request to hurry, infer intent, parallelize tasks, or skip an unknown control does not override them.
