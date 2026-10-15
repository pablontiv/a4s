---
name: refine
description: Refine a supplied need into an evidence-backed ticket and offer immediate materialization in the configured destination.
---

# Refine

Turn one need into a well-founded ticket. Investigate the need, surface material inconsistencies, resolve them with the user, stage one temporary canonical ticket, and offer to materialize it immediately.

Run only when the user explicitly invokes `/refine` with a need.

## Boundaries

The invocation authorizes:

- investigating the supplied need;
- asking refinement questions;
- bootstrapping the ticket destination when it is not configured;
- keeping a temporary evidence inventory;
- staging one temporary ticket;
- offering immediate materialization.

It does not authorize:

- implementing the resulting work;
- changing project content other than the destination bootstrap;
- starting any downstream process;
- materializing a ticket before the user accepts the exact proposal;
- preserving a draft for a later session.

Stop after the ticket is materialized, rejected, or lost with the session.

## Workspace configuration

Store this skill's durable configuration under:

```text
.workspace/config/refine.json
```

For now, the configuration owns only the materialization destination and an optional template reference:

```json
{
  "destination": {
    "adapter": "<adapter>",
    "target": "<target>"
  },
  "template": null
}
```

Do not store credentials. Do not add workflow, readiness, implementation, review, or delivery policy to this file.

### First-use bootstrap

When the configuration or destination is missing:

1. Ask for the destination adapter and target.
2. Ask for an optional workspace template only when the user wants one.
3. Persist only those values in `.workspace/config/refine.json`.
4. Continue refining the original need in the same invocation.

Ask all bootstrap questions in one response. Bootstrap configures the destination; it does not refine the need, so it does not count toward the three-round limit.

## Phase 1: identify the needs

Read the full input and extract every distinct need it contains. A need may describe:

- incorrect observable behavior;
- a new desired outcome;
- concrete technical work;
- an uncertainty that requires investigation.

Treat a proposed mechanism as a hypothesis until evidence supports it.

### Relate or separate

Needs are related when they share the same observable outcome, causal uncertainty, and acceptance boundary, or when none of them would be useful independently. Combine related needs into one candidate.

Needs are independent when they can be accepted separately, serve different outcomes, or require materially different investigations.

When the input contains several independent candidates, do not investigate all of them. Present a short proposal for each candidate containing:

- the need;
- why it is independent;
- the investigation that would be required.

Ask the user to select one. Refine exactly one candidate per invocation. Candidate selection counts as a refinement round when it requires a question.

## Phase 2: investigate the selected need

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

Keep the intermediate evidence outside the conversation so it survives context compaction. Create the inventory when investigation starts, next to the draft location described in Phase 8 and under the same isolation and cleanup rules:

```text
<system-temporary-storage>/refine/<repository-id>/<session-id>/evidence--<draftId>.md
```

Assign the `draftId` when creating the inventory; Phase 7 reuses it. For each of the five surfaces, record:

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

Verify facts with available evidence instead of asking the user. Do not ask a question the evidence already answers, such as which component to evaluate when only one candidate exists. Do not ask implementation questions that can remain open without changing the intended outcome.

## Phase 4: refinement rounds

Use at most three question rounds across the entire invocation. Candidate-selection questions count toward this total, leaving only the remaining rounds for later refinement. Bootstrap questions do not count.

For each round:

1. Complete all research that can be done with the current information.
2. Gather every material question that can now be asked.
3. Show the inconsistency or gap behind each question with concise evidence.
4. Ask all necessary questions for that round; there is no per-round question limit.
5. Wait for the answers.
6. Investigate the consequences before opening another round.

Defer a question to a later round only when it depends on an earlier answer or on research enabled by that answer.

An answer that directs the investigation instead of answering the question, such as pointing at sources to read or a reference to use, is a correction. Apply it to the research, update the inventory, and re-ask any question it left unanswered in the next round. Do not force it into an answer to the question asked.

After the third round, ask no more skill-initiated refinement questions. Before turning remaining uncertainty into a spike, resolve every part that available research can still resolve. Only uncertainty that requires user intent or evidence that cannot be gathered in this invocation becomes the subject of a spike ticket.

## Phase 5: classify the ticket

Always produce a ticket proposal.

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

Use `spike` when material uncertainty prevents a sufficiently defined defect, story, or technical task. For feasibility, uncertainty is material when implementation depends on unexercised external or runtime behavior that can change the implementation path. Reuse of behavior already demonstrated by a PASS or merged PR proceeds directly; bug reproduction is defect investigation. Record the question and evidence through `dagu-feature` triage and its PoC lifecycle.

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

## Phase 6: resolve the materialization template

Resolve the template before the final proposal, using the first available source in this order:

1. the template referenced by `.workspace/config/refine.json`;
2. a compatible template provided by the repository;
3. the configured adapter's default template.

Do not merge templates. A configured template that cannot be read is an error, not permission to silently fall back.

When several repository templates are available, select by ticket type when unambiguous. Resolve any material ambiguity within the available refinement rounds.

Read the selected template before closing the question rounds so required information can be gathered during refinement.

## Phase 7: create the canonical ticket

Create a destination-independent JSON object with these base fields:

```json
{
  "schemaVersion": 1,
  "draftId": "<stable unique id>",
  "slug": "<readable-kebab-case-title>",
  "type": "defect | story | technical-task | spike",
  "title": "<title>",
  "need": "<selected need>",
  "problem": "<evidence-backed problem>",
  "evidence": [
    {
      "claim": "<verified claim>",
      "source": "<checkable local or online reference>"
    }
  ],
  "research": {
    "problemPatterns": [],
    "solutionOptions": []
  },
  "decisions": [
    {
      "question": "<material question>",
      "answer": "<user decision>"
    }
  ],
  "expectedOutcome": "<observable outcome>",
  "scope": {
    "included": [],
    "excluded": []
  },
  "acceptanceCriteria": [],
  "unknowns": []
}
```

Add type-specific fields only when relevant. A spike adds:

```json
{
  "spike": {
    "researchQuestion": "<question>",
    "optionsToEvaluate": [],
    "expectedEvidence": [],
    "decisionEnabled": "<decision>",
    "exitCriteria": []
  }
}
```

`draftId` is the stable identity of the refinement. Derive `slug` from the current title. Preserve `draftId` across user corrections, but regenerate the slug when the title changes materially. Never rely on the slug alone for uniqueness.

## Phase 8: stage the temporary draft

Write the canonical JSON to system-provided temporary storage outside the repository. Isolate it by repository, session, and draft identity. Use the equivalent of:

```text
<system-temporary-storage>/refine/<repository-id>/<session-id>/<slug>--<draftId>.json
```

Requirements:

- only the current user can read or write the draft;
- concurrent sessions cannot overwrite one another;
- the draft never enters project storage;
- the draft is not a durable backlog;
- a later session does not discover or resume it.

The evidence inventory from Phase 2 lives in the same directory under the same requirements. Delete it together with the draft after materialization, rejection, or normal session closure; keep it across corrected proposals, updating it as Phase 10 requires.

Delete the draft after successful materialization, rejection, replacement by a corrected proposal, or normal session closure. An interrupted environment may retain temporary bytes until its own cleanup, but the draft remains functionally unavailable to later sessions.

## Phase 9: present the exact proposal

Render the canonical ticket through the resolved template and destination adapter. Present:

```text
Draft: <slug>
Type: <type>
Destination: <configured destination>
Template source: workspace | repository | adapter

<exact rendered ticket>
```

Always offer to materialize that exact proposal immediately.

Do not create a separate publish or materialize command. Materialization is the continuation of the same `/refine` interaction.

## Phase 10: handle the user's response

### Accept

When the user accepts the exact proposal:

1. Materialize exactly the rendered ticket in the configured destination.
2. Verify that the destination returns an identifier.
3. Delete the temporary JSON and the evidence inventory.
4. Return the identifier or locator.
5. Stop.

### Correct

When the user supplies corrections:

1. Invalidate and delete the previous temporary JSON.
2. Apply the corrections to the selected need.
3. Verify any new factual claim.
4. Repeat affected research when the correction changes evidence or scope, and update the evidence inventory.
5. Preserve the `draftId`.
6. Generate a new slug when appropriate.
7. Write a new temporary JSON.
8. Present a complete replacement proposal.
9. Offer immediate materialization again.

User corrections are not skill-initiated question rounds. After three refinement rounds, any new material uncertainty introduced by a correction is represented in a spike rather than opening another question round.

Do not preserve superseded proposals.

### Reject or leave

When the user rejects the proposal, declines immediate materialization, or ends the session:

1. Delete or abandon the temporary JSON and evidence inventory according to the environment's session cleanup.
2. Do not create a durable record.
3. Do not offer future resumption.
4. Stop.

## Adapter contract

The configured destination adapter may only:

1. identify the destination;
2. provide its default template;
3. render the canonical ticket;
4. create one record;
5. return and verify its identifier.

It must not change the ticket's meaning, add scope, invent metadata, create extra records, or start downstream work.

## Final quality check

Before staging the JSON, verify internally that:

- exactly one selected need is being refined;
- the ticket type follows from the evidence;
- the evidence gate in Phase 5 was satisfied before the type was named;
- authoritative references and their divergences are stated in the evidence;
- assumptions and unknowns are explicit;
- the title describes the problem or outcome;
- scope and exclusions do not conflict;
- acceptance criteria are observable;
- user decisions are preserved;
- both problem and solution research are represented;
- unnecessary implementation detail is absent;
- the resolved template is satisfied.

If these checks cannot support a concrete type, produce a spike. Always continue to an exact ticket proposal and offer immediate materialization.
