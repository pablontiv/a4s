# Plan mode

Use this recipe when `$ARGUMENTS` starts with `plan`. The remaining text is the requested outcome and constraints. Planning may inspect the repository and Beads, but it must not mutate Beads before an explicit approval turn.

## Recipe

1. **Read bounded context.** Read only repository paths, effective workspace guidance, governed documents, and related Beads needed to understand the request. Inspect related records directly with read-only `bd list`, `bd show`, and `bd dep list` calls. If requirements are missing or ambiguous, ask questions and make no write.
2. **Propose the complete graph.** Show the full optional-epic/task tree, every contract field from `contracts.md`, priorities when relevant, parent-child links, and every `blocks` edge. Each proposed task maps to exactly one Bead.
3. **Validate before offering a write.** Confirm only `epic` and `task` types are present, no epic is nested, every task fits one session, every contract is complete, and the graph has no cycle. Every active graph component must have an executable root task whose internal blockers are satisfied, or a named explicit external gate.
4. **Ask for approval.** Present the complete proposal in one bounded view, including all intended records and edges, and explicitly ask whether to materialize exactly that proposal. Until the user approves, do not create a graph file and do not run a mutating `bd` command. Revisions invalidate earlier approval.
5. **Write one exact graph input.** After approval only, create the exact approved Beads graph input below `.superpowers/roadmap/`, at `.superpowers/roadmap/approved-plan.json`. This ignored temporary input is not a durable backlog mirror. In graph nodes use `acceptance_criteria`, never `acceptance`.
6. **Dry-run the graph.** Run exactly:

   ```bash
   bd create --graph .superpowers/roadmap/approved-plan.json --dry-run --json
   ```

7. **Stop on any concern.** Treat any warning, unknown field, invalid hierarchy, cycle, parse ambiguity, or difference from the approved proposal as failure. Report it without applying or editing around it. A changed graph requires a new complete presentation and explicit approval.
8. **Apply unchanged input.** Only after a clean dry run, run exactly:

   ```bash
   bd create --graph .superpowers/roadmap/approved-plan.json --json
   ```

9. **Read back provider state.** From the create response, collect every literal created ID. Re-read each record with `bd show <id> --json`; pass each created ID as its own argument to `bd dep list <id>... --json`. Verify IDs, types, titles, descriptions, designs, `acceptance_criteria`, priorities, parent links, and all `blocks` edges against the approved graph.
10. **Report, do not improvise.** Report exact IDs and verification results. If apply or readback is ambiguous or mismatched, preserve the outputs and report the mismatch. Do not invent a rollback, retry, duplicate creation, or corrective mutation; route alignment work to an explicitly approved Doctor session.

## Sizing and vocabulary

This section guides when to create an epic, group related tasks, and how to normalize terminology.

### When to use an epic vs. standalone tasks

Beads roadmap supports two types: `epic` (optional, non-executable aggregate) and `task` (one-session executable unit). Choose based on the scope of related work:

- **1–5 independent tasks**: Create tasks directly at repository root. Epics are not required.
- **6–20 related tasks sharing a common objective**: Group tasks under one epic.
- **Multiple independent objectives**: Create separate epics.
- **Outcome exceeds ~20 tasks**: Split by observable objective, not by artificial layers.

An epic is never a selection, claim, or implementation candidate. It exists only to group related tasks and declare shared invariants, success criteria, and scope boundaries.

### Task sizing

Every task must execute in one implementation session. A session is a single, uninterrupted work interval that produces reviewable, verifiable output without requiring carry-over context into the next session.

If a task spans multiple sessions or depends on historical context from a previous session, reconsider its scope:
- Break it into smaller tasks with explicit dependencies (`blocks` edges).
- Elevate related work under a common epic to declare shared invariants and success criteria.
- Ensure each task contains all context needed for execution in isolation.

### Vocabulary normalization

Roadmap creates only `epic` and `task` types. Other work categories (such as spikes, bugs, chores, or decisions) are expressed as tasks with appropriate titles and acceptance criteria, not as distinct Beads types.

The following table maps common planning terminology to Beads types:

| User/Rootline term | Beads type | How to express | Notes |
|---|---|---|---|
| Outcome, Objetivo, Feature goal | epic | Group related tasks; declare objective, success criteria, invariants | Epic is non-executable; it aggregates |
| Task, Tarea, Feature work, Implementation | task | Direct task at root or under an epic; one session | Every task fits one session |
| Spike, Investigation, Research | task | Title: "Research [topic]"; describe investigation scope and acceptance criteria | Frame output as deliverable evidence, not "to learn" |
| Bug, Defect | task | Title: "Fix [specific symptom]"; link to failing test or reproduction steps | Include regression check in acceptance criteria |
| Chore, Maintenance, Refactor | task | Title: "Refactor [component]" or "Update [dependency]"; scope constraints and invariants | Risk assessment in design; test coverage requirement |
| Decision, ADR, RFC | task | Title: "Decide [specific question]"; record decision record in repository; link in notes | Outcome: approved decision + implementation readiness |
| Feature request | spike → task(s) | First task: scope the feature as investigation (spike); outputs become scope for follow-up tasks | Separate discovery from implementation |

Sources: Rootline Roadmap (rootline .claude/skills/roadmap, commit b0fe817^): framework-reference.md "Escala", autonomous-mode.md "Normalizar vocabulario".
