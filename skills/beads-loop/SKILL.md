---
name: beads-loop
description: Use when autonomously executing all canonical ready Beads in the current Git repository, one atomic claim at a time, with validation evidence recorded before finalization.
metadata:
  author: pablontiv
user-invocable: true
---

# Beads Autonomous Loop

Run the canonical ready work in the current Git repository until the adapter returns a terminal envelope. This workflow is self-contained for Pi and Claude. The skill accepts no arguments: do not accept a repository path or a Bead selector from the invocation.

## Adapter invocation

Resolve `scripts/beads_loop.py` relative to this skill directory to an absolute path and assign that path to `BEADS_LOOP_ADAPTER`. Keep the process working directory at the current Git repository where the skill was invoked; do not change into the skill directory. Every command below uses the resolved absolute path through `BEADS_LOOP_ADAPTER`. Invoke no backlog command directly.

Every adapter command emits exactly one JSON envelope with `schema_version`, `kind`, and `details`. Preserve the complete returned envelope as operational evidence.

## Loop

Follow these steps in order for one Bead at a time.

1. From the current Git repository, run:

   ```sh
   python3 "$BEADS_LOOP_ADAPTER" prime
   ```

   Continue only when `kind` is `ready`.

2. Run one atomic claim:

   ```sh
   python3 "$BEADS_LOOP_ADAPTER" claim
   ```

   Continue only when `kind` is `claimed`. Take `details.issue.id` as `BEAD_ID`; never substitute an advisory ID or choose an item yourself.

3. Read the claimed issue's description and acceptance criteria from `details.issue`. Perform exactly that work in the current repository. Do not broaden the scope or begin another item.

4. Write a bounded in-repository evidence report to a regular file. Set its repository-relative path as `EVIDENCE_PATH`. Include the Bead ID, implementation summary, changed files, applicable validation commands, exit results, and a concise bounded excerpt needed to support the verdict.

5. Run all applicable validation for the claimed work. Record the commands and results in the evidence report.

6. If validation passes, close the claimed item with its evidence:

   ```sh
   python3 "$BEADS_LOOP_ADAPTER" finalize --bead "$BEAD_ID" --verdict pass --evidence "$EVIDENCE_PATH"
   ```

   If validation fails, record the failure evidence and block the claimed item:

   ```sh
   python3 "$BEADS_LOOP_ADAPTER" finalize --bead "$BEAD_ID" --verdict fail --evidence "$EVIDENCE_PATH"
   ```

   Continue only when `kind` is `finalized`, after checking that the returned issue ID and observed final status match the claimed item and verdict. A pass must return `closed`; a fail must return `blocked`.

7. Repeat from `prime`. Never combine finalization with another claim.

## Terminal envelopes

Stop only when an adapter command returns one of these terminal kinds, and report the complete returned envelope plus any evidence report already written:

- `no_ready`: successful completion; no canonical ready work remains.
- `not_beads_repo`: the current-repository guard failed.
- `doctor_failed`: repository health could not be established.
- `claim_lost`: claim ownership, its read-back, or a conditional finalization guard could not be verified.
- `blocked`: the requested adapter operation failed closed.
- `invalid_evidence`: the evidence file did not satisfy the in-repository file contract.

Do not retry a terminal result by guessing different work or changing scope. A failed validation must use `finalize fail`; if that returns `finalized`, report the blocked Bead and continue the loop from `prime`.
