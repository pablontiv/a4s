# Doctor mode

Doctor aligns existing Beads with the Roadmap contract. Begin read-only: classify each plausible interpretation as a decision, show its verified evidence and exact proposed payload, and wait for explicit payload approval before mutation. A plausible interpretation alone never authorizes a change.

## Diagnose

Read the complete pending graph using the tree recipe and run `bd dep cycles --json`. When Doctor was entered from a scoped Loop, retain that exact scope for ownership classification: only the named task or the direct task children of the named epic can participate. Out-of-scope `in_progress` records remain visible but cannot create a scoped ownership ambiguity or correction target.

For every affected record, load the canonical execution surfaces explicitly:

```bash
bd show "$ID" --include-comments --json
bd provenance log "$ID" --json
```

Use `bd comments "$ID" --json` when only the comment thread is required. Treat issue fields and notes, comments, provenance rows, Git commits, and provider-owned logs or transcripts as distinct evidence surfaces; one never implies another. Resolve the effective `.workspace/config.yaml` and its declared precedence without substituting unrelated repository prose.

Detect and report these finding classes exactly:

- types other than `epic` or `task`;
- nested epics;
- aggregate records typed as tasks;
- executable records typed as epics;
- incomplete epic or task contracts;
- `blocked` or `deferred` used instead of known `blocks` edges;
- broken dependencies or cycles;
- stale satisfied-prerequisite edges: `blocks` targets closed as duplicate, superseded, or normalized containers whose notes or closure evidence disavow outcome completion or identify open successor work;
- executable epics;
- more than one `in_progress` task inside one sequential active scope, reported as one **ownership ambiguity** containing every literal in-scope ID;
- `in_progress` without `roadmap_controller_session` and without one coherent legacy human owner;
- `roadmap_controller_session` or checkpoint metadata on a record whose status is not `in_progress`, reported as stale operational state without inferring a correction;
- disagreement between `roadmap_controller_session`, `roadmap_stage`, `roadmap_branch`, `roadmap_worktree`, `roadmap_base_sha`, or `roadmap_candidate_sha` and Git, comments, notes, or provenance;
- a `ROADMAP_HANDOFF v2` or `ROADMAP_RESULT v2` whose `controller_session` does not match the current controller session;
- a `ROADMAP_HANDOFF v2` or `ROADMAP_RESULT v2` whose `candidate_sha` does not match the active checkpoint;
- graph components with no executable root and no explicit pre-start external gate;
- unexplained disagreement between normalized topology and provider-ready open tasks (**readiness drift**);
- missing required current-session role handoff in Bead comments;
- a failed review comment with no guarded blocked/failure `ROADMAP_RESULT v2` in notes;
- a passing `ROADMAP_RESULT v2` with missing required typed provenance;
- disagreement among comments, provenance, checkpoint metadata, and the lifecycle result in notes;
- a task completed after ADR 0050 that cites a newly created execution report file instead of canonical Bead evidence; and
- missing or ambiguous `.workspace` DoD.

Preserve historical report references for tasks completed before ADR 0050. They are historical evidence, not a reason to create, migrate, rewrite or delete reports.

Then check backlog consistency against the repository and runtime, not only the graph:

- **structural dead ends**: an open epic with no open children; an open child under a closed parent; a blocking chain whose root is stale, parked, or waiting on an unlinked external condition; a record that must stay open permanently parented under an epic, which can then never close;
- **status contradictions**: `in_progress` while blocked by open dependencies; `in_progress` whose assignee, controller metadata, checkpoint, Git state, comments, notes, or provenance disagree; controller or checkpoint metadata on a non-`in_progress` task;
- **status used as a record**: a Bead whose status encodes ownership or other durable state instead of work progress;
- **resolved in base**: every acceptance criterion already maps to evidence on the base branch (commit SHA, file, or merged PR);
- **obsolete target**: the contract names code, paths, or functions absent from the base branch, for example code that exists only on a closed or unmerged branch;
- **superseded authority**: the contract implements an ADR or spec whose `estado` is `superseded`, or whose successor was already delivered;
- **duplicates and overlapping scope**: another open or closed Bead has the same acceptance, or two open Beads would change the same artifact toward the same outcome;
- **questions filed as work**: status queries or requests for information recorded as tasks;
- **hidden dependencies**: prose such as "blocked by", "depends on", "después de", or a mentioned Bead ID that is not a linked dependency; confirm that each mentioned ID exists before reporting it, because hyphenated words match the ID pattern;
- **contract artifacts outside base**: a spec, plan, or ADR the contract requires exists only on a local branch, a worktree, or an unpushed ref; and
- **ephemeral evidence**: notes cite an external reference that has neither a live owning provider nor a typed provenance row, or a temporary path that no longer exists.

For every finding, cite literal IDs and observed fields. Preserve IDs, history, notes, evidence, and external references.

Every finding needs verifiable evidence: a command and its literal output, a commit SHA, a file and line, or a Bead field. Words such as "probably" or "possibly" are not findings. Verify the claim against code, history, runtime state, and linked Beads, or classify it as a decision requiring user input.

One coherent legacy `in_progress` task with a human assignee and no `roadmap_controller_session` is Loop-resumable. `lease_expires_at` and `started_at` are non-authoritative; Doctor neither waits nor proposes a correction for that state. One coherent session-owned `in_progress` task is likewise resumable immediately. Neither case needs Doctor approval. Doctor acts only when a separate contradiction remains.

For a non-`in_progress` task that still carries controller or checkpoint metadata, report stale operational state and preserve the fields. Their presence alone does not establish the intended status or authorize cleanup. If correction requires choosing whether the execution should resume, reset, or remain open, classify that choice as a decision rather than guessing.

## Classify the proposal

Separate findings into:

1. **Deterministic corrections** — one fact-preserving command follows from unambiguous provider state and the existing written contract.
2. **Decisions requiring user input** — requirements, intended type, reparenting, dependency direction, status meaning, external-gate meaning, or another semantic choice is ambiguous.
3. **Unresolvable gaps** — required authority is missing or inaccessible, or no safe direct Beads operation can preserve the contract.

A stale satisfied-prerequisite edge is always a finding, but its replacement is deterministic only when one exact successor dependency is already stated by current authority. Otherwise preserve the current edge, show the closed target, its disavowal evidence and every open successor candidate, then ask the user to choose one before proposing mutation.

When a requirement, dependency, hierarchy change, or status meaning is ambiguous, preserve the current graph, classify the missing value as a decision, show the qualifying evidence and ask one concrete question. Derive requirements only from the sources allowed by Contract backfill step 4; apply hierarchy or status conversion only through the exact approved proposal. Do not fabricate missing requirements, flatten a nested epic implicitly, or infer a `blocks` edge from parking prose. A preview is evidence for the gate, not approval.

## Emergency continuation

When pending non-epic Beads exist but Loop cannot execute a task, Doctor treats the state as a **`BACKLOG EMERGENCY`**, not as backlog quality. Before presenting secondary findings, report the pending task count, the stranded next candidate when one exists, and its literal blocker.

Doctor then keeps the recovery path active by presenting exactly one highest-leverage `CONTINUE` action:

- for an incomplete candidate, perform Contract backfill on its exact highest-ranked group;
- for a deterministic graph or lifecycle correction, present the exact guarded Beads command set for approval;
- for missing or ambiguous `.workspace` authority, render the exact authoritative field proposal from verified evidence, or ask one concrete question for the single missing material value; and
- when the required action belongs to another governed workflow, name that workflow and its exact input instead of pretending Doctor can apply it.

Do not bundle unrelated repair choices into the continuation gate. A declined questionnaire is not resolution: preserve the emergency, reduce the next interaction to the one blocking decision, and leave secondary findings visible but non-blocking.

## Contract backfill

An incomplete epic or task contract is not a terminal finding. Doctor completes it by running Plan's elicitation internally; do not end the session by recommending the user run `/roadmap plan` or leave `⚠contrato` in place.

1. **Scope.** Group incomplete records by their epic, or by root task when they have no epic. Handle one group at a time, highest tree score first, unless the user named a scope.
2. **Elicit with Plan.** Apply `plan.md` steps 1–4 to that group, with these differences: the existing records are the graph; existing IDs, titles, hierarchy, and edges are preserved; and the output is a field proposal, not a new graph.
3. **Check every element.** For each Bead, render one row per element of its `contracts.md` list (epic or task), marked present, proposed, or question. An element is present only when the Bead states it by content; initial state and out-of-scope boundaries are separate elements and are never implied by other text.
4. **Cite or ask.** Propose text for an element only when a specific source states it: a repository `path:line`, an ADR or spec with its line, a named Bead field or note, a commit SHA, or a Backscroll or Engram hit ID. Moving or quoting text that the Bead already states counts; summarizing a whole record, synthesizing from sibling or child Beads, or extrapolating an ADR number, path, or dependency does not. Before citing, confirm the path, line, ID, or commit exists in the base branch or provider, and that newer Bead notes do not contradict it. When no source qualifies, ask the user a concrete question; never fill the element with a plausible guess.
5. **Show final values.** For each Bead, show the complete resulting `description`, `design`, and `acceptance_criteria`, keeping existing text and integrating the new elements into the field that `contracts.md` assigns them. Include the exact commands using only flags listed by `bd update --help`, for example `bd update "$ID" --body-file <file> --design-file <file> --acceptance "<text>" --json`.
6. **Structural outcomes.** If Plan's validation finds a task that does not fit one session, a missing task, or a missing `blocks` edge, include it in the same proposal. After approval, Doctor itself creates only those new records by running `plan.md` steps 5–10; it never creates a record for an existing Bead. An existing record that is replaced keeps its history and is linked with `bd supersede` only after its successor exists.
7. **Approve and apply.** After showing the complete final fields and commands, end the turn with exactly three choices: **approve exactly** (authorizes only the displayed payload), **request adjustments** (keeps the graph unchanged and requests the field to revise), or **reject** (keeps the graph unchanged and records the proposal as the blocker). Remain in this gate until one is chosen. Apply only an **approve exactly** response to the unchanged payload. A record stays `⚠contrato` when the proposal is rejected or a material question remains unanswered; report that literal reason.

The commands in this section are subject to "Approval and apply" and "Verify" below. Verification also compares every applied field with the approved final value and re-checks each record against `contracts.md`.

## Approval and apply

For deterministic corrections and resolved decisions, display every exact proposed command, grouped by finding and in execution order. Explain expected effects, preserved data, and any commands that cannot be safely proposed. End the turn with **approve exactly**, **request adjustments**, and **reject** for that complete command set. A changed command set replaces the prior gate and requires a fresh choice; invoking Doctor again is not an approval response.

Before approval, run no mutation. After approval, run only the unchanged commands. Permitted direct operations include narrowly scoped forms of:

```bash
bd update "$ID" ... --json
bd dep add "$ISSUE_ID" "$DEPENDS_ON_ID" --type blocks --json
bd dep remove "$ISSUE_ID" "$DEPENDS_ON_ID" --json
bd dep cycles --json
bd duplicate "$ID" --of "$CANONICAL_ID"
bd supersede "$ID" --with "$SUCCESSOR_ID"
bd close "$ID" --reason "$EVIDENCE"
bd create --graph .superpowers/roadmap/approved-plan.json [--dry-run] --json  # only new records from "Contract backfill" step 6
```

Use `bd duplicate`, `bd supersede`, and `bd close` only for the consistency findings above, never to complete implementation work. A closure reason must carry the evidence that justified it. Close a **resolved in base** Bead only when every acceptance criterion maps to base-branch evidence; otherwise it is a decision requiring user input. Record the evidence in the Bead notes before a `duplicate` or `supersede` link, because those commands close without a custom reason. If an existing `related` link blocks a `supersede` link, propose removing it explicitly.

Use the installed CLI's documented arguments and preview their fully expanded literal values; do not guess a flag. A guarded status or assignee correction is permitted only when a separate verified inconsistency makes one target state unambiguous. Its proposal must retain the exact observed values and use both guards:

```bash
bd update "$ID" \
  --status "$TARGET_STATUS" \
  --assignee "$TARGET_ASSIGNEE" \
  --if-status "$OBSERVED_STATUS" \
  --if-assignee "$OBSERVED_ASSIGNEE" \
  --json
```

Do not use time, session-liveness inference, a lease field, or stale metadata alone to choose the target state or assignee.

Stop and report any command failure or effect that differs from the approved proposal, except for the single confirmed no-effect mechanical correction defined in `contracts.md`. When that exception applies, the corrected attempt is required, stays inside the approved proposal, and receives normal readback. Do not improvise any other retry, rollback, requirement, reparenting, status conversion, or additional correction.

## Verify

After authorized application:

1. re-read every affected Bead with `bd show "$ID" --include-comments --json` and its external bindings with `bd provenance log "$ID" --json`;
2. re-read affected dependencies with `bd dep list`;
3. run `bd dep cycles --json`;
4. rerun the complete read-only tree recipe;
5. rerun the backlog consistency checks for the affected Beads;
6. for every added, removed, or retargeted `blocks` edge, evaluate the dependent's next transition after the changed prerequisite closes: recompute effective prerequisites, distinguish pre-start external gates from execution admission checks, and prove that the transition creates neither a dead end nor readiness drift; if that future classification is ambiguous, keep the correction unresolved and ask the user; and
7. report applied corrections, transition results, mismatches, and every residual finding.

A correction is not verified merely because provider and topology agree while its new prerequisite is still open. The post-closure transition in step 6 must also be coherent, so Doctor does not certify a repair that predictably requires another Doctor pass.

Doctor owns diagnosis, proposal, approval, application, and verification of backlog corrections; Loop owns task selection and implementation. When Doctor was entered through Loop condition 2, preserve `origin=loop` and the exact `recovery_scope` derived by `loop.md` §2.1 throughout recovery; never collapse a multi-record ownership ambiguity, cycle, edge, or drift finding to one convenient epic. After a verified approved correction, return control to Loop for a fresh tree read and autonomous continuation. Without approval, return no mutation and leave Loop stopped on the literal unresolved decision.
