---
name: beads-loop
description: Use when executing the current repository's complete Beads backlog sequentially through Pi todos.
metadata:
  author: pablontiv
user-invocable: true
---

# Beads Todo Loop

Run the repository-local Beads backlog as one sequential Pi session. Beads is the durable backlog; Pi `todo` is this session's scheduler. Accept no arguments and stay in the current repository.

## Script

Resolve `scripts/beads_todo_loop.py` relative to this skill into `BEADS_TODO_LOOP`; do not change the working directory. The script emits one compact JSON envelope per command.

1. Run `beads_todo_loop.py snapshot` as `python3 "$BEADS_TODO_LOOP" snapshot`.
2. On `snapshot`, create one `todo` for every `details.todos` record. Store `bead_id`, `key`, `priority`, and `rank` as metadata.
3. In a second deterministic pass, resolve every script `blocked_by` key to its created todo ID and add it with `blockedBy`.
4. Report `details.withheld`; do not schedule it automatically.

## Per-Bead loop

Select the unblocked todo with the lowest script `rank`, mark it `in_progress`, and run:

```sh
python3 "$BEADS_TODO_LOOP" detail --bead "$BEAD_ID"
```

Read its description and acceptance criteria. Use only the relevant discipline:

- `backscroll` when prior work can change the result;
- `systematic-debugging` for unexpected failure;
- `test-driven-development` before production-code changes;
- `executing-plans` when the Bead names an approved plan;
- `verification-before-completion` before the verdict.

Perform only the selected Bead, preserve unrelated changes, write bounded in-repository evidence, and run its validation. Then run:

```sh
python3 "$BEADS_TODO_LOOP" finalize --bead "$BEAD_ID" --verdict pass|fail --evidence "$EVIDENCE_PATH"
```

On `finalized pass`, mark the todo `completed` with `metadata.outcome=pass` and the evidence path. On `finalized fail`, first create one pending failure-gate todo for that Bead and add its ID to `blockedBy` on every session todo whose script `blocked_by` contains that Bead key; then mark the failed work todo `completed` with `metadata.outcome=fail` and the evidence path. The pending gate preserves every dependent block while independent todos continue.

After every session todo is completed, run one final `snapshot`. Materialize only newly seen open Beads; if none remain, report completion and withheld entries. Stop and report the full envelope on any other result.
