---
name: beads-loop
description: Use when executing the current repository's complete Beads backlog autonomously through parallel Pi todo waves.
metadata:
  author: pablontiv
  parallel-independent-tasks: true
user-invocable: true
---

# Beads Todo Loop

Run the repository-local Beads backlog until no executable work remains. Beads
is the durable graph; Pi `todo` is only the current session's projection.
Accept no arguments and stay in the current repository.

## Discover the ready graph

1. Query `bd list --ready --brief --sort priority --limit 0 --json`.
2. Before scheduling each candidate, read `bd show <bead-id> --json` and
   `bd dep list <bead-id> --json`.
3. Treat `ready` as input, not authority. Withhold:
   - epics that aggregate children;
   - work held by another active assignee or lease;
   - work whose contract exposes an unmet external precondition.
4. For an expired lease use Beads reclaim; never claim over another actor.
5. Materialize only eligible work into Pi todos. Preserve every real `blocks`
   relation; `parent-child` is hierarchy, not execution order.

## Form and execute a parallel wave

A parallel wave contains all eligible ready Beads. Sort deterministically by
priority then ID, but do not serialize independent Beads merely because one is
listed first.

For each wave candidate:

1. Atomically run `bd update <bead-id> --claim`.
2. If the claim fails, withhold that Bead; do not retry or affect other claims.
3. Create exactly one Pi todo with subject `bead:<bead-id> — <title>`.
4. Store metadata `source=beads-loop`, `bead_id=<bead-id>`, canonical key,
   priority, wave number, and assignee.
5. Before adding the wave, remove stale Beads-loop todos that are pending or
   in-progress but are not backed by a currently claimed Bead. Preserve
   completed history and every unrelated todo.
6. Reject duplicate active todos with the same `bead_id`.
7. Mark the todo `in_progress` before work.

Dispatch one worker per successfully claimed Bead concurrently when the harness
supports parallel agents. Each worker reads the full Bead contract and changes
only that scope. Shared live-writer or file conflicts reveal a missing graph
edge: stop the conflicting lane, add a justified `blocks` edge only when the
relationship is deterministic, validate the graph, and recalculate `ready`.
Never invent order from narrative, names, or parentage.

Use history, debugging, TDD, plans, or review only when their concrete trigger
exists. Preserve scope, ownership, evidence, verification, and stop/recovery
boundaries.

## Record outcomes

- **Pass:** attach concise evidence, close the Bead, re-read it, and complete its
  Pi todo.
- **Blocked/fail:** attach the exact cause and evidence, set the contract-required
  non-closed status, and complete only its Pi execution todo. Do not create a
  synthetic Pi failure-gate; existing `blocks` edges keep dependents unavailable.
- A failed guard, ambiguous external effect, or lost ownership stops that lane
  without a second mutation. Independent lanes continue.

After the wave settles, recalculate `ready`. Closing A automatically makes B
eligible when B's only remaining `blocks` dependency was A. Materialize the new
wave and continue autonomously. Stop only when no claimable ready Beads remain;
report completed, blocked, assigned, epic, and externally gated work with its
canonical reason.
