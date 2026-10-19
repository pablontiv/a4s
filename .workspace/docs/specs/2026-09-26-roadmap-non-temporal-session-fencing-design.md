---
tipo: spec
---
# Roadmap non-temporal session fencing design

## Goal

Remove time-based leases from Roadmap task execution while preserving one
controller with lifecycle authority. A new Pi session must be able to resume an
interrupted task immediately. The previous session must lose permission to
advance or finalize that task.

Roadmap remains a Markdown-only workflow over Beads. This design adds no daemon,
timer, lock service, scheduler, or helper runtime.

## Context

The current loop claims a task with `bd update --claim`. Beads grants a lease of
about five minutes, and Roadmap heartbeats only before and after bounded stages.
An implementation or review stage can exceed that TTL. The loop then stops on a
lost lease even when no competing controller exists.

The lease also provides incomplete exclusion in the observed topology. Pi
sessions commonly resolve to the same Beads actor, and `--claim` is idempotent
for work already claimed by that actor. Two sessions can therefore share the
same assignee while the lease still delays recovery.

Earlier A4S work reached the same operational conclusion. ADR 0035 removed
claims because five-minute leases expired during LLM execution. ADR 0044 later
restored claim and heartbeat to protect multi-session execution. This design
keeps that concurrency goal and removes the clock dependency.

## Governing decisions

This design replaces ADR 0044 in full while preserving its unaffected choices:

- Roadmap remains the single interface for Plan, tree, Doctor, and Loop over
  Beads.
- Beads remains the authority for records, dependencies, lifecycle, and
  execution evidence.
- Loop executes one task at a time.
- ADR 0033 still requires conditional finalization.
- ADR 0048 still defines Roadmap as a Markdown-only autonomous loop.
- ADR 0050 still makes the Bead the canonical execution record.

The replacement changes task ownership. Claim, lease, heartbeat, and reclaim no
longer participate in normal Roadmap execution.

## Scope

In scope:

- controller identity for one Pi session;
- atomic start and takeover transitions;
- resumable checkpoints in the Bead;
- fencing rules for lifecycle, handoffs, and finalization;
- migration of legacy `in_progress` tasks with lease fields;
- Doctor and tree semantics for ambiguous ownership;
- pressure scenarios and disposable Beads smoke checks.

Out of scope:

- changing Beads itself;
- detecting process liveness;
- terminating another Pi process;
- preventing direct filesystem writes by a stale process;
- parallel Roadmap task execution;
- a background heartbeat or reaper;
- changes to workspace delivery policy.

## Controller identity

Every Roadmap Loop invocation resolves:

```text
CONTROLLER=roadmap:<PI_SESSION_ID>
```

`PI_SESSION_ID` is required. The effective workspace profile supports Pi only,
so an absent value is an unknown required control and stops before mutation.

The Beads audit actor remains the human or configured service identity. The
issue assignee becomes the current Roadmap controller. This separates audit
identity from execution authority.

Roadmap stores these flat metadata keys on the task:

```text
roadmap_controller_session
roadmap_stage
roadmap_branch
roadmap_worktree
roadmap_base_sha
roadmap_candidate_sha
```

The metadata is execution state inside the canonical Bead. It is not a second
backlog or report.

## State transitions

### Start a new task

Loop selects a complete task from the executable intersection using the current
Roadmap ordering. It records the observed status and assignee, then attempts one
conditional update:

```bash
bd update "$BEAD_ID" \
  --status in_progress \
  --assignee "$CONTROLLER" \
  --if-status open \
  --if-assignee "$OBSERVED_ASSIGNEE" \
  --set-metadata "roadmap_controller_session=$PI_SESSION_ID" \
  --set-metadata "roadmap_stage=admission" \
  --json
```

An unassigned task uses an empty value for `$OBSERVED_ASSIGNEE`. A task already
assigned for planning or routing uses that exact observed value. The operation
must set status, assignee, and session metadata together.

Exit 13 means another controller changed the task. Loop performs a fresh tree
read and stops without executing the candidate. It does not retry the same
transition or select a different task in that invocation.

After success, Loop reads the task again and requires:

```text
status=in_progress
assignee=roadmap:<PI_SESSION_ID>
roadmap_controller_session=<PI_SESSION_ID>
```

### Take over an interrupted task

An `in_progress` task inside the active scope has priority over new open tasks.
When exactly one resumable task exists, invoking Loop authorizes immediate
takeover:

```bash
bd update "$BEAD_ID" \
  --assignee "$CONTROLLER" \
  --if-status in_progress \
  --if-assignee "$OBSERVED_CONTROLLER" \
  --set-metadata "roadmap_controller_session=$PI_SESSION_ID" \
  --json
```

The update has no liveness probe, delay, TTL, or confirmation prompt. The new
invocation is the takeover signal approved by the operator.

Exit 13 triggers a fresh ownership read. Loop continues only when that read
shows its own controller identity. Otherwise another session won and the
invocation stops.

More than one resumable `in_progress` task is ambiguous because Loop is
sequential. Tree reports every candidate, and Loop enters Doctor recovery
without taking any of them.

### Advance a stage

Every metadata or lifecycle update after start includes both guards:

```text
--if-status in_progress
--if-assignee roadmap:<PI_SESSION_ID>
```

A changed assignee invalidates the old controller at its next guarded update.
No stale controller can block, close, or change execution metadata after a
takeover.

## Checkpoints and reconstruction

Loop writes a checkpoint after admission and after each bounded implementation,
review, validation, and delivery stage. The metadata records the current stage,
branch, worktree, base SHA, and candidate SHA. Existing handoff comments and
typed provenance retain role results and external bindings.

After takeover, the new controller:

1. reads the task with comments and provenance;
2. verifies the recorded branch, worktree, and SHA values against Git;
3. identifies the first stage without a valid result for the current candidate
   SHA;
4. resumes at that stage;
5. keeps prior review or validation results only when their candidate SHA still
   matches; and
6. invalidates later results after any candidate SHA change.

If the worktree path is absent but the branch and last durable SHA exist, Loop
recreates the worktree according to `.workspace/config.yaml`. If both the
worktree and every durable Git reference to uncommitted work are absent, Loop
reports the lost state and stops. A lease delay cannot recover missing files.

A normal session close leaves its dedicated worktree in place. The next session
can verify and reuse it. Cleanup remains an explicit operator choice under the
workspace cleanup policy.

## Handoffs and final results

The current `ROADMAP_HANDOFF v1` and `ROADMAP_RESULT v1` payloads do not identify
the controller session. The new forms are:

```text
ROADMAP_HANDOFF v2
controller_session=<PI_SESSION_ID>
role=<implementer|task-reviewer|security-reviewer|epic-final-reviewer>
verdict=<pass|fail|blocked>
candidate_sha=<sha|none>

Summary: <bounded result>
Findings:
- <finding or none>
```

```text
ROADMAP_RESULT v2
controller_session=<PI_SESSION_ID>
verdict=<pass|fail>
candidate_sha=<sha>
...
```

Beads comments and provenance do not provide conditional assignee guards.
Roadmap reads ownership immediately before and after each append-only write and
includes `controller_session` in the payload. A late write from an old session
remains historical evidence. It cannot satisfy a required handoff, gate, or
closure condition because its session ID differs from the current assignee.

Finalization retains the ADR 0033 compare-and-set boundary:

```bash
bd update "$BEAD_ID" --status closed \
  --if-assignee "$CONTROLLER" \
  --if-status in_progress \
  --append-notes "$ROADMAP_RESULT" \
  --json
```

Exit 13 writes no fallback result and ends as `controller_lost`. The summary may
retain `claim_lost` as a compatibility label only if the implementation plan
finds an active consumer that requires it; the normative condition is
`controller_lost`.

## Filesystem boundary

The controller token fences Beads lifecycle writes. It does not terminate an OS
process or revoke write permission to a worktree. Roadmap verifies ownership
before and after every bounded stage, and the workspace requires dedicated
worktrees. A stale process may finish local computation inside its own stage,
but it cannot publish an authoritative handoff or finalize the Bead after
ownership changes.

Adding an OS lock or background supervisor would create runtime machinery and
would not recover work more quickly. This design leaves that capability outside
Roadmap until observed evidence justifies it.

## Legacy migration

A legacy task may be `in_progress`, assigned to a human actor, and contain
`lease_expires_at` without `roadmap_controller_session`.

Loop handles legacy state as follows:

- one legacy task inside scope is resumable and receives the same guarded
  takeover from its observed assignee to the current controller;
- old lease fields are non-authoritative after successful readback;
- Loop does not heartbeat, wait for expiry, or reclaim the task;
- multiple legacy tasks are ambiguous and enter Doctor recovery;
- a lease or `started_at` value alone never proves a live controller.

Doctor stops proposing lease reclaim as normal recovery. It diagnoses multiple
`in_progress` tasks, missing controller metadata, or contradictions among task
status, session checkpoints, Git state, comments, and provenance. An approved
Doctor correction uses exact status and assignee guards. Bare or cross-replica
reclaim remains prohibited.

## Error handling

| Condition | Result |
| --- | --- |
| `PI_SESSION_ID` absent | Stop before mutation with the missing control. |
| Start CAS loses | Re-read tree and stop without executing a task. |
| Takeover CAS loses | Re-read ownership; continue only if this session already owns it. |
| Multiple resumable tasks | Enter Doctor recovery with every literal ID. |
| Checkpoint and Git disagree | Stop with the exact mismatched field and observed value. |
| Old-session handoff arrives | Preserve it as history and exclude it from current gates. |
| Current controller guard fails | Stop further mutation as `controller_lost`. |
| Legacy lease is expired | Ignore time; use guarded takeover immediately. |

No error path sleeps, waits for TTL, retries by time, or invokes heartbeat.

## Documentation changes

Implementation updates these live files:

- `skills/roadmap/references/loop.md` for start, takeover, checkpoints, stage
  guards, finalization, and summary behavior;
- `skills/roadmap/references/contracts.md` for controller and evidence payload
  contracts;
- `skills/roadmap/references/tree.md` for resumable and ambiguous ownership
  classification;
- `skills/roadmap/references/doctor.md` for legacy migration and ownership
  repair;
- `skills/roadmap/README.md` for pressure scenarios; and
- `skills/roadmap/SKILL.md` for the behavior-change metadata date.

Historical specs, plans, and superseded ADRs remain unchanged.

## Verification

Before editing the skill, preserve baseline results that exercise the current
lease behavior. After the change, use fresh agents and disposable Beads stores
to verify:

1. two controllers starting the same open task produce one winner;
2. a new session takes an interrupted task immediately;
3. the prior controller cannot advance metadata or finalize after takeover;
4. reconstruction resumes at the first incomplete stage for the current SHA;
5. results for an older SHA are invalidated;
6. stale-session handoffs remain visible but do not satisfy gates;
7. one legacy leased task is taken over without waiting;
8. multiple legacy tasks enter Doctor recovery;
9. normal Loop emits no `--claim`, heartbeat, or reclaim command; and
10. fresh-agent Roadmap pressure scenarios, Rootline validation,
    `git diff --check`, and `test/ci-local.sh` pass.

The disposable provider smoke must confirm that guarded `bd update` supports the
combined status, assignee, and metadata transitions specified here and that
manual `in_progress` assignment does not create a lease dependency. A provider
mismatch blocks implementation and returns the design for revision.

## Success criteria

The change succeeds when:

- normal Roadmap execution has no TTL, heartbeat, or reclaim dependency;
- only one controller can advance or finalize a task;
- a new Loop session takes over one interrupted task without waiting;
- the Bead and Git contain enough verified state to resume the first incomplete
  stage;
- stale-session evidence cannot authorize closure;
- ambiguous multi-task state still fails closed through Doctor;
- Roadmap remains Markdown-only and sequential; and
- the repository checks and approved pressure scenarios pass.
