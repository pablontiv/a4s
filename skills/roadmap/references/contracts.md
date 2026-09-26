# Roadmap contracts

These contracts govern every Roadmap mode:

```text
epic → optional non-executable aggregate
task → one-session executable unit, direct or one epic child
parent-child → hierarchy only
blocks → execution order
```

Beads stores every edge as "`issue_id` depends on `depends_on_id`". For `blocks`, `depends_on_id` is the prerequisite and `issue_id` is the dependent it unblocks. For `parent-child`, `depends_on_id` is the parent. Other edge types, such as `related` or `relates-to`, never order work.

A task's **effective `blocks` prerequisites** are its own `blocks` prerequisites plus the `blocks` prerequisites of its direct parent epic. The `parent-child` edge itself still expresses hierarchy only: ordering comes from the explicit `blocks` edge on the aggregate and applies to its direct task children. Do not duplicate an inherited epic prerequisite onto every child.

A **pre-start external gate** is a condition outside the task's authorized steps that can be evaluated before acquiring a Roadmap controller, such as a required human, billing, or third-party decision. A check or action that the task contract explicitly requires after controller acquisition is an **execution admission check**, not an external gate. Fresh observation, lock acquisition, isolated-worktree cleanliness, validation, and equivalent just-in-time checks remain task stages when the contract assigns them to the task; their failure stops that stage.

Roadmap creates only core Beads types `epic` and `task`. A task may be at repository root or the direct child of one epic. New nested epics are invalid. An independently deliverable set of outcomes is an epic with separate tasks, not a checklist hidden in one task.

## Confirmed no-effect mechanical correction

A rejected command is not an ambiguous effect. Make exactly one corrected attempt when every condition below is verified:

1. the provider explicitly confirms that no write or external effect occurred;
2. the rejection is local usage, schema, format, or precondition validation;
3. the corrected value is derived deterministically from current authority, such as resolving an abbreviated commit to its full SHA;
4. target, operation, semantic payload, scope, and authorization remain unchanged; and
5. the operation is documented as idempotent.

Before the corrected attempt, retain the original error, the corrected command, and the evidence for all five conditions in controller state. After success, perform the normal readback. If the corrected attempt fails or its effect is ambiguous, stop without another attempt.

This exception never applies to exit 13, stale conditional guards, controller acquisition or takeover, ownership, lifecycle or status transitions, dependency mutations, close/duplicate/supersede operations, non-idempotent comments, destructive commands, external effects, or human gates. A changed target, content, scope, decision, or authorization is not a mechanical correction.

## Epic contract

A complete epic declares all of the following:

- an observable objective;
- binary success criteria;
- shared invariants;
- explicit in-scope and out-of-scope boundaries; and
- its child tasks.

The title identifies the aggregate. Put objective, context, and scope in the Beads description; implementation-wide constraints and source-of-truth guidance in design; and success criteria in acceptance criteria. Represent children with `parent-child` links, never prose alone. An epic is never a selection, controller-acquisition, or implementation candidate. Close it only after all children are closed and fresh evidence proves its own success criteria.

## Task contract

A complete task contains:

- an actionable title;
- context and an expected result;
- explicit in-scope and out-of-scope boundaries;
- an observable expected initial state;
- binary acceptance criteria;
- invariants to preserve;
- source-of-truth repository paths or interfaces;
- `blocks` dependencies when applicable; and
- evidence required for closure.

The task must fit one implementation session. Put requirements in the Beads description, design, and acceptance-criteria fields rather than a parallel Markdown backlog. Use description for context, result, scope, and initial state; design for invariants, sources of truth, interfaces, and implementation constraints; and acceptance criteria for binary checks and required evidence. Dependencies remain Beads edges.

## Controller and checkpoint contract

Every Loop invocation requires `PI_SESSION_ID` and derives the lifecycle authority:

```text
CONTROLLER=roadmap:<PI_SESSION_ID>
```

The Beads audit actor remains the human or configured service identity. The assignee is the current Roadmap controller. Roadmap stores execution state in these flat Bead metadata keys:

```text
roadmap_controller_session
roadmap_stage
roadmap_branch
roadmap_worktree
roadmap_base_sha
roadmap_candidate_sha
```

Controller acquisition, takeover, checkpoints, and lifecycle changes are compare-and-set transitions guarded by the observed status and assignee. After a takeover, the former session loses lifecycle authority at its next conditional write.

A bounded role handoff uses this shape:

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

A final pass or failure uses this prefix:

```text
ROADMAP_RESULT v2
controller_session=<PI_SESSION_ID>
verdict=<pass|fail>
candidate_sha=<sha|none>
...
```

For a task, only a handoff or result whose `controller_session` matches the session encoded by the current `roadmap:<PI_SESSION_ID>` assignee and whose `candidate_sha` matches the active checkpoint can satisfy a review, security, delivery, or closure gate. Older or mismatched payloads remain history only.

Epic finalization is the sole evidence exception. An epic never receives a task controller or checkpoint: its current `epic-final-reviewer` handoff and `ROADMAP_RESULT v2` must use the finalizing Loop invocation's `PI_SESSION_ID` with `candidate_sha=none`, and its close must be one compare-and-set transition guarded by the exact observed epic status and assignee. An epic payload from another session or from a losing finalization race remains history only.

## Completeness and evidence

A contract-incomplete record remains visible in tree and Doctor output but is non-executable. Do not infer or invent missing content. Plan supplies it for new Beads. Doctor supplies it for existing Beads by running Plan's elicitation under its own approval gate (`doctor.md`, "Contract backfill").

The Bead is the complete canonical operational record. Checkpoint metadata records controller progress without becoming a second backlog or report. Role handoffs and review findings are bounded comments; any mode reconstructing execution history reads them explicitly with `bd show "$ID" --include-comments --json` or `bd comments "$ID" --json`. Final pass/fail and gate outcomes are appended to notes by the guarded lifecycle update. External Git, branch, PR, CI work and transcript references use `bd provenance`; logs and transcript bodies remain with their owning provider. Roadmap creates no execution report files and never deletes, prunes or purges canonical execution Beads.
