# Station loop-works acceptance

This procedure implements the Phase A, step A5 acceptance criterion from #882:
prove that a trivial issue can traverse the complete station loop three times in
succession without a station-caused failure. It is an operator-run acceptance
test, not a claim that the station has already passed. Follow
[deployment and recovery procedures](deployment.md) for station configuration,
release ownership and recovery.

## Preconditions

Hold these conditions throughout the test:

- The repository's station-owned Dagu queue has `max_concurrency: 1`. Queue
  capacity is not consumer policy in `.workspace/dagu/config.json`.
- Release promotion is frozen: do not promote a different station release during
  the sequence.
- The station is in attended mode: the coordinating operator is present to
  observe progress, classify failures and make any required recovery decisions.

These are operator preconditions, not authorization for the issue implementer to
change the queue, promote releases or alter station configuration.

## Run the loop

Choose a trivial issue with a small, independently verifiable change. From the
consumer repository, start its feature lifecycle with:

```sh
a4s enqueue --run-id "<repo>-issue-<n>" feature -- ISSUE=<n> OMP_SESSION_ID=<session>
```

Replace `<repo>` with the repository's run-ID prefix, `<n>` with the issue number
and `<session>` with the persistent coordinating session ID. Repeat with a new
trivial issue for each subsequent run.

Observe the stages in this order:

1. **Enqueue** — admission accepts the run into the repository queue.
2. **Triage** — the issue's implementation path is assessed.
3. **Implement** — the assigned change is completed in its managed worktree.
4. **Gate** — the candidate passes the repository's local gate.
5. **Review** — review findings are resolved and any required operator validation
   is completed.
6. **CI** — the published candidate satisfies required checks and the adopted
   code-scanning policy.
7. **Merge** — the candidate merges and the lifecycle completes its closure.

Ensure the PR includes `Closes #<n>` and confirm that merge closes the intended
issue. Observe lifecycle completion and cleanup as described in
[deployment.md](deployment.md); a green CI result or merge alone is not evidence
of complete lifecycle closure.

## Failure classification

Classify a failure from its observed cause, not merely the stage where it appears.

| Classification | Examples | Effect on the acceptance sequence |
| --- | --- | --- |
| Station-caused | A Dagu, engine, launcher, admission, reconciler or promotion defect; a lock timeout; a dead owner. | Reset the consecutive-pass counter to zero. Preserve diagnostics and use the deployment recovery procedure before starting a new sequence. |
| Issue-caused | A gate failure caused by the change itself; review findings about that change. | Resolve through the normal issue lifecycle. This is not a station-caused failure and does not reset the counter, but the run cannot count as a pass until it reaches merge and lifecycle closure. |

An unexplained failure is not proof of a clean loop. Retain its evidence and have
the operator establish the cause before counting the run.

## Pass rule and evidence

Start the consecutive-pass counter at zero. Increment it only when a run reaches
merge with lifecycle closure, including the `Closes #<n>` issue closure. The
station passes only after **three consecutive runs** satisfy that rule with **no
station-caused failure**. Any station-caused failure resets the counter to zero,
even if the affected run later succeeds after recovery.

For each run, retain the issue and run IDs, PR, tested candidate SHA, merge and
issue-closure evidence, lifecycle completion/cleanup result, and any failure's
classification and supporting diagnostics. Record that the queue limit,
promotion freeze and attended mode held throughout the sequence. The operator
decides whether that evidence establishes acceptance; authoring this procedure
or passing repository tests does not itself execute the loop.

## Evidence record

For each attempt, fill in a row in the following Markdown table and post the
record as a comment on the stabilization tracker issue. The completed record is
runtime evidence under the repository's source/runtime classification: do not
commit it to the repository. Keep this template in source so that three
consecutive passes can be audited from GitHub alone.

| Attempt number | Issue | Run id | PR | Merged commit | Wall time enqueue→merge | Station-caused failure (none or cause) | Counter after the attempt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <attempt> | #<issue> | <run-id> | #<pr> | <merged-commit> | <elapsed time> | <none or cause> | <counter> |
