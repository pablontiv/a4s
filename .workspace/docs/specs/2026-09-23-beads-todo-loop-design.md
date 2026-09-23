---
tipo: spec
---
# Beads todo loop design

## Goal

Make `/beads-loop` execute one repository-local Beads backlog sequentially through Pi `todo`. Beads remains the durable source of work and dependencies; `todo` is the ephemeral per-session scheduler. The loop must not create claims, leases, heartbeats, timers, a queue daemon, or a second durable state store.

## Evidence and decision

The prior flow invoked `bd ready --claim`. Its Homeserver claim envelope for `hs-dzt` reported a five-minute `lease_expires_at`; finalization after expiration returned `finalize_failed`. The installed Beads help documents `--claim` as the atomic claim operation. ADR 0035 therefore supersedes ADR 0034: deterministic projection and non-leasing finalization replace claim ownership.

## Boundaries

- One invocation operates only in its current Git repository with `.beads/`.
- No `roadmapctl`, `brainstorming`, worktree, clean-CWD, or conversational-approval gate belongs to the loop.
- Existing unrelated changes are preserved and excluded from the active Bead's evidence.
- Repository-local safety requirements and an active Bead's explicit external-effect contract still apply. The loop does not create authorization for live or destructive effects.
- Homeserver uses `tooling/beads/bd.sh`; other repositories use `bd` unless a repository-local deterministic override is configured.
- The loop never invokes `bd ready --claim`, `bd update --claim`, or any lease-renewal operation.

## Deterministic script contract

`skills/beads-loop/scripts/beads_todo_loop.py` is a standard-library Python command runner and JSON normalizer. It resolves the canonical Beads command, executes the deterministic provider commands, and emits exactly one versioned compact JSON envelope per invocation.

### `snapshot`

1. Run the canonical command's read-only `list --status open,in_progress,blocked --brief --limit 0 --json`, one batched `dep list <open-ids> --json`, and `list --ready --brief --sort priority --limit 0 --json` operations.
2. Normalize the complete non-closed graph without fetching Bead prose from the list operations or sending descriptions, acceptance criteria, notes, or provider internals to the LLM.
3. Emit:

```json
{
  "schema_version": 2,
  "kind": "snapshot",
  "details": {
    "todos": [
      {
        "key": "bead:hs-a",
        "id": "hs-a",
        "title": "Implement A",
        "priority": 1,
        "rank": 2,
        "blocked_by": ["bead:hs-b"],
        "ready": false
      }
    ],
    "withheld": [
      {"id": "hs-old", "title": "Legacy work", "status": "in_progress"}
    ]
  }
}
```

`todos` contains only `open` Beads. Ready Beads retain their provider-ready rank; all other open Beads sort after them by priority and ID. The script emits this ordinal `rank` so the LLM never infers a tie-break. Only dependency edges whose type is `blocks` populate `blocked_by`; `parent-child` is hierarchy and never blocks a `todo`. `withheld` reports `blocked` and legacy `in_progress` Beads but never schedules them automatically.

### `detail --bead ID`

Run `show ID --json` and return the selected Bead's ID, title, description, acceptance criteria, and status. It is the only operation that exposes full Bead text to the LLM. It rejects an empty, malformed, or unknown ID.

### `finalize --bead ID --verdict pass|fail --evidence PATH`

Require a regular, non-symlinked evidence file resolving below the current repository. Then:

- `pass`: run `update ID --status closed --append-notes "PASS evidence=PATH"`.
- `fail`: run `update ID --status blocked --append-notes "FAIL evidence=PATH"`.

Re-read the exact ID and emit `finalized` only when its observed final status is `closed` or `blocked` for the selected verdict. The operation never checks or writes assignee, heartbeat, lease, or `in_progress` state.

## Skill flow

1. Run `snapshot` once.
2. Create one `todo` for every `details.todos` record, storing `bead_id`, priority, and the script key in metadata. In a second deterministic pass, translate `blocked_by` keys to created `todo` IDs.
3. Repeatedly take the next unblocked `todo` in the order returned by the script and mark it `in_progress`.
4. Run `detail` for its `bead_id`; invoke only the relevant Superpowers discipline for that Bead:
   - `backscroll` when prior work may change execution;
   - `systematic-debugging` for unexpected behavior;
   - `test-driven-development` before production code changes;
   - `executing-plans` when the Bead names an approved plan;
   - `verification-before-completion` before the completion verdict.
5. Perform only the Bead's scope, write bounded in-repository evidence, and run its applicable validation.
6. Run `finalize`. Mark the associated `todo` `completed`, with metadata `outcome=pass|fail` and the evidence path. A `fail` is processed work, not a reason to stop independent todos.
7. After all session todos are processed, run one final `snapshot`. Add only previously unseen `open` Beads and continue; if none exist, report complete plus any `withheld` entries.

The terminal conditions are malformed provider output, unavailable repository/provider, invalid evidence, or an unsuccessful finalization. The loop reports the exact envelope and does not choose another Bead manually after a terminal failure.

## Legacy state migration

The new loop does not adopt existing `in_progress` Beads automatically. They appear in `withheld`. A separate, explicitly authorized recovery can return an abandoned legacy Bead to `open` after read-only inspection; this is outside normal loop execution and must never run during E2E.

## TDD

Write each test before the matching implementation:

1. `snapshot` projects a fixture graph into compact ordered records, strips full text, maps only `blocks`, and includes no `--claim` command.
2. `detail` returns text only for one valid selected Bead and rejects malformed IDs.
3. `finalize` rejects outside, symlinked, and absent evidence; it emits the exact non-leasing `update` command for both verdicts and verifies the resulting status.
4. The skill contract test requires initial `snapshot`, full `todo` materialization, one active `detail`, per-Bead Superpowers routing, and final snapshot; it forbids claim, lease, heartbeat, timer, `roadmapctl`, and `brainstorming`.

## End-to-end proof

### A4S fixture

Create a disposable Git and Beads repository with `A → B` and independent `C`. Exercise the script and Pi skill against it. Assert compact projection and order, one `todo` per open Bead, `B` blocked by `A`, evidence-backed `closed`/`blocked` outcomes, no lease field or claim command, and final empty snapshot.

### Homeserver fixture

Create a disposable Homeserver copy with isolated Beads state. Invoke its canonical `tooling/beads/bd.sh`, which verifies the pinned Beads and Dolt binaries, against the same synthetic graph. Repeat the A4S assertions. The test must never contact the shared Dolt service or mutate the live Homeserver backlog.

## Acceptance criteria

- The LLM receives compact normalized JSON instead of raw backlog JSON and full text only for its active Bead.
- Every open Bead becomes a `todo`; `blocks` dependencies determine the scheduler order.
- No normal-loop command creates or renews a lease.
- A4S and Homeserver disposable E2E both prove sequential progression, evidence-backed terminal state, and no live-backlog mutation.
- The canonical global skill resolves to the reviewed A4S source.
