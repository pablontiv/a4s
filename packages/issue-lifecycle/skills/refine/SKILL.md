---
name: refine
description: Refine one authorized need, report, or process incident into evidence-backed, independently acceptable backlog units and hand them to backlog-breakdown after operator acceptance.
---

# Refine

Turn one supplied need into 1..N independently acceptable units. Investigate the need, resolve material inconsistencies with the operator, stage the exact proposal, and use `backlog-breakdown` for independent review, approval, and issue creation.

Run when the operator explicitly invokes `/refine` with a need, report, or process incident, or explicitly authorizes another skill to hand that input to refinement. An external FYI report is evidence: its arrival alone authorizes neither refinement nor publication. A backlog design or a prior discussion of possible work likewise requires explicit authorization to refine and acceptance of the exact resulting proposal.

## Boundaries

The invocation authorizes:

- investigating the supplied need and its independently acceptable outcomes;
- asking refinement questions;
- keeping a temporary evidence inventory;
- staging 1..N temporary backlog units;
- offering the exact proposal for acceptance.

Issue creation proceeds only after the operator accepts that proposal, through `backlog-breakdown` and its independent review and approval gate. Implementation and scheduling are separate decisions: `sprint-planning` alone ranks and enqueues new feature/PoC work.

Keep project content unchanged during refinement. Temporary evidence and units belong outside the repository. End the interaction after the accepted units are materialized, rejected, or abandoned; retain staged inputs while an active backend review needs them.

One coordinator owns canonical `units.jsonl` and integrates preparation evidence. Delegate only a genuine unresolved question, supplying the known source ranges and an explicitly bounded output. The coordinator integrates that answer directly into the canonical units; semantic review belongs to the independent backend checkpoint.

Mechanical preparation uses supported role-scoped lower effort: an `AgentDefinition.thinkingLevel` of `low` or the `@task:low` model suffix where the installed public API supports it. Keep global model configuration unchanged. A model suffix takes precedence over the agent default, and enabled caller model/effort overrides can take precedence over both. Record the exercised dispatch's final native `resolvedModelIdentity`, `resolvedThinkingLevel` and available transcript evidence, rather than treating a configured default as effective effort. Return unexpected native findings to coordinator judgment. Preparation effort is separate from semantic review: preserve the plan-reviewer's `@slow` declaration, existing independent routing and enabled overrides, and parent/generation binding; determine its effective model from native evidence.

## Prerequisites and optional template

Use the planning backend named `planning` and the `backlog-breakdown` skill. Admission materializes it from the installed package template using `<PRIMARY>/.workspace/dagu/config.json`. Establish the primary checkout and check that config file before offering publication. If the config file is missing, report that prerequisite and keep the proposal temporary until the operator commits it or rejects the proposal.

The optional workspace configuration is:

```text
.workspace/config/refine.json
```

```json
{
  "template": null
}
```

`template` is either `null` or a readable repository-relative or absolute template path. Resolve it when rendering each unit's `body`; a configured unreadable template is an error. Missing configuration uses the built-in body contract below. This file contains only the template reference; backlog-breakdown derives the target repository from `PRIMARY`.

## Phase 1: establish the supplied need and unit boundaries

Read the full input and identify its problem, desired outcome, and scope. A need may describe incorrect behavior, a new outcome, concrete technical work, or uncertainty requiring investigation. Treat a proposed mechanism as a hypothesis until evidence supports it.

One supplied need, report, or incident can require several units. Combine work that shares an observable outcome, causal uncertainty, and acceptance boundary, or has no independent value. Split work that can be accepted separately, serves different outcomes, or needs materially different investigations.

Investigate every in-scope unit needed to satisfy the supplied need. Explain each proposed boundary and preserve dependencies explicitly in the proposal. Resolve a material ambiguity about the supplied scope within the question rounds; the number of units follows from evidence and acceptance boundaries rather than a one-ticket limit.

## Phase 2: investigate the supplied need

Investigate enough to compare five surfaces. Record what each surface establishes in the evidence inventory (see "Evidence inventory") as you go, not at the end.

### Local sources first

Before searching online or fetching any external copy of a system, enumerate the local sources that may already hold it:

- the current repository, including its other worktrees and local branches;
- local checkouts of the systems the need targets, such as vendored or sibling repositories, with their worktrees and branches;
- installed builds, binaries, or packages of those systems and their reported versions.

Read the relevant local sources before using an external copy. Fetch or clone an external copy only when no local source covers the need or when the authoritative reference is not available locally, and record why in the inventory.

### Reference authority

When a system appears at more than one reference, list every reference found, for example:

- installed version;
- local checkout `HEAD`;
- local remote-tracking ref;
- current remote default branch, checked without modifying the checkout.

Declare which reference is authoritative for this need and why. By default, the current remote default branch is authoritative for what the system can do, and the installed version is authoritative for what the user runs today. State every divergence that could change a finding. Do not update, pull, or modify a local checkout without the user's request; read a newer reference from temporary storage instead.

### Need

Establish:

- the problem or desired outcome;
- the affected user or system boundary;
- the stated impact;
- explicit constraints;
- expected behavior;
- assumptions embedded in the request.

### Code

Establish:

- current behavior;
- relevant execution paths and boundaries;
- existing capabilities;
- local constraints;
- evidence that confirms or contradicts the need;
- related work in other worktrees and unmerged branches, of the current repository and of local checkouts of the target systems.

Read only what is needed to understand the boundary, but cover every local source enumerated above that touches it.

### Documentation

Establish:

- documented behavior and terminology;
- contracts relevant to the need;
- differences between documentation, code, and the requested outcome;
- whether the documentation is current evidence or historical context.

Do not treat a document as operational authority merely because it records a decision or design.

### Online problem research

Search for:

- equivalent or adjacent problems;
- known failure modes and limitations;
- applicable standards or official recommendations;
- evidence from comparable systems.

### Online solution research

Search separately for:

- established solution patterns;
- viable alternatives;
- trade-offs and failure conditions;
- constraints that determine when each option is appropriate.

Prefer standards, official documentation, primary source material, and maintainer-owned evidence. Use secondary sources only to discover primary ones.

Research both the problem and possible solutions. Solution research informs questions and trade-offs; it does not automatically prescribe an implementation in the ticket.

### Evidence inventory

Keep intermediate evidence outside the conversation so it survives context compaction. Create the inventory when investigation starts, in the isolated temporary staging directory described in Phase 8:

```text
<absolute-staging-directory>/evidence.md
```

Assign a stable refinement identity and stable unit IDs when creating the inventory. For each of the five surfaces, record:

- the sources read, as checkable references;
- the local sources enumerated and which were read or skipped, with the reason;
- the references found for each target system and the declared authority;
- what the surface establishes and what it leaves open.

Update the inventory after each research step and after each user answer or correction. After a context compaction or any loss of earlier detail, re-read the inventory before continuing.

## Phase 3: find gaps and inconsistencies

Compare the five evidence surfaces. Raise a question when evidence cannot resolve a material decision, including when:

- the need conflicts with observed behavior;
- code and documentation describe different contracts;
- the desired outcome has incompatible interpretations;
- an external practice conflicts with a local constraint;
- viable solutions carry meaningfully different trade-offs;
- scope or non-goals are unclear;
- no observable acceptance condition exists;
- ticket classification depends on user intent;
- existing related work needs an explicit disposition.

Verify facts with available evidence instead of asking the user. Do not ask a question the evidence already resolves, such as which component to evaluate when only one candidate exists. Do not ask implementation questions that can remain open without changing the intended outcome.

## Phase 4: refinement rounds

Use at most three question rounds across the entire invocation and all its units. Scope or unit-boundary questions count toward this total.

For each round:

1. Complete all research that can be done with the current information.
2. Gather every material question that can now be asked.
3. Show the inconsistency or gap behind each question with concise evidence.
4. Ask all necessary questions for that round; there is no per-round question limit.
5. Wait for the responses.
6. Investigate the consequences before opening another round.

Defer a question to a later round only when it depends on an earlier answer or on research enabled by that answer.

An answer that directs the investigation instead of answering the question, such as pointing at sources to read or a reference to use, is a correction. Apply it to the research, update the inventory, and re-ask any question it left unanswered in the next round. Do not force it into an answer to the question asked.

After the third round, ask no more skill-initiated refinement questions. Resolve everything available research can still resolve. Only uncertainty requiring user intent or evidence unavailable in this invocation becomes a spike unit; independently understood outcomes can still become feature units.

## Phase 5: classify each unit

Produce an exact proposal covering the supplied need. Classify each independently acceptable unit using its evidence.

### Evidence gate

Do not name, propose, or imply a ticket type, in the proposal or in intermediate messages, until the evidence inventory shows that:

- every surface has been investigated, or the reason it could not be is recorded;
- every enumerated local source that touches the need has been read, or the reason it was skipped is recorded;
- each target system has a declared authoritative reference and every material divergence is stated;
- every user correction has been applied to the research.

Before classifying, show the user a concise summary of the inventory: sources per surface, authoritative references, divergences, and remaining unknowns. Classification follows from that summary.

### Defect

Use `defect` when evidence demonstrates a difference between expected and actual behavior.

Include:

- symptom and impact;
- relevant starting state or environment;
- reproduction conditions or steps;
- expected behavior;
- actual behavior;
- frequency when known;
- supporting evidence;
- observable acceptance criteria.

Name the symptom, not an assumed remedy, in the title.

### Story

Use `story` when a new outcome is sufficiently defined.

Include:

- beneficiary;
- need and value;
- current gap;
- desired outcome;
- scope and exclusions;
- observable acceptance criteria.

Use a user-story sentence only when it adds clarity. Internally check that the story is independent, negotiable, valuable, estimable, small, and testable. Do not add that checklist to the ticket unless the resolved template requires it.

### Technical task

Use `technical-task` when the evidence supports a concrete, verifiable technical outcome that cannot honestly be expressed as user behavior.

Include:

- technical problem;
- evidence;
- expected outcome;
- constraints;
- scope and exclusions;
- verifiable acceptance criteria.

Do not convert an implementation preference into a technical task.

### Spike

Use `spike` when material uncertainty prevents a sufficiently defined defect, story, or technical task. For feasibility, uncertainty is material when implementation depends on unexercised external or runtime behavior that can change the implementation path. Reuse of behavior already demonstrated by a PASS or merged PR proceeds directly; bug reproduction is defect investigation. A spike maps to `dag: poc` with an explicit `question`. The resulting existing issue can later enter the PoC lifecycle through sprint planning, preserving feature/PoC continuations.

Include:

- the research question;
- context and existing evidence;
- unresolved unknowns;
- problem and solution areas to investigate;
- options to compare;
- expected evidence;
- the decision the spike must enable;
- exit criteria.

A spike produces usable knowledge, not production implementation.

## Phase 6: resolve each unit's body template

Read the selected template before closing question rounds. Use the first available source:

1. the template referenced by `.workspace/config/refine.json`;
2. a compatible repository template, selected by classification when unambiguous;
3. the built-in body contract below.

Use one template per unit. Preserve its meaning and satisfy the backend's required sections. Resolve material template ambiguity within the available question rounds.

For `dag: feature`, the body contains `## Problem`, `## Change`, and `## Acceptance`. State evidence, scope, exclusions, and observable acceptance criteria in the relevant sections; add context or dependency sections when needed.

For `dag: poc`, the body contains `## PoC`, `## Verdict`, and `## After PASS`. State the question, minimal experiment against the real target, expected evidence and PASS/failure decision criteria, and the continuation enabled by PASS. A spike produces usable knowledge rather than production implementation.

## Phase 7: build canonical backlog units

The canonical artifact is UTF-8 `units.jsonl`, one JSON object per line:

```json
{"id":"incident-observability","title":"Failed transitions lack a run reference","dag":"feature","labels":["defecto"],"body":"## Problem\nOperators cannot identify which transition failed from the current incident evidence.\n\n## Change\nExpose the failed transition and its run reference in the existing status surface.\n\n## Acceptance\nA failed transition is identifiable from the status surface with its run reference.","source":"refine"}
```

Required fields are `id`, `title`, `dag`, `labels`, and `body`. IDs are unique kebab-case within the refinement. `dag` is `feature` for a defect, story, or technical task, and `poc` for a spike. `labels` is an array of nonempty labels supported by the target repository. Map the evidence-backed classification to its existing label vocabulary; for example, the adopted discovery vocabulary uses `defecto`, `mejora`, and `duplicado`. Keep classification explicit in the body when no corresponding label exists. Every PoC also requires a nonempty `question`.

Set `source` to `refine`. Optional `findings` is an array of unique, nonempty finding IDs. Preserve source report references, verified evidence, operator decisions, and related issues in each body. Keep full investigation detail in `evidence.md`; each issue body remains self-contained after temporary files are removed.

State each unit's full problem, scope, and observable acceptance. Self-contained means understandable and reviewable on its own; declared prerequisites may govern delivery order. Use optional `relationships`, the backlog-breakdown/native planning representation: `[{"kind":"blocked_by","target":{"unit":"prerequisite-unit"}},{"kind":"parent","target":{"issue":442}}]`. Each entry has exactly `kind` and `target`; `blocked_by` makes the target a prerequisite of this unit, and `parent` makes this unit a sub-issue of the target. Each target has exactly `unit` (an exact same-snapshot kebab-case ID, including forward references) or `issue` (an existing positive safe-integer GitHub issue number in the target repository). Use at most one parent and unique kind/target pairs. Both local graphs must be acyclic individually. Explain prerequisite rationale and the umbrella's own observable outcome in the proposal/body. Existing issue identity and remote relationship evidence belong in the evidence inventory. To revise an existing issue, declare `revision: {"issue":444,"fields":["title","body","labels"]}` with the exact selected fields and their values at the canonical root; `fields: []` binds identity only. The backend materializes the approved revisions and native relationships and retains complete verification evidence. Keep stable unit IDs across corrections and retain the refinement identity in the source context.

## Phase 8: stage absolute inputs

Create private, session-isolated temporary storage outside the repository. These commands create the directory and print the absolute handoff path; run them in the coordinating shell and retain `REFINE_STAGE` for this invocation:

```sh
umask 077
export REFINE_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/refine.XXXXXXXX")"
export REFINE_STAGE="$(cd "$REFINE_STAGE" && pwd -P)"
printf 'UNITS_FROM=%s/units.jsonl\n' "$REFINE_STAGE"
```

Write the exact proposal's JSONL rows to `$REFINE_STAGE/units.jsonl`. Store the evidence inventory as `$REFINE_STAGE/evidence.md`. Optional neighboring `source.md` records the supplied input, stable refinement identity, source references, and decisions; optional `plan.md` explains the decomposition and dependencies. Both are context, not additional backend requirements.

Run the package's shared mechanical validator before presenting the proposal:

```sh
dagu-feature-bundle validate-planning-units --input "$REFINE_STAGE/units.jsonl" \
  --findings "$REFINE_STAGE/findings.md"
```

Resolve its complete structured line/field/rule/expected/observed diagnostics in canonical `units.jsonl`. Native `check_plan` invokes the same validator after import. Mechanical validity is separate from independent semantic review and explicit operator authorization.

Only the current user may read or write these files. Concurrent sessions use distinct directories. Keep the directory available while backlog-breakdown imports or reviews it, including correction cycles. Temporary input is session-scoped rather than a durable backlog; later sessions use published issue identifiers as their record.

## Phase 9: present the exact proposal

Present all units together, showing for each:

- stable ID, title, classification, DAG, labels, and any PoC question;
- complete exact issue body, including scope, evidence, and acceptance;
- dependencies, provenance, and the reason for its independent acceptance boundary.

Show the absolute `UNITS_FROM` path, `SOURCE=refine`, target repository, template source, and adopted `planning.yaml` path. Offer to submit exactly this proposal to `backlog-breakdown` for review, approval, and issue creation. Acceptance covers these units and their content; a change in scope or content requires a replacement proposal.

## Phase 10: handle the operator's response

### Accept

After the operator accepts the exact proposal:

1. Invoke the `backlog-breakdown` skill with the staged absolute `UNITS_FROM`, `SOURCE=refine`, established absolute `PRIMARY`, and the coordinating `OMP_SESSION_ID`. Read and follow that skill's actual enqueue and human-task commands; it owns the backend invocation, review, approval, and issue creation.
2. Keep staged inputs available. The backend deterministically imports them, validates them with `check_plan`, obtains independent `plan-reviewer` review, and waits for operator approval before materialization. Refinement acceptance starts that review; it is not a substitute for the backend's approval.
3. If review requests correction, edit the upstream staged units, verify any new facts, and present the complete corrected proposal for acceptance. Only after the upstream correction is accepted does the coordinator rewind to `import_units`. This ensures the next import contains the corrected proposal. Invalid or revise review cannot materialize, even if someone completes the approval form.
4. Let backlog-breakdown create and verify issues and return its `issues.jsonl` mapping. Preserve its issue identifiers and `<!-- breakdown-unit: RUN/id -->` lineage markers. Scheduling new feature/PoC runs belongs to `sprint-planning`.
5. Return the verified issue identifiers/locators and any declared relationships. Remove the temporary staging directory after the backend has finished using it.

The exact handoff is the invocation of `backlog-breakdown` with those values, not a second implementation of its backend commands. The committed config file is required; backlog-breakdown owns all issue creation for refined work.

For the accepted proposal, backlog-breakdown performs this executable enqueue operation using its allocated `BREAKDOWN_RUN_ID`, the established primary checkout and coordinating session. These variables are real values obtained by that skill, not new refine configuration:

```sh
: "${PRIMARY:?Absolute primary checkout required}"
: "${OMP_SESSION_ID:?Coordinating session ID required}"
: "${BREAKDOWN_RUN_ID:?Backlog-breakdown run ID required}"
: "${REFINE_STAGE:?Absolute staging directory required}"
test -r "$PRIMARY/.workspace/dagu/config.json"
test -r "$REFINE_STAGE/units.jsonl"
dagu-feature-bundle enqueue --run-id "$BREAKDOWN_RUN_ID" planning -- \
  UNITS_FROM="$REFINE_STAGE/units.jsonl" PRIMARY="$PRIMARY" SOURCE=refine OMP_SESSION_ID="$OMP_SESSION_ID"
```

Follow backlog-breakdown's review, approval, and correction commands for that run.

### Correct

When the operator corrects the proposal:

1. Invalidate the previous proposal.
2. Apply corrections to the supplied need and affected units.
3. Verify new factual claims, repeat affected research, and update the evidence inventory.
4. Preserve the refinement identity and stable IDs of unchanged units.
5. Rewrite the upstream `units.jsonl` and any affected neighboring context.
6. Present the complete replacement proposal and offer the same review/approval handoff.

Operator corrections are not skill-initiated question rounds. After three rounds, represent material uncertainty that research cannot resolve as a spike unit rather than starting another round.

### Reject or leave

If the operator rejects or abandons the proposal before backend submission, remove its temporary files and end the interaction. If a backend run is already active, coordinate its rejection through backlog-breakdown before removing inputs it still needs. Normal session cleanup removes staged inputs once they are no longer in use.

## Final quality check

Before staging, verify internally that:

- the proposal covers the one supplied, authorized need;
- every unit has an independent acceptance boundary and evidence-backed classification;
- the evidence gate was satisfied before classification;
- authoritative references, divergences, assumptions, and unknowns are explicit;
- every title describes a problem or outcome;
- scope, exclusions, dependencies, and acceptance criteria are consistent;
- operator decisions and source provenance are preserved;
- problem and solution research are represented;
- each body satisfies its template and backend section contract;
- units satisfy the shared JSONL schema and PoCs include `question`;
- the absolute staged input and adopted backend are ready for the accepted handoff.

When evidence cannot support a concrete implementation outcome, propose a spike for that uncertainty. Continue to the exact multi-unit proposal and offer the backlog-breakdown handoff.
