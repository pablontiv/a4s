---
name: refine
description: Refine one authorized need, report, or process incident into evidence-backed, independently acceptable backlog units and hand them to backlog-breakdown after operator acceptance.
---

# Refine

Turn one supplied need into 1..N independently acceptable units. Investigate the need, resolve material inconsistencies with the operator, stage the exact proposal, and use `backlog-breakdown` for independent review, approval, and direct issue creation. This is a procedure, not an execution service: it requires no scheduler, installed extension, or package validator.

Run when the operator explicitly invokes `/refine` with a need, report, or process incident, or explicitly authorizes another skill to hand that input to refinement. An external FYI report is evidence: its arrival alone authorizes neither refinement nor publication. A backlog design or a prior discussion of possible work likewise requires explicit authorization to refine and acceptance of the exact resulting proposal.

## Boundaries

The invocation authorizes investigation, refinement questions, a temporary evidence inventory, staging 1..N temporary backlog units, and offering the exact proposal for acceptance. Issue creation proceeds only after proposal acceptance, through `backlog-breakdown` and its [independent review and approval gate](../backlog-breakdown/SKILL.md#4-approval-and-corrections). Acceptance of a proposal authorizes review, not unreviewed publication. Implementation and scheduling are separate decisions: `sprint-planning` ranks and selects new feature/PoC work for operator-approved execution with `issue-execution`.

Keep project content unchanged during refinement. Temporary evidence and units belong outside the repository. End after accepted units are materialized, rejected, or abandoned; retain staged inputs while an active review needs them.

One coordinator owns canonical `units.jsonl` and integrates preparation evidence. Delegate only a genuine unresolved question, supplying known source ranges and an explicitly bounded output. The coordinator integrates the answer directly into canonical units. Independent semantic review is a separate checkpoint: the author must not approve their own proposal. Mechanical preparation may use a lower-effort role where available, without changing global model configuration; do not weaken independent reviewer routing or mistake a configured model for evidence of the reviewer actually used. Record available reviewer identity and review provenance without requiring a particular agent API.

## Prerequisites and optional template

Establish the target repository, primary checkout, repository instructions (`AGENTS.md`, `CONTRIBUTING`, issue templates), existing label vocabulary, and authorized issue publication access before offering publication. Missing publication access does not authorize a substitute destination: keep the proposal temporary and report the exact prerequisite. No repository automation configuration is required.

An optional `.workspace/config/refine.json` may contain `{"template": null}`. `template` is either `null` or a readable repository-relative or absolute template path. A configured unreadable template is an error; missing configuration uses the body contract below. This optional file holds only the template reference, not execution authority. Pass the established repository explicitly to `backlog-breakdown`.

## Phase 1: establish the supplied need and unit boundaries

Read the full input and identify its problem, desired outcome, and scope. A need may describe incorrect behavior, a new outcome, concrete technical work, or uncertainty requiring investigation. Treat a proposed mechanism as a hypothesis until evidence supports it.

One supplied need, report, or incident can require several units. Combine work that shares an observable outcome, causal uncertainty, and acceptance boundary, or has no independent value. Split work that can be accepted separately, serves different outcomes, or needs materially different investigations.

Investigate every in-scope unit needed to satisfy the supplied need. Explain each proposed boundary and preserve dependencies explicitly. Resolve material ambiguity about supplied scope within the question rounds; the number of units follows from evidence and acceptance boundaries rather than a one-ticket limit.

## Phase 2: investigate the supplied need

Compare five surfaces: need, code, documentation, online problem research, and online solution research. Record what each establishes in the evidence inventory as you go, not at the end.

### Local sources first

Before searching online or fetching an external copy, enumerate local sources that may already hold the target:

- the current repository, including other worktrees and local branches;
- local checkouts of targeted systems, including vendored or sibling repositories and their worktrees and branches;
- installed builds, binaries, or packages and their reported versions.

Read relevant local sources first. Obtain an external copy only when no local source covers the need or the authoritative reference is unavailable locally; record why. Use the repository's approved source-fetching method. Do not modify a checkout to inspect another reference.

### Reference authority

List every reference found for each system: installed version, local checkout `HEAD`, local remote-tracking ref, and current remote default branch checked without modifying the checkout. Declare which is authoritative and why. By default, the current remote default branch is authoritative for capabilities, while the installed version is authoritative for what the operator runs today. State every divergence that could change a finding. Do not update, pull, or modify a local checkout without the operator's request; inspect a newer reference in temporary storage instead.

### Need

Establish the problem or desired outcome, affected user or system boundary, stated impact, explicit constraints, expected behavior, and assumptions embedded in the request.

### Code

Establish current behavior, relevant execution paths and boundaries, existing capabilities, local constraints, evidence confirming or contradicting the need, and related work in other worktrees and unmerged branches of both the current repository and local target checkouts. Read only what is needed to understand the boundary, but cover every enumerated local source that touches it.

### Documentation

Establish documented behavior and terminology, relevant contracts, differences between documentation/code/request, and whether documentation is current evidence or historical context. Do not treat a document as operational authority merely because it records a decision or design.

### Online problem research

Search for equivalent or adjacent problems, known failure modes and limitations, applicable standards or official recommendations, and comparable-system evidence.

### Online solution research

Search separately for established solution patterns, viable alternatives, trade-offs and failure conditions, and constraints determining when each option applies. Prefer standards, official documentation, primary sources, and maintainer-owned evidence; use secondary sources to discover primary ones. Research both the problem and solutions. Solution research informs questions and trade-offs; it does not automatically prescribe implementation in the ticket.

### Evidence inventory

Create `<absolute-staging-directory>/evidence.md` when investigation starts, using private temporary storage described in Phase 8. Assign a stable refinement identity and stable unit IDs. For each of the five surfaces record:

- checkable references to sources read;
- local sources enumerated, and those read or skipped with reasons;
- references found for each target and declared authority;
- what the surface establishes and leaves open.

Update after each research step and every operator answer or correction. Re-read after compaction or loss of earlier detail.

## Phase 3: find gaps and inconsistencies

Compare the five surfaces. Raise a question when evidence cannot resolve a material decision, including:

- the need conflicts with observed behavior;
- code and documentation describe different contracts;
- the outcome has incompatible interpretations;
- external practice conflicts with local constraints;
- viable solutions have meaningfully different trade-offs;
- scope or non-goals are unclear;
- no observable acceptance condition exists;
- classification depends on operator intent;
- related work needs an explicit disposition.

Verify available facts instead of asking the operator. Do not ask what evidence already resolves, or implementation questions that can remain open without changing the outcome.

## Phase 4: refinement rounds

Use at most three question rounds across the entire invocation and all units. Scope and unit-boundary questions count. In each round:

1. Complete all research possible with current information.
2. Gather every material question that can now be asked.
3. Show the evidence behind each inconsistency or gap.
4. Ask all necessary questions together; there is no per-round question limit.
5. Wait for responses.
6. Investigate their consequences before opening another round.

Defer a question only when it depends on an earlier answer or research enabled by that answer. An answer directing investigation rather than answering the question is a correction: apply it, update evidence, and re-ask any unanswered question in the next round. Do not force a correction into an answer.

After round three, ask no more skill-initiated refinement questions. Resolve everything available research can resolve. Only uncertainty requiring operator intent or unavailable evidence becomes a spike; independently understood outcomes can still become feature units. Under an explicit autonomous mandate, use its research/advisor decision rules instead of question waits; record unresolved intent rather than inventing authorization.

## Phase 5: classify each unit

### Evidence gate

Do not name, propose, or imply a ticket type, even in intermediate messages, until the inventory shows that:

- every surface was investigated or its unavailability explained;
- every relevant enumerated local source was read or its omission explained;
- each target has an authoritative reference and material divergences are stated;
- every operator correction was applied to research.

Before classification, show a concise inventory summary: sources per surface, authorities, divergences, and remaining unknowns. Classification follows from that summary.

### Defect

Use `defect` when evidence demonstrates a difference between expected and actual behavior. Include symptom/impact, starting state or environment, reproduction conditions or steps, expected and actual behavior, frequency when known, supporting evidence, and observable acceptance criteria. Title the symptom, not an assumed remedy.

### Story

Use `story` when a new outcome is sufficiently defined. Include beneficiary, need/value, current gap, desired outcome, scope/exclusions, and observable acceptance. Use a user-story sentence only when it clarifies. Internally check independence, negotiability, value, estimability, smallness, and testability; include that checklist only when the resolved template requires it.

### Technical task

Use `technical-task` when evidence supports a concrete verifiable technical outcome that cannot honestly be expressed as user behavior. Include technical problem, evidence, expected outcome, constraints, scope/exclusions, and verifiable acceptance. An implementation preference alone is not a technical task.

### Spike

Use `spike` when material uncertainty prevents a sufficiently defined defect, story, or technical task. Feasibility uncertainty is material when implementation depends on unexercised external or runtime behavior that can change its path. Reuse already demonstrated by a PASS or merged change proceeds directly; bug reproduction is defect investigation. A spike has `kind: poc` and an explicit `question`; sprint planning later selects that existing issue for direct experimentation.

Include the research question, context and evidence, unknowns, problem and solution areas to investigate, alternatives, expected evidence, decision to enable, and exit criteria. A spike produces usable knowledge, not production implementation. Define a minimal real-target experiment and explicit PASS/FAIL/INCONCLUSIVE criteria. Execution requires operator approval of target, scope, effects, and cleanup, with the `pve-api` procedure when relevant. Refinement itself does not authorize running the experiment or promoting a PASS to implementation.

## Phase 6: resolve each unit's body template

Read the selected template before closing question rounds. Use the first available source:

1. the template referenced by `.workspace/config/refine.json`;
2. a compatible repository template selected by classification when unambiguous;
3. the built-in body contract below.

Use one template per unit. Preserve its meaning and resolve material ambiguity within available question rounds.

For `kind: feature`, include `## Problem`, `## Change`, and `## Acceptance`. Place evidence, scope, exclusions, and observable acceptance in the relevant sections; add context/dependencies as needed. A repository-required template may use equivalent sections without losing these contents.

For `kind: poc`, include `## PoC`, `## Verdict`, and `## After PASS`. State the question, minimal real-target experiment, approval boundary, expected evidence, explicit verdict criteria, and continuation enabled by PASS. `Verdict` specifies criteria before execution; never fabricate an observed result. A completed experiment's verdict and findings are later published directly in the issue. Promotion requires separately authorized delivery.

## Phase 7: build canonical backlog units

The canonical artifact is UTF-8 `units.jsonl`, one JSON object per line:

```json
{"id":"incident-observability","title":"Failed transitions lack an identifiable cause","kind":"feature","labels":["defecto"],"body":"## Problem\nOperators cannot identify why a transition failed from available evidence.\n\n## Change\nMake the failed transition and its cause identifiable in the existing status surface.\n\n## Acceptance\nA failed transition and its cause can be identified from the status surface.","source":"refine"}
```

Required fields: `id`, `title`, `kind`, `labels`, `body`. IDs are unique kebab-case within the refinement. `kind` is `feature` for defects, stories, and technical tasks, or `poc` for spikes. Labels are nonempty strings supported by the target repository. Map classification to existing vocabulary (for example `defecto`, `mejora`, `duplicado`); make classification explicit in the body when no corresponding label exists. Every PoC requires nonempty `question`. Set `source` to `refine`. Optional `findings` is an array of unique nonempty finding IDs.

Preserve source references, verified evidence, operator decisions, and related issues in each body. Full research remains in `evidence.md`; an issue must remain self-contained after temporary files are removed. Self-contained means independently understandable and reviewable, not free of prerequisites.

Use optional `relationships`:

```json
[{"kind":"blocked_by","target":{"unit":"prerequisite-unit"}},{"kind":"parent","target":{"issue":442}}]
```

Each entry has exactly `kind` and `target`. `blocked_by` makes the target a prerequisite; `parent` makes this unit a sub-issue of the target. Each target has exactly `unit` (an exact same-proposal kebab-case ID, including forward references) or `issue` (an existing positive safe-integer issue number in the target repository). Use at most one parent and unique kind/target pairs. Dependency and parent graphs must each be acyclic. Explain prerequisite rationale and any umbrella's own observable outcome. Record existing issue identity and remote relationship evidence in the inventory.

For an existing issue revision, declare `revision: {"issue":444,"fields":["title","body","labels"]}` with only the selected fields and their proposed values at the canonical root; `fields: []` binds identity without changing those fields. `backlog-breakdown` applies only approved revisions and relationships and retains verification evidence. Preserve stable unit IDs across corrections and refinement identity in source context.

## Phase 8: stage absolute inputs

Create private temporary storage outside the repository, isolated from other invocations and readable/writable only by the current user. Retain its absolute path. Write canonical `units.jsonl` and `evidence.md` there. Optional `source.md` records supplied input, refinement identity, references, and decisions; optional `plan.md` explains decomposition/dependencies. These are ordinary review documents, not execution configuration.

Inspect every JSONL row for valid JSON, required fields, supported values, unique IDs, nonempty bodies and PoC questions, valid selected revision fields, resolvable relationships, and acyclic graphs. Record diagnostics as line/field/rule/expected/observed and correct canonical input. Use available general-purpose parsing tools if useful, but no package-specific validator is a prerequisite. Mechanical validity is separate from independent semantic review and publication authorization.

Keep inputs available through independent review and correction cycles. Temporary input is not a durable backlog; later work uses published issue identifiers.

## Phase 9: present the exact proposal

Show all units together, each with stable ID, title, classification, kind, labels, PoC question if any, complete exact body, dependencies, provenance, and independent acceptance rationale. Include absolute input path, target repository, source `refine`, and template source. Offer exactly this proposal to `backlog-breakdown` for independent review, approval, and direct issue creation. Acceptance covers exact content; changed scope or content requires a replacement proposal.

## Phase 10: handle the operator's response

### Accept

A recorded [autonomous mandate](../sprint-planning/SKILL.md#5-autonomous-sprint) can supply acceptance only within its explicit issue-creation scope; independent review remains mandatory.

After acceptance:

1. Invoke `backlog-breakdown` with the absolute staged input, source `refine`, established primary checkout and target repository, evidence, and exact accepted proposal. Follow that skill's review and approval procedure; do not duplicate its publication implementation.
2. Keep inputs available while an independent reviewer examines the unchanged proposal. Proposal acceptance starts review and does not replace its approval gate.
3. On requested correction, update staged units, verify new facts, and present the complete replacement proposal for acceptance. Invalidate prior approval and obtain independent review of the corrected content. Invalid or revise review cannot authorize publication.
4. Let `backlog-breakdown` create or revise issues directly, verify relationships and contents, and return the stable unit-to-issue mapping. Preserve its provenance/idempotency markers without inventing execution identifiers. Scheduling belongs to `sprint-planning`.
5. Return verified issue identifiers/locators and relationships. Remove temporary staging only after no active review/publication needs it.

### Correct

Invalidate the previous proposal; apply corrections to the need and units; verify new factual claims and repeat affected research; update inventory; preserve refinement identity and unchanged unit IDs; rewrite canonical inputs; and present the complete replacement for the same review/approval boundary.

Operator corrections are not skill-initiated question rounds. After three rounds, unresolved material uncertainty becomes a spike instead of another round.

### Reject or leave

If rejected or abandoned, stop publication and remove temporary files once no active reviewer needs them. Coordinate cancellation of an active handoff with `backlog-breakdown`; do not remove inputs still in use or assume cancellation reverses already published changes.

## Final quality check

Before handoff, establish that:

- the proposal covers the authorized need and each unit has an independent acceptance boundary;
- classification followed the evidence gate;
- authorities, divergences, assumptions, and unknowns are explicit;
- titles describe problems or outcomes;
- scope, exclusions, dependencies, and acceptance are consistent;
- operator decisions, source provenance, problem research, and solution research survive in the proposal;
- bodies satisfy their templates and substantive section contracts;
- JSONL fields and relationship graphs satisfy the contract, including PoC questions;
- the absolute staged input and explicit repository are ready for accepted independent review.

When evidence cannot support a concrete implementation outcome, propose a spike for that uncertainty. Continue to the exact multi-unit proposal and offer the `backlog-breakdown` handoff.
