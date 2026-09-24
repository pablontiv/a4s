# Doctor mode

Doctor aligns existing Beads with the Roadmap contract. Diagnosis is read-only first. It never turns a plausible interpretation into an authorized change.

## Diagnose

Read the complete pending graph using the tree recipe, inspect affected records with `bd show`, and run `bd dep cycles --json`. Resolve the effective `.workspace/config.yaml` and its declared precedence without substituting unrelated repository prose.

Detect and report these finding classes exactly:

- types other than `epic` or `task`;
- nested epics;
- aggregate records typed as tasks;
- executable records typed as epics;
- incomplete epic or task contracts;
- `blocked` or `deferred` used instead of known `blocks` edges;
- broken dependencies or cycles;
- executable epics;
- stale assignees, claims, or leases;
- graph components with no executable root and no explicit external gate;
- disagreement between topology and `bd ready` (**readiness drift**); and
- missing or ambiguous `.workspace` DoD.

Then check backlog consistency against the repository and runtime, not only the graph:

- **structural dead ends**: an open epic with no open children; an open child under a closed parent; a blocking chain whose root is stale, parked, or waiting on an unlinked external condition; a record that must stay open permanently parented under an epic, which can then never close;
- **status contradictions**: `in_progress` while blocked by open dependencies; `in_progress` with no evidence of active work, meaning no live session or pane recorded in metadata and no branch, commit, or artifact since the claim;
- **status used as a record**: a Bead whose status encodes ownership, a lease, or other durable state instead of work progress;
- **resolved in base**: every acceptance criterion already maps to evidence on the base branch (commit SHA, file, or merged PR);
- **obsolete target**: the contract names code, paths, or functions absent from the base branch, for example code that exists only on a closed or unmerged branch;
- **superseded authority**: the contract implements an ADR or spec whose `estado` is `superseded`, or whose successor was already delivered;
- **duplicates and overlapping scope**: another open or closed Bead has the same acceptance, or two open Beads would change the same artifact toward the same outcome;
- **questions filed as work**: status queries or requests for information recorded as tasks;
- **hidden dependencies**: prose such as "blocked by", "depends on", "después de", or a mentioned Bead ID that is not a linked dependency; confirm that each mentioned ID exists before reporting it, because hyphenated words match the ID pattern;
- **contract artifacts outside base**: a spec, plan, or ADR the contract requires exists only on a local branch, a worktree, or an unpushed ref; and
- **ephemeral evidence**: notes cite evidence under `/tmp` or another non-repository path that no longer exists.

For every finding, cite literal IDs and observed fields. Preserve IDs, history, notes, evidence, and external references.

Every finding needs verifiable evidence: a command and its literal output, a commit SHA, a file and line, or a Bead field. Words such as "probably" or "possibly" are not findings. Verify the claim against code, history, runtime state, and linked Beads, or classify it as a decision requiring user input.

## Classify the proposal

Separate findings into:

1. **Deterministic corrections** — one fact-preserving command follows from unambiguous provider state and the existing written contract.
2. **Decisions requiring user input** — requirements, intended type, reparenting, dependency direction, status meaning, external-gate meaning, or another semantic choice is ambiguous.
3. **Unresolvable gaps** — required authority is missing or inaccessible, or no safe direct Beads operation can preserve the contract.

Do not fabricate missing requirements or infer ambiguous dependencies. Never flatten a nested epic implicitly. Never infer a conversion between status parking and a `blocks` edge from prose. A preview is not approval.

## Approval and apply

For deterministic corrections and resolved decisions, display every exact proposed command, grouped by finding and in execution order. Explain expected effects, preserved data, and any commands that cannot be safely proposed. Then ask for explicit approval of that exact command set. Any changed command set requires fresh approval.

Before approval, run no mutation. After approval, run only the unchanged commands. Permitted direct operations include narrowly scoped forms of:

```bash
bd update "$ID" ... --json
bd dep add "$ISSUE_ID" "$DEPENDS_ON_ID" --type blocks --json
bd dep remove "$ISSUE_ID" "$DEPENDS_ON_ID" --json
bd dep cycles --json
bd reclaim --id "$ID" --json
bd duplicate "$ID" --of "$CANONICAL_ID"
bd supersede "$ID" --with "$SUCCESSOR_ID"
bd close "$ID" --reason "$EVIDENCE"
```

Use `bd duplicate`, `bd supersede`, and `bd close` only for the consistency findings above, never to complete implementation work. A closure reason must carry the evidence that justified it. Close a **resolved in base** Bead only when every acceptance criterion maps to base-branch evidence; otherwise it is a decision requiring user input. Record the evidence in the Bead notes before a `duplicate` or `supersede` link, because those commands close without a custom reason. If an existing `related` link blocks a `supersede` link, propose removing it explicitly.

Use the installed CLI's documented arguments and preview their fully expanded literal values; do not guess a flag. Reclaim only one specifically verified expired lease by ID. Never use `bd reclaim --any-replica`.

Stop and report any command failure or effect that differs from the approved proposal. Do not improvise a retry, rollback, requirement, reparenting, status conversion, or additional correction.

## Verify

After authorized application:

1. re-read every affected Bead with `bd show`;
2. re-read affected dependencies with `bd dep list`;
3. run `bd dep cycles --json`;
4. rerun the complete read-only tree recipe;
5. rerun the backlog consistency checks for the affected Beads; and
6. report applied corrections, mismatches, and every residual finding.

Doctor does not implement tasks. Loop may request a Doctor diagnosis, but it must never apply Doctor corrections implicitly.
