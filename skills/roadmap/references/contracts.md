# Roadmap contracts

## Graph

```text
epic         → optional non-executable aggregate
task         → one-session executable unit, at root or direct child of one epic
parent-child → hierarchy only
blocks       → execution order
```

Beads stores every edge as "`issue_id` depends on `depends_on_id`". For `blocks`, `depends_on_id` is the prerequisite. For `parent-child`, it is the parent. Other edge types never order work. A task's **effective prerequisites** are its own `blocks` prerequisites plus those of its parent epic.

A **pre-start external gate** is a condition outside the task's steps (human, billing, third-party decision) declared in the task's fields or notes; never infer one from a title. A check the task itself performs after acquisition (fresh observation, lock, clean worktree, validation) is part of the task, not a gate.

Roadmap creates only `epic` and `task`. Spikes, bugs, chores and decisions are tasks with fitting titles and acceptance criteria. Nested epics are invalid.

## Configuration axes

Loop and Doctor read these axes from the effective `.workspace/config.yaml`. The value there wins; the default applies only when the axis is absent.

| Axis | Used for | Default |
| --- | --- | --- |
| `definition_of_ready` | whether a task is executable | the task contract below; label `legacy`: description and acceptance criteria |
| `incomplete_task_policy` | task that fails `definition_of_ready` | `skip` |
| `failed_task_policy` | task whose gate or implementation fails | `skip` |
| `controller_identity` | loop controller identity (`env:<VAR>` or literal) | `unknown`: Loop acquires nothing |
| `development_workflow` | how a task is designed and implemented | — |
| `pre_checks`, `acceptance_checks`, `review_checks`, `post_checks` | checks per task | — |
| `sync_strategy`, `isolation_strategy`, `commit_policy` | how work is prepared and committed | — |
| `delivery_mode`, `delivery_gate`, `delivery_overrides` | how a candidate is delivered and which human gates apply | — |
| `cleanup_policy` | what is offered for cleanup | offer, never delete |

An axis the config declares but that cannot be resolved (command fails, value ambiguous) is `unknown`. A repository-wide `unknown` stops Loop; one scoped to a single task follows `failed_task_policy`.

## Task and epic contract

The default `definition_of_ready` for a task: an actionable title; context and expected result; in-scope and out-of-scope boundaries; observable initial state; binary acceptance criteria; invariants; source-of-truth paths or interfaces; required closure evidence. Description holds context, result, scope and initial state; design holds invariants, sources and constraints; acceptance criteria hold checks and evidence. A task fits one session.

An epic declares an observable objective, binary success criteria, shared invariants and scope boundaries; its children are `parent-child` links. It closes only after all children are closed and its own criteria are verified.

## Controller

Resolve `controller_identity` to `$SESSION` and use `CONTROLLER=roadmap:$SESSION` as assignee. Lifecycle changes are compare-and-set updates guarded by the observed status and assignee (`--if-status`, `--if-assignee`). A failed guard (exit 13) means another controller owns the task: stop working on it, never retry.

Execution state lives in Bead metadata: `roadmap_controller_session`, `roadmap_stage`, `roadmap_branch`, `roadmap_worktree`, `roadmap_base_sha`, `roadmap_candidate_sha`. It is enough to resume from the first incomplete stage.

## Evidence

The Bead is the complete record; Roadmap writes no report files.

- Each bounded role pass appends one comment starting `ROADMAP_HANDOFF v2` with `controller_session`, `role`, `verdict` (pass|fail|blocked), `candidate_sha`, a summary and findings.
- The final outcome is appended to notes in the same guarded update that changes status, starting `ROADMAP_RESULT v2` with `controller_session`, `verdict`, `candidate_sha` and one line per applied check.
- Commit, branch, PR and CI references use `bd provenance record`. Commits carry a `Bead: <id>` trailer.

Only evidence from the current controller for the current candidate SHA satisfies a check; older entries are history.

Beads comments have no idempotency key: after a failed or ambiguous comment write, confirm once by reading comments and never write a second time.
