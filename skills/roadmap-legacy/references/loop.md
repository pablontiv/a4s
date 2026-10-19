# Loop mode

Loop executes the backlog one task at a time, autonomously, until nothing executable remains or a stop below applies. `loop <id>` limits it to that task, or to the direct children of that epic.

## 1. Resolve the way of working

Read the effective `.workspace/config.yaml` and resolve the axes in `contracts.md`. Resolve `controller_identity`; if it is `unknown`, report that single missing value and do not acquire tasks. Resolve the repository-wide controls (sync, isolation, delivery); a required one that is `unknown` stops Loop with the exact field and the one value needed.

## 2. Select

Run the tree recipe (limited to the scope, if any). Then:

1. If exactly one in-scope task is `in_progress` and its checkpoint, branch and assignee are coherent, resume it first by guarded takeover (below).
2. Otherwise take the first **executable** task in tree order.
3. A task that fails `definition_of_ready` follows `incomplete_task_policy`:
   - `skip`: leave it visible as a finding and consider the next task;
   - `stop`: stop Loop naming the task and its missing elements;
   - `backfill`: run Doctor's backfill for that task only, then re-evaluate it.
4. Tasks excluded by the tree (blocked, gated, deferred, ambiguous ownership, drift) are skipped, not stop reasons.

Acquire with one guarded transition:

```bash
bd update "$ID" --status in_progress --assignee "$CONTROLLER" \
  --if-status open --if-assignee "$OBSERVED_ASSIGNEE" \
  --set-metadata "roadmap_controller_session=$SESSION" \
  --set-metadata "roadmap_stage=admission" --json
```

A takeover of a resumable task uses `--if-status in_progress --if-assignee "$OBSERVED_CONTROLLER"` instead. On exit 13, skip that task and select again. After acquiring, re-read the Bead and require `status=in_progress`, `assignee=$CONTROLLER`, `roadmap_controller_session=$SESSION`.

## 3. Execute

Follow the config literally, in this order: `sync_strategy` and `isolation_strategy` → `pre_checks` → implementation per `development_workflow` → `acceptance_checks` → `review_checks` → delivery per `delivery_mode`/`delivery_gate`/`delivery_overrides` → `post_checks`. Commit per `commit_policy` with the `Bead: <id>` trailer (plus any trailer the delivery override requires).

The controller may delegate bounded passes (implementation, review) to fresh workers of the current runtime; workers do not delegate further. Record each pass as a `ROADMAP_HANDOFF v2` comment. After each stage, write a guarded checkpoint (`--if-status in_progress --if-assignee "$CONTROLLER"`) with the stage, branch, worktree and SHAs. A new candidate SHA invalidates checks recorded for the old one.

Before each mutation, the Bead must still be owned by this controller; if not, report `controller_lost` and stop working on that task.

## 4. Finish the task

- **Pass**: record provenance, then close with one guarded update appending `ROADMAP_RESULT v2` (`verdict=pass`) to notes.
- **Fail** (a check, review, delivery gate or implementation fails, or a task-scoped control is `unknown`): append `ROADMAP_RESULT v2` (`verdict=fail`, the failed check, evidence) and set `status=blocked` in one guarded update. Then apply `failed_task_policy`: `skip` continues with the next task; `stop` ends Loop.

When all children of an epic are closed, verify its success criteria, record a `ROADMAP_HANDOFF v2` with `candidate_sha=none`, and close it with a guarded update (`--if-status open --if-assignee <observed>`).

## 5. Continue or stop

After each task, re-read the graph and select again. Loop stops only when:

1. no executable task remains in scope;
2. a repository-wide control is `unknown` or failed;
3. the config declares a human gate for the next action (for example a delivery-policy change, an external effect, a destructive operation);
4. `failed_task_policy` or `incomplete_task_policy` is `stop` and applies; or
5. the operator cancels.

A status question from the operator is not a stop: answer it while the current task keeps running.

## 6. Summary

When Loop stops, print a short summary:

- tasks closed (ID, title, PR or merge SHA);
- tasks skipped or blocked, each with its reason;
- pending tasks in scope and why none is executable, when that is the stop;
- the stop reason;
- one concrete next action for the operator, when one is needed; and
- worktrees and branches offered for cleanup per `cleanup_policy`.
