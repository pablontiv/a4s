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

For every finding, cite literal IDs and observed fields. Preserve IDs, history, notes, evidence, and external references.

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
```

Use the installed CLI's documented arguments and preview their fully expanded literal values; do not guess a flag. Reclaim only one specifically verified expired lease by ID. Never use `bd reclaim --any-replica`.

Stop and report any command failure or effect that differs from the approved proposal. Do not improvise a retry, rollback, requirement, reparenting, status conversion, or additional correction.

## Verify

After authorized application:

1. re-read every affected Bead with `bd show`;
2. re-read affected dependencies with `bd dep list`;
3. run `bd dep cycles --json`;
4. rerun the complete read-only tree recipe; and
5. report applied corrections, mismatches, and every residual finding.

Doctor does not implement tasks. Loop may request a Doctor diagnosis, but it must never apply Doctor corrections implicitly.
