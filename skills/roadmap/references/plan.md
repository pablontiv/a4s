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
