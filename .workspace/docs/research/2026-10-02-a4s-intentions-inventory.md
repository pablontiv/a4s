---
tipo: research
fecha: '2026-10-02'
estado: researched
title: A4S operator intentions inventory
research_track: operator-intentions
baseline_sha: 494a7ffe1b8e91dd3416986a2353cd6af7e366eb
authority_source: .workspace/config.yaml
corpus_start: '2026-08-31'
corpus_end: '2026-10-02'
acceptance_status: not-assessed
---

# A4S operator intentions inventory

## 1. Question, purpose, and boundaries

**Question:** Which observable needs has the operator been trying to satisfy with A4S, which historical mechanisms were proposed for them, and which formulations remain coherent under the current direction and repository authority?

This inventory is the intentions input to a separate investigation of Pi capabilities. It preserves the problem behind an old component without preserving that component by inertia. It is not a new implementation, architecture, migration plan, backlog, roadmap, or authorization to operate anything.

### Terminology and companion research

- **Intent:** the observable result or operator problem to satisfy, independent of its implementation.
- **Mechanism:** a proposed or existing means of pursuing that intent, such as a skill, daemon, package, setting, or workflow.
- **Capability:** a behavior a runtime or component actually provides, subject to its documented scope and version.
- **Correspondence:** an evidence-backed connection between an intent and a capability, including unsupported paths and conflicts. That cross-track mapping is **not completed here**.
- **Operational availability:** the capability is loadable and works in the actual consuming environment, with the required checks and acceptance—not merely documented, committed, mocked, or proposed.

Companion: [Pi capabilities relevant to the Harness Handbook](2026-10-02-pi-handbook-capabilities.md). The two researches provide inputs to a later correspondence decision; **neither establishes the completed crosswalk, a roadmap, or operational availability**.

The current research direction is to use **Pi**, identify intentions, follow the **Harness Handbook** as closely as the evidence supports, and exclude inconsistent or conflicting formulations instead of forcing a large collection of components. The operator's preference for “2 componentes que funcionen” rather than “20 que solo hagan ruido” is a quality test, **not a target component count**. The proposed Pi package that starts an image and runs tests **inside that image** is recorded as a proposed means; no package or container experiment was implemented here. [E01]

The baseline repository purpose is recurring multi-repository work converted into incremental capabilities for outer harnesses, with availability claimed only after usable behavior is delivered and verified. No inspected primary source establishes a revenue goal, commercial product commitment, universally autonomous suite, or obligation to migrate related repositories. [N01; R01; E02]

### Fast read: current direction and exclusions

**Current research direction:** Pi is selected; investigate intentions and documented runtime capabilities; prefer useful atomic functions; follow Handbook evidence paths; exclude conflicting or unsupported formulations. The image-test idea remains a proposal, with tests explicitly inside the image. [E01]

**Current repository controls:** integrated config is sole WoW authority; the operator chooses investigated results; autonomy has explicit scope; consequential effects require authorization; checks are proportional; durable evidence and exact safe cleanup matter. These are controls/preferences for work, **not 68 features to implement**. [N01]

**Do not carry forward by default:** a private control plane, global LLM Mission Control, universal Jev authority, peer-only or subagent-only topology, always-delegate/fan-out, automatic rule activation, the full legacy Roadmap, obsolete CI exceptions, mandatory separate PoCs, mandatory E2E/reviewer stacks for documents, or wholesale related-project migrations. Section 5 records the supporting conflicts and uncertainty.

| Semantic need family | Inventory range | What can survive without the historical means |
| --- | --- | --- |
| Useful multi-repo outcomes and bounded scope | INT-001–008 | Useful work and evidence, not an inherited harness or migration target. |
| Understandable human/task authority | INT-009–016 | Informed choice, explicit authorization and one policy source, not universal Jev/controller authority. |
| Reliable intake, backlog and progress | INT-017–026 | Captured commitments and factual status, not one mandatory skill/scheduler. |
| Continuity, context and learned guidance | INT-027–036 | Recoverable, current, economical context and reviewable lessons, not automatic rule authority. |
| Effective delegation and attention | INT-037–041 | Safe concurrency, clear ownership and actionable reporting, not unconditional delegation. |
| Resource and trust boundaries | INT-042–049 | Available-provider resilience and protected credentials/data, not a fixed routing matrix/private client. |
| Evidence-led delivery and value | INT-050–059 | Real useful acceptance and proportional verification, not activity metrics or a container launcher alone. |
| Low-friction reusable operation | INT-060–068 | Native settings, readable work, clear WoW and bounded reuse, not another universal framework. |

### Supported conclusion

The recurring operator need is **useful work that remains understandable, attributable, recoverable, and verifiable without excessive operator effort**. The historical daemon, Mission Control, Herdr peer topology, Jev decision layer, rule compiler, Roadmap variants, and routing proposals are alternative or evolving means, not a single inseparable requirement.

Three distinctions are essential for later Pi mapping:

1. **Need is not mechanism.** Wanting continuity does not require an A4S daemon; wanting timely attention does not require a polling LLM; wanting independent review does not require an unconditional provider topology.
2. **Evidence is not authority.** Historical user requests, ADRs, commits, tests, and accepted-looking status fields do not displace the integrated configuration or prove operator acceptance and delivered value.
3. **Research is not activation.** This document identifies intentions and conflicts. It does not decide that Pi satisfies them or authorize cutover, deletion, credentials use, live mutation, or changes to the way of working.

## 2. Sources, method, and declared coverage

### 2.1 Authority and time window

- Repository snapshot: `494a7ffe1b8e91dd3416986a2353cd6af7e366eb`.
- The local `main`, local `origin/main`, and research baseline resolved to that SHA at inspection. Their `.workspace/config.yaml` Git blob IDs all matched `5e3ca645e0f8e1a8db90e4f6ffc88e7adac24c92`. This is a local-reference check, not a new fetch or independent remote-state attestation.
- Current normative authority: `.workspace/config.yaml`, as integrated on `main`. A worktree copy is not a new norm. ADRs, plans, reports, historical profiles, and skills are records or mechanisms.
- Record window: **2026-08-31 through 2026-10-02**. Located human-message evidence begins on 2026-09-01. Dates and timestamps below are UTC unless a Git author timestamp explicitly carries an offset.
- Backscroll preflight: official CLI `/Users/pones/.local/bin/backscroll status`; 5,695 indexed files, 488,705 messages, zero embeddings/vectors, four active input sources. Its initial reported indexing timestamp was `2026-10-02 20:12:06 UTC`. The live index continued advancing during research.
- Project session population at the bounded listing: **164 A4S-classified sessions**: 40 Claude, 7 Codex, 117 Pi, zero OpenCode. This is an index population, not 164 authenticated operator conversations. `list` timestamps describe indexed sessions and do not establish the earliest message in each one.

### 2.2 Retrieval and attribution procedure

1. Read the complete baseline config before research. Resolve each current-policy claim to a named config key.
2. Run the official Backscroll preflight and search `--project a4s` first, using `--role user --content-type text --lexical-only --fields full --json`.
3. Survey 34 topical queries with a 60-row bound per query, using smaller initial pages and offset recovery where useful. Cross-check selected historical sessions and the current conversation by `--source-path`.
4. When a purpose-word query returned no project result, widen once using `--all-projects --text '"A4S" purpose'`. That found a proposed portable requirements text and substantial injected material, not a new adopted purpose. Equivalent-topic primary evidence and config, not the empty keyword, settle the inventory.
5. Treat `role=user` as a retrieval filter, **not proof of human authorship**. Exclude AGENTS/environment/skill wrappers, generated dispatcher instructions, assistant-to-agent messages, hook/control output, pasted `WORK_RESULT`, and copied transcript instructions as independent operator intentions. In mixed messages, distinguish the operator's actual question or correction from the quoted proposal.
6. Deduplicate identical timestamp/text pairs across forked or copied sessions. In particular, repeated September 18 messages recur in several September 19 Pi forks; they are not independent confirmations or votes.
7. Consult documentation through Rootline. Survey all **66 A4S ADR decision records**, including the two differently named `0023` records; inspect selected full records and relevant fixed Git changes. Rootline reported 168 records under `.workspace/docs` before the two research documents were added. Archived Handbook records are context, not current policy.
8. Separate observable need, historical proposed means, evidence locator, currentness/authority, conflict, and disposition. A question, request to evaluate, or pasted plan is not silently promoted into an architectural decision.

The 34-query coverage audit retrieved **844 row occurrences**, deduplicating to **398 timestamp/text records across 74 source sessions**. A coarse provenance screen labeled 87 wrapper/dispatch-like records, 3 long or mixed records, and 308 **candidate-human** records. These are retrieval/classification counts, not counts of verified human decisions or fully read transcripts. Cited evidence was checked individually; non-cited rows were used for topic discovery only.

### 2.3 What “exhaustive” means here

This is an exhaustive **topic inventory within the declared, relevant retrieved corpus and complete current-config/ADR-decision survey**, not a claim that every historical conversation, every source file, or every related repository was read. Inventory rows are not a frequency ranking.

The first topical pass, offset recovery, exact-session checks, and ADR survey converged on the families in section 4. Recovery added useful distinctions—bootstrap/version visibility, task-oriented todos, proportional review, native settings, and image-contained tests—but did not justify retaining the old harness wholesale. This is **thematic convergence**, not proof of global retrieval saturation.

Eight lexical queries reached the 60-row bound: `backlog`, `roadmap`, `compact`, `reglas`, `jev`, `workspace`, `ci`, and `skills`. Additional relevant history can exist below those ranks. Lexical stemming, Spanish accents/variants, project classification, copied sessions, and generated user-role messages limit recall and attribution. There was no semantic/vector retrieval.

**Coverage limitations:** no exhaustive cross-project history scan; no live Beads read or mutation; no direct authentication of every dispatched historical text; no current global Pi installation audit; no container, model, provider, credential, runtime, acceptance, or cost measurement executed. Engram was not used as primary evidence and no memory write was performed. The separate Pi research owns public runtime capability claims.

## 3. Reading conventions

### Authority/currentness labels

- **N:** present in the inspected normative configuration. This does not prove enforcement or delivered behavior.
- **D:** direct current research direction from an individually checked human message. It authorizes this investigation only to its stated scope; it does not amend config by itself.
- **H:** historical human wish or problem report. It is evidence of intention, not current authority.
- **R:** historical repository record or Git change; its claimed status is not operational acceptance.
- **Q:** question, exploration, or proposed mechanism; adoption is not established.
- **U:** origin, adoption, or operational satisfaction remains unknown.

### Dispositions

- **Retain intent:** coherent observable need; no commitment to its old mechanism.
- **Reformulate:** retain the underlying need but remove an overbroad, conflicting, or unproven formulation.
- **Exclude historical formulation:** do not carry that formulation into later mapping as a requirement. This does not authorize deleting artifacts.
- **Unknown:** evidence is insufficient to determine adoption, necessity, or scope.

Every `INT-###` is a stable research identifier. It is not a Bead, component, package, or planned work unit. Multiple intentions may share a native behavior; one intention may span several behavior paths. Later mapping must not infer a one-intent/one-component correspondence.

## 4. Searchable inventory

### 4.1 Project purpose and scope

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-001 | Turn recurring multi-repository effort into usable, verified capability. | Incremental A4S monorepo and “outer harness” capabilities rather than a speculative suite. | N01 `purpose.outcome`; R01 ADR 0021, 2026-09-21; E02, 2026-09-17. | N; the product purpose is explicit. | A repository change or narrative is not proof that the capability is useful or available. No commercial outcome is evidenced. | Retain intent. |
| INT-002 | Prevent open commitments from disappearing when focus, incoming work, or sessions change. | Minimal ledger, resurfacing, reconciliation gate; Beads considered against Agentpack. | E03, 2026-09-16/17; R02 ADR 0001, 2026-08-31. | H/R; current task records and blockers are N under `define_work`, `track_work`. | A custom ledger/control plane is not required by the need. The September 15 portable requirements were proposed for evaluation, not adopted wholesale. | Retain intent; reformulate mechanism-neutrally. |
| INT-003 | Reduce the human fatigue of coordinating many projects and deciding where attention is needed. | One Mission Control UI with tickets; retain project/task ownership while exploring a non-LLM global layer. | E02, `2026-09-17T14:49:42Z`; R03 ADR 0010, 2026-09-17. | H/Q; explicit reported fatigue and interest in centralization. | The user asked to investigate removing the LLM from the global layer, not to remove all project ownership or prescribe a new dashboard. No attention-volume benefit was measured here. | Retain intent; exclude a mandatory global LLM or dashboard implementation. |
| INT-004 | Keep a comprehensible A4S project boundary without preserving the old harness simply because it exists. | Earlier Handbook consolidation, later clean cutover and repository-location discussions. | E01, 2026-10-02; E02, 2026-09-17; R01 ADRs 0011/0021. | D/N for the research's A4S boundary; H/Q for relocation details. | A quoted cutover sequence and “new repository?” questions are not authorization for repository replacement, destruction, or history rewriting. | Retain intent; leave repository mutation and cutover timing unknown. |
| INT-005 | Use the selected existing runtime rather than compare or maintain unwanted runtime paths indefinitely. | Pi selected after an earlier Codex-oriented mapping. | E01, `2026-10-02T14:40:36Z`: “usaremos pi no Codex”. | D; selection is explicit. | This does not certify Pi's clean startup, isolation, approvals, lifecycle durability, or runtime fit. | Retain intent; Pi satisfaction belongs to track 2 and later tests. |
| INT-006 | Understand real runtime behavior before modifying it; do not force inconsistent intentions. | Harness Handbook behavior map and progressive evidence disclosure. | E01, `03:08:50Z`, `03:13:26Z` on 2026-10-02; W01. | D; the requested guiding method is explicit. | Handbook examples and code paths for other runtimes are not Pi evidence. “Follow closely” is not authority to copy an architecture or override config. | Retain intent. |
| INT-007 | Add small useful functions incrementally, not a noisy inventory of preserved components. | Atomic capabilities after cutover; earlier PoC-first delivery increments. | E01, `02:03:47Z`, `03:13:26Z`; E12, 2026-09-25; N01 `prepare_work.design`. | D/N. | “Two rather than twenty” is not an architecture constraint or component target. Existing code receives no preservation entitlement. | Retain intent; exclude count-driven design. |
| INT-008 | Reuse lessons from other projects without migrating them by implication. | Related-project reference register and consolidation of relevant Handbook material. | E02, `2026-09-17T19:30:57Z`; R04; N01 `product.providers`. | N/H; migration exclusion is directly supported. | Homeserver, Firstmate, Factory, Orca, and other references do not become A4S-owned code or migration scope. | Retain intent; exclude wholesale related-project migration. |

### 4.2 Operator, task, and normative authority

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-009 | Make informed choices without becoming the bottleneck for every technical detail. | September 19 “every decision through Jev”, at least three expanding-context iterations, then human fallback. | E04, `2026-09-19T15:18:17Z`, `15:28:41Z`; N01 `roles`, `choose_work`. | H for universal Jev; N gives the operator result choice and reserved authority. | Universal Jev decision/approval conflicts with operator authority and lacks an adopted current delegation boundary. Classifier output is not human authorization. | Reformulate as evidence-supported decision assistance; exclude universal Jev authority. |
| INT-010 | Know one complete, current source for the way of working. | Integrated `.workspace/config.yaml`; profile/README/AGENTS/tests derive from it. | E13, 2026-09-26/27; E14, 2026-09-30; N01 `authority`; G08. | N. | Historical ADR `accepted` and branch copies are not equal authorities. A loaded skill can still contain contradictory steering. | Retain intent. |
| INT-011 | Ask questions and inspect status without accidentally authorizing action. | Read-only status/tree surface; explicit proposal-and-choice flow. | E16, `2026-10-02T00:55:10Z`; E14 `03:21:25Z`; N01 `do_work.safety`; G03. | D/H/N. | Questions, desired outcomes, quoted assistant plans, and pasted commands do not by themselves authorize mutation. | Retain intent. |
| INT-012 | Allow authorized work to continue without repeated approval ceremony. | Historical autonomous-by-default Roadmap, then explicitly scoped autonomous mode. | E11, 2026-09-24/25; N01 `do_work.modes`; G07. | N requires an explicit autonomous scope. | Old default autonomy and local “proceed autonomously” instructions do not authorize all backlog work, external effects, or normative change. Status questions are not cancellation. | Retain intent; exclude autonomous-by-default/global interpretation. |
| INT-013 | Preserve control over consequential or unsafe changes while delegating routine execution. | Bounded deviation naming the affected rule; reserved external/cleanup/config authority. | N01 `authority.deviation`, `external_effects`, `reserved_authority`; G07. | N. | A historical blanket gate waiver cannot waive platform restrictions, credential safety, or ambiguous destructive targets; it is not a lasting norm. | Retain intent. |
| INT-014 | Avoid controls whose ceremony exceeds their risk or useful evidence. | Fresh review/E2E/ADR gates for every change, later proportional controls. | E14 `2026-10-01T03:35:36Z`; E06 `2026-09-26T08:43:48Z`; G07; N01 `accept_work.review`. | N; current proportionality supersedes universal historical gates. | Do not turn “no ceremony” into “no verification”; do not restore all old gates from ADR 0061's historical body. | Retain intent; exclude universal review/test/ADR mandates. |
| INT-015 | Understand who proposes, chooses, builds, reviews, and owns each result. | Project orchestrator/task owners, later operator/executor/implementer/reviewer roles. | E02 `14:49:42Z`; E06 `2026-09-26T08:31:44Z`; N01 `roles`. | N for current vocabulary; H for old topology. | Reusing controller/minion/MC names as authority can recreate overlap. Roles need not imply separate processes or agents. | Retain intent; reformulate with the current role contract. |
| INT-016 | Preserve why decisions changed without allowing old instructions to govern again. | Append-only ADR/spec/report history, supersession in new records, main-integrated config. | N01 `authority.records`, `knowledge`, `decision_records`; G08; G06. | N. | Old records can still say `accepted` after losing normative force. Editing history or cherry-picking its rule into a runtime is not reconciliation. | Retain intent. |

### 4.3 Intake, backlog, execution, and status

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-017 | Capture spontaneous ideas across active/dormant projects and independent research without losing them. | A low-cost personal idea-assistant relay feeding MC/Beads and carrying clarification back. | E04 `2026-09-19T16:31:20Z`. | H/Q: a concrete scenario and bounded requested role. | Pasted `WORK_RESULT` claims of assistant/session creation are not verified availability. Claude-only placement, MC implementation, or a new session is not intrinsic to the need. | Retain intent; mechanism and operational existence unknown. |
| INT-018 | Keep intake from silently deciding or changing active projects. | Relay-only intake, separated from orchestration; no project decisions in the assistant role. | E04 `16:31:20Z`; N01 `choose_work.changed_decision`. | H/N. | Historical MC/Jev priority decisions do not supersede current operator choice of objective. Recording an idea is not starting it. | Retain intent. |
| INT-019 | Have identifiable work records rather than untracked execution. | Beads backlog selected; earlier no-Bead/no-Herdr-dispatch contract. | E02 `2026-09-17T22:22:37Z`; R05 ADR 0019; N01 `define_work.beads`. | N for epic/task and kind labels; R for every-tab dispatch contract. | A service tab, copied message, or callback is not itself a ready task or accepted result. The Herdr-specific iron law is not current global topology. | Retain intent; exclude mandatory tab-per-Bead formulation. |
| INT-020 | Size tasks so each delivers a testable, independently acceptable result. | Bead-per-value increment; one-session executable tasks, optional grouping epics. | E09 `2026-09-23T00:34:00Z`; N01 `define_work.units`, `classification`. | N/H. | A task is classified by its accepted result, not Markdown/code format or tools. Research, experiment, documentation, implementation need different evidence. | Retain intent. |
| INT-021 | See the real backlog and priorities without hidden ranking, filtering, mutation, or invented readiness. | Rootline-style tree; full Roadmap; later literal recorded-priority stripped tree. | E11, 2026-09-24; E16, 2026-10-01/02; G03/G04. | D/R; current `roadmap` is read-only display, not an executor. | The October 1 desired ordering of bugs/experiments/operationalization/research/docs was not adopted here as a new score or rewritten Beads priority. | Retain intent; exclude inferred priority and implicit execution. |
| INT-022 | Know what has been accepted, what remains, and why it is blocked. | Beads status, task-oriented todos, progress evidence, dependency/blocker display. | E06 `08:31:44Z`, `08:43:48Z`; E16; N01 `track_work`. | N/H. | Closed-task counts, worker `DONE`, idle state, and commit counts are context, not acceptance or epic completion. | Retain intent. |
| INT-023 | Avoid impossible backlogs, circular dependencies, dead ends, or repeated “sanitized” claims without evidence. | Doctor/backfill, readiness audit, topological dependency validation. | E10 `2026-09-24T20:16:23Z`, `20:58:42Z`; E06 `06:56:23Z`; N01 `prepare_work`, `track_work.blockers`. | H/N for readiness; R for Doctor algorithms. | Automatically mutating missing fields or assigning inferred contracts is not authorized by an inspection. An empty visible list does not prove all work is complete. | Retain intent; exclude automatic corrective backfill. |
| INT-024 | Continue independent authorized work when one task is blocked, and explain the stop condition. | Loop failure transitions and “BACKLOG EMERGENCY”, later scoped autonomous skip/stop rules. | R06 ADRs 0052/0059; N01 `do_work.modes.autonomous`, `track_work.blockers`. | N for scoped continuation; emergency wording is historical only. | “Backlog not executable” is not completion; skipping an unavailable control or human decision is not permitted. | Retain intent; exclude mandatory emergency taxonomy. |
| INT-025 | Resume a task without double execution, false ownership, or reopening completed stages. | Leases/heartbeats, conditional close, later session fencing/CAS and checkpoints. | R06 ADRs 0033/0057; N01 `track_work.controller_identity`; E03 continuity question. | H/R; current config identifies `PI_SESSION_ID` but does not mandate the whole old fencing algorithm. | Neither a shared actor name nor a session ID alone proves exclusive lifecycle authority, durable recovery, or absence of duplicate external effects. | Retain intent; implementation satisfaction unknown. |
| INT-026 | Execute a chosen backlog/epic with consistent methods rather than require operator babysitting. | `/beads-loop` one-by-one Superpowers, todo projection, full Roadmap loop. | E07 `2026-09-23T21:17:21Z`; R06 ADRs 0032–0035/0044/0048; N01 `do_work.modes`. | H/N for execution need; legacy workflow is R, not current read-only Roadmap. | This historical request does not mandate roadmapctl, todos, or an unconditional Superpowers controller. Display and execution must remain different actions. | Retain intent; reformulate as bounded result execution. |

### 4.4 Context, interruption, knowledge, and learning

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-027 | Preserve commitments, steering, and results across disconnect, process interruption, and reopening. | Durable control store/mailbox, receipts, external daemon, task checkpoints. | E03; E19 proposed requirements, 2026-09-15; R02 ADR 0001. | H/R/Q; continuity need supported, complete portable contract not adopted. | Terminal input, process presence, callback submission, and runtime completion do not prove durable acknowledgement or operator acceptance. Host-restart durability is untested here. | Retain intent; exclude mandatory custom daemon/store. |
| INT-028 | Recover pertinent prior work without guessing, repeating investigations, or obeying stale history. | Backscroll preflight/project-first search, widening once, historical artifact pointers. | E04 `2026-09-19T14:55:31Z`; E08 `2026-09-24T15:16:49Z`; N01 `do_work.history`. | N/H. | Required unavailable sources stay unknown; episodic history does not override current sources/config. User-role text and copied sessions need provenance filtering. | Retain intent. |
| INT-029 | Keep useful context available while reducing token and attention cost. | Jev basic compaction, visibility Ladder, later query-aware retrieval, Evidence/recap. | E09 `2026-09-22T22:03:30Z`; E17 `2026-09-27T07:09:51Z`; R07 ADRs 0013/0022/0029. | H/R; efficiency question remains open. | Recap alone was explicitly not the product. A custom summary or token reduction is not proof that quality, decisions, cost, or retrieval improve. | Retain intent; mechanism/value remain evidence-dependent. |
| INT-030 | Suggest or run compaction only when there is genuinely compactable history. | Fixed 150K–200K thresholds, later model-relative threshold and conservative readiness. | E09 `2026-09-22T21:49:22Z`; E15 `2026-09-25T20:58:36Z`; R07 ADR 0055. | H/R for operational problem and correction record. | A small-session hint followed by “Nothing to compact” contradicts usability. Thresholds are model/runtime dependent; no universal token number is an intention. | Retain intent; exclude the fixed universal threshold. |
| INT-031 | Make a persisted setting work consistently across sessions without repeated opt-in ceremony. | Global config and `/ce-settings`; `trigger.mode=auto` as durable consent, replacing session acknowledgement. | E15 `2026-09-25T22:22:53Z`, `22:24:00Z`; R07 ADR 0056. | H/R; specific auto-mode semantics recorded. | Consent to compaction is not consent to every automatic rule, deployment, or external effect. Native settings fit is track 2's question. | Retain intent. |
| INT-032 | Respect interruption/abort and fail visibly instead of immediately repeating unsafe or unwanted context work. | Abort/deadline gates and custom compaction failure without native fallback; post-abort automatic guard. | E18 `2026-10-01T22:12:10Z`; G02. | H/R; fixed commit documents a bounded correction. | Reported tests do not prove all live abort/retry/concurrency paths now work. No invisible substitution should be inferred from “fallback disabled”. | Retain intent; verify operationally later. |
| INT-033 | Distinguish current instruction/state from superseded or historical material after compaction and retrieval. | Ladder chronology and current/superseded/historical/irrelevant classification. | G06; N01 `authority`, `history`; R07 ADR 0029. | N for precedence; R for projection mechanism. | Classifier confidence cannot make stale operational instructions current. Source order and present-checkout verification matter. | Retain intent. |
| INT-034 | Learn which interactions repeatedly cause ignored instructions, stress, rework, and similar outcomes. | Cross-session pattern research, Jev/other models, deterministic pattern discovery. | E08 `2026-09-23T23:48:56Z`, `23:50:39Z`, `2026-09-24T14:11:56Z`. | H/Q; requested objective directly evidenced. | A semantic PoC report was explicitly called unhelpful to the pattern objective. A new model/tool or classifier result is not a demonstrated improvement. | Retain intent; reformulate around incident/outcome evidence. |
| INT-035 | Turn verified lessons into durable guidance without new contradictory rules or accidental automatic authority. | Compaction RuleSignals/retro, conditional fragments via `before_agent_start`, deterministic rule compiler. | E05, 2026-09-18; R08 ADRs 0012/0024; E06 `2026-09-26T05:09:52Z`; N01 `improve_work.change`. | H/Q/R; current norm requires operator-approved change. | “Rules emitted” and “rules injected every turn” do not prove adoption, correctness, obedience, or immunity from compaction. Automatically activating mined rules would bypass current authority. | Reformulate as reviewable, sourced learning; exclude automatic normative activation. |
| INT-036 | Keep durable knowledge and execution evidence in understandable, queryable, appropriately scoped places. | Rootline documents, Bead-canonical evidence, sanitized artifact links and append-only records. | E12 `2026-09-25T14:32:54Z`; R06 ADR 0050; N01 `knowledge`, `accept_work.evidence`. | N. | Rootline is a document interface, not task lifecycle state. Raw transcripts/providers and duplicate execution reports are not durable evidence by default. | Retain intent. |

### 4.5 Delegation, concurrency, and attention

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-037 | Avoid silent idle/blocked work and get actionable requests/results to the right human or executor. | Attention tickets, peer callbacks, self-wake/heartbeat/reconciler, portfolio attention UI. | E02 `14:49:42Z`; R03 ADR 0010; E10 `2026-09-24T18:48:08Z`; R05 ADR 0015. | H/R; current blocker reporting is N. | A user-pasted reconciler health account describes ineffective cycles, not independently measured uptime/value. Polling cycles, exit zero, or callback `DONE` do not prove useful progression. | Retain intent; exclude mandatory polling/reconciler implementation. |
| INT-038 | Parallelize independent work and serialize actual dependencies. | Peer-tab fan-out, later subagent fan-out; separate parallel benchmark tasks. | E05 `2026-09-18T21:15:49Z` is propagated/attribution-sensitive; E14 `2026-09-30T18:17:48Z`, `20:01:13Z` independently requests fan-out. | H for desired concurrency; N permits ordering within authorized dependencies/scope. | Never parallelize by slogan: shared writers, dependencies, quota, and review independence can make serial execution correct. Historical peer-only and subagent-only topologies disagree. | Retain intent; reformulate as useful, safe concurrency. |
| INT-039 | Keep coordination focused while work is delegated when it actually helps. | “Always delegate”, orchestrator/minion separation, later explicit objection to globally mandatory delegation. | E06 `2026-09-26T08:25:47Z`; E14 `2026-10-01T15:40:53Z`; G07. | H; current roles allow executor and implementer to be the same. | The later operator correction identifies globally mandatory delegation as problematic when direct work is cheaper. Historical desire is not a current universal rule. | Reformulate; exclude unconditional delegation. |
| INT-040 | Obtain a genuinely fresh, complete review where the risk warrants it. | Fresh Superpowers reviewer, different family/provider preference, formerly specialist review stacks. | N01 `accept_work.review`; E06 `08:43:48Z`; G07; E18 `2026-10-02T14:27:58Z`. | N; preferred cross-family/provider when readily available, focused self-review fallback recorded. | Different naming/session alone does not prove independence. Docs-only work does not need a new reviewer by default; no stacking specialty reviews without need. | Retain intent. |
| INT-041 | Transfer enough context and result evidence without bloating the coordinating agent. | Thin orchestrator, bounded pointer/file handoffs, later canonical Bead comments/notes. | R05 ADR 0015; R06 ADRs 0043/0050; E04 intake overload scenario. | H/R; N requires evidence and blockers, not one fixed transport. | A pointer to an absent temporary file cannot satisfy durable evidence; a submitted result is not accepted delivery. | Retain intent; leave transport and storage mapping open. |

### 4.6 Models, providers, quota, security, and credentials

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-042 | Use available subscriptions/providers appropriately rather than stall or introduce another unwanted runtime. | Claude/Pi provider parity, Devin-as-provider, Pi headless for non-Anthropic models. | E20 `2026-09-25T13:25:52Z`, `14:12:58Z`; R09 ADRs 0018/0054. | H/Q; present research runtime is Pi. | No current account availability, quota, provider parity, or login success was established. Historical CLI prohibitions/provider policy are not current config by inference. | Retain intent; exact eligible providers unknown. |
| INT-043 | Know the actual model/provider route before reacting to quota or reporting identity. | Runtime self-check, current route reporting, effective/requested attempt receipts. | E05 `2026-09-18T22:08:51Z` is propagated/attribution-sensitive; R09 ADR 0054; E20 quota problem. | R/H; no live-route test here. | Quota broadcasts can be stale or concern a different route. Model names in plans do not prove what executed. | Retain intent; mechanism satisfaction unknown. |
| INT-044 | Recover from quota/network/provider failure without repeating paid work or duplicating effects. | Sequential logical role groups/fallbacks; preserving task/prompt/tools/cwd and pre-output/pre-tool fallback boundary. | E20 `2026-09-25T13:25:52Z`; R09 ADR 0054; N01 `external_effects`. | H/Q/R; resilience is supported, fallback implementation not established. | A group proposal is not a working retry system. Retrying after output/tools/external effects can duplicate work; independent reviewer routing must remain real. | Retain intent; exclude blind/global fallback. |
| INT-045 | Choose models/topologies from fair, relevant evidence, including cost and real results. | Model matrix, same fixtures, Pi-headless evaluation; altitude/cost/router/Jev decisions. | E21 `2026-09-22T05:36:35Z`, `15:38:21Z`; E22; R09 ADRs 0017/0018. | H/Q; no model winner adopted here. | A hypothetical “ideal matrix ignoring data restrictions” is not approval to send sensitive data or change provider routes. Benchmarking default Pi did not require persistent subagent-config changes. | Retain intent. |
| INT-046 | Avoid duplicated provider authentication, transport, and private integration maintenance. | Canonical `@a4s/typesafe` package, later Pi-native Jev runtime and native credential resolution. | R10 ADRs 0020/0065; G05; N01 `do_work.credentials`. | N for credential policy; R for package/runtime correction. | Retaining the removed private client by inertia conflicts with the recorded native integration. This research does not verify public Pi capability or global installed version. | Retain intent; exclude duplicate private provider as a preservation requirement. |
| INT-047 | Keep credentials usable for authorized operations without exposing plaintext in repository or evidence. | TypeSafe through Pi native provider; other services SOPS ciphertext, private age identity outside repo. | E13 `2026-09-28T05:23:31Z`; N01 `do_work.credentials`; G09. | N/H. | No secrets, callbacks, access tokens, or auth-file contents are included or tested. Missing encrypted source/identity blocks credential-dependent action. | Retain intent. |
| INT-048 | Respect data sensitivity when selecting remote providers and publishing reusable artifacts. | Sensitivity classes and hard provider eligibility; public-repository hardening. | E21 `2026-09-22T13:14:26Z`, `13:16:56Z`; R09 ADR 0027; E23; N01 `credentials`, `safety`. | H/Q/R; credential safety is N. | Data-class routing is outside current WoW; its historical classes/model list are not a current runtime policy. Removing data restrictions for a comparison is not live permission. | Retain safety intent; exact routing policy unknown. |
| INT-049 | Make failure/retry boundaries explicit and reproducible before another live attempt. | Structured provider categories, cooldowns, failing-test reproduction, renewed live authorization. | R09 ADR 0054; N01 `external_effects`, `do_work.investigation`; G02. | N for live mutation retry controls. | The same failed action without a cause or changed condition is not recovery. A success claim from a generated dispatcher is not sufficient observation. | Retain intent. |

### 4.7 Delivery, quality, cost, and value

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-050 | Measure value by useful accepted outcomes, not visible activity. | Delivery-efficiency report by durable production change instead of cost/session or raw commits. | E22 `2026-09-21T20:37:43Z`, `21:50:06Z`; R11 ADR 0036; E01 `02:01:59Z`; N01 `purpose`, `track_work.progress`. | H/N for outcome emphasis; specific efficiency metric is R, outside current WoW. | User characterization of commits/docs/tests as “humo” is dissatisfaction evidence, not proof that every historical change was worthless. Git counts cannot verify or refute delivered value. | Retain intent; exclude activity-count success proxies. |
| INT-051 | Demonstrate changed behavior through its real representative entry point. | E2E per Bead/product, Pi-headless tests/manual checks, later proportional runtime E2E. | E24, 2026-09-22; E18 `2026-10-02T01:14:45Z`; N01 `accept_work.end_to_end`; G07. | N; changed executable paths require safe representative E2E when available. | A green structural/unit test, mock host, or CI job is not the consuming-runtime behavior. No universal root E0 suite is required for every task. | Retain intent; exclude blanket E2E per artifact. |
| INT-052 | Validate research and documents against sources without inventing unnecessary software tests. | Source validation, Rootline, diff review, kind-specific acceptance. | E13 `2026-09-26T19:29:56Z`, `2026-09-28T05:50:13Z`; N01 `accept_work.kind_checks`; G07. | N/H. | Documentation/research is not implementation merely because it changes Markdown. No model or container execution is necessary for this research artifact. | Retain intent. |
| INT-053 | Prove a material unknown cheaply before expensive operationalization, without ritual experiments for known paths. | PoC-first happy path, then reusable/idempotent tested code; later smallest direct implementation. | E12 `2026-09-25T13:18:14Z`; N01 `prepare_work.new_capability`, `design`; G07. | H/N, with an internal config tension noted in section 5. | `do_work.investigation` still mentions a separate PoC task required for new capability, unlike `prepare_work.new_capability`. This inventory cannot silently repair or choose the policy. | Retain intent; reformulate around uncertainty; universal separate PoC remains unresolved. |
| INT-054 | Deliver integrated task results promptly without bypassing quality/security gates. | PR-per-task, supervised autonomous merges, exact-head checks, historical billing override. | E11; E10 `2026-09-24T20:40:57Z`; N01 `deliver_work`; G07. | N; PR delivery and current applicable controls govern. | Old direct-main fallback and expired billing exception are not current norms. Missing required remote CI leaves delivery pending unless a bounded explicit deviation is authorized. | Retain intent; exclude obsolete automatic exceptions/direct-main fallback. |
| INT-055 | Close only when the actual reviewed candidate is integrated and stable main is synchronized/clean. | Explicit fetch/pull and identity checks, not a local commit or worker completion. | E25 `2026-09-26T04:40:08Z`; N01 `deliver_work.close`; R12 ADR 0058. | N/H. | A rebased SHA may reuse equivalent-patch evidence under current config, but a changed relevant diff/dependency needs fresh evidence. Closure is not runtime turn completion. | Retain intent. |
| INT-056 | Retain enough sanitized, reproducible evidence without accumulating raw transcripts and disposable artifacts. | Bead evidence with versioned links; durable/disposable/retained-local classification. | N01 `prepare_work.shared_readiness`, `accept_work.evidence`, `deliver_work.close`; R06 ADR 0050. | N. | Explicit retention cannot be removed as “temporary”. A missing raw log is not missing durable evidence if agreed sanitized results/provenance suffice. | Retain intent. |
| INT-057 | Remove orphaned task resources safely without losing work or making inactive automation look productive. | Sweep/worktree cleanup, Herdr tab teardown/reaper, reconciler decommission. | E10, 2026-09-24; E26, 2026-09-02; R12 ADR 0063; N01 `improve_work.cleanup`. | N for exact bounded post-merge cleanup; old global sweeps are H. | A name/text match is never destructive authorization. Worktree, branch, integrated head, retained output, and ownership must be verified; tab/job cleanup is not identical to task cleanup. | Retain intent; exclude unbounded automatic sweep. |
| INT-058 | Spend CI time and provider quota only on relevant verification. | Hosted-matrix reduction, Linux skill checks, evaluation of edge/Buildkite delegation. | E27 `2026-09-29T19:50:51Z`, `21:02:40Z`; G01/G07 record boundaries. | H/Q; exact hosting solution not chosen here. | Questions about delegating CI do not mean Buildkite was adopted. Native Pi declarations in CI, fake contracts, real Pi E2E, and model evaluations are different checks. | Retain intent; hosting/runtime-test allocation unknown. |
| INT-059 | Execute tests in an explicitly isolated image rather than merely start an image and test outside it. | Proposed additional Pi package starts the image and runs Pi tests inside it. | E01 `2026-10-02T18:48:10Z`, clarified `20:07:17Z`. | D/Q; precise proposed means, not implemented. | Image contents, mounting/access, test scope, actual Pi under test, credentials/network, containment, cleanup, and acceptance were not established. A package name or launcher would not prove containment. | Retain testing/containment intent; package adoption unknown. |

### 4.8 Usability, reusability, and way-of-working evolution

| ID | Observable operator need | Historical proposed mechanism | Evidence/date | Currentness and authority | Conflict or uncertainty | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| INT-060 | Configure capabilities through a consistent native experience rather than proliferating special commands/UIs. | Pi-native settings style for Context Expert and Tool rows; removal of redundant `/tool-rows`. | E09 `2026-09-22T21:49:22Z`; E18 `2026-10-02T18:35:32Z`; G01. | H/D/R. | A staged package can be integrated but unavailable in the published runtime. The native ports/activation proof belong to track 2, not a claim from a settings mock. | Retain intent; exclude redundant custom surface by default. |
| INT-061 | Reduce transcript/tool noise while preserving useful visibility and user choice. | Tool-row full/compact/hidden modes, summary density and keyboard toggle. | E28 `2026-09-24T14:10:29Z`; E18; G01. | H/R; the baseline calls the package a staged candidate. | Hiding presentation is not deleting history, suppressing evidence, or proving access control. Exact runtime availability is not established by this inventory. | Retain intent. |
| INT-062 | See human work descriptions and task-level progress, not opaque IDs or one todo per subagent. | Description-first Bead decisions with ID/Result/Scope; task-oriented todos; display specialization. | E06 `08:31:44Z`, `08:43:48Z`; E14 `2026-09-30T02:17:57Z`, `03:21:25Z`; N01 `choose_work.backlog_decisions`. | N/H. | A missing field is shown missing/unknown, not inferred or backfilled. Changing presentation does not change the Bead contract or readiness. | Retain intent. |
| INT-063 | Let a new developer understand purpose, roles, task kinds, and flow directly and logically. | Human-readable config/WoW; conceptual reference distinct from project policy. | E13 `2026-09-26T18:16:47Z`, `18:19:01Z`, `18:23:25Z`, `2026-09-28T05:50:13Z`; N01. | H/N for clear authority and explicit definitions. | Jargon such as unspecified phase, agent, source, or history loses the new developer. A command catalog or speculative “could” prose is not an operating model. | Retain intent. |
| INT-064 | Reuse a small, maintainable mechanism across repositories without imposing one repository's policy everywhere. | Repository-agnostic skills reading local config, self-contained skills, external providers consumed without forks. | E06 `2026-09-26T05:36:19Z`; R13 ADRs 0059/0060; N01 `product`. | N/R. | Reusability does not authorize wholesale vendoring, migration, private imports, or generic workflow gates. The current read-only Roadmap has less scope than its historical recipe. | Retain intent. |
| INT-065 | Know which source/runtime/configuration was tested and consumed. | Released-tag skill activation, runtime minimum and public peer dependencies, later repo-local/released consumption. | E12 `2026-09-25T16:09:17Z`; R14 ADR 0062; G05/G07; N01 `deliver_work.cadence`. | N for permitted consumption; R/H for release/version proposals. | Current config does not require user-global installation or frozen tags for all use. A development lockfile, global runtime, local modified Pi, and published package can be different artifacts. | Retain intent; exclude compulsory global installation. |
| INT-066 | Bootstrap/upgrade another repository knowingly and detect stale operating configuration. | Proposed `roadmap init` distinct from plan, numeric Roadmap/workspace version references, Doctor/upgrade. | E12 `2026-09-25T16:05:20Z`, `16:09:17Z`. | H/Q; an explored capability with a clarified distinction. | No present `roadmap init` command, delivery, or authority to rewrite other repositories is established. It must not be conflated with the read-only `roadmap`. | Retain visibility need; bootstrap implementation/adoption unknown. |
| INT-067 | Improve the way of working from observed failures without endless rules or unsolicited new work. | Cross-session RCA, positive-rule wording research, adaptive process review, bounded normative proposals. | E06 `2026-09-26T05:09:52Z`, `08:38:18Z`; E14 `2026-10-01T03:35:36Z`; N01 `improve_work`; G07. | N/H. | “Always Y is better than never X” was a question/hypothesis, not a proved universal rule. A finding is evidence, not automatic new scope/Bead or a mandatory interruption after every task. | Retain intent; exclude rule proliferation and automatic task creation. |
| INT-068 | Receive a concise, factual answer at the requested level while retaining the full evidence when needed. | Short status/description-first summaries and separate durable research; read-only RCA before fixes. | E05 `2026-09-19T02:12:48Z`; E06 `2026-09-26T05:49:49Z`; E16 `00:55:10Z`; E01 research request. | H/D; exhaustive artifacts and concise chat are compatible. | Requests for less ceremony do not justify skipping a requested investigation; an exhaustive document is not permission for unsolicited action menus or implementation. | Retain intent. |

## 5. Conflicts, exclusions, and non-adoption ledger

This ledger prevents mechanisms from re-entering the Pi mapping disguised as immutable operator requirements.

| Historical formulation or claim | Primary comparison | Research treatment |
| --- | --- | --- |
| Every decision must be taken by Jev after at least three expanding-context iterations. | E04 is an actual historical request; N01 assigns result choice/reserved authority to the operator and requires explicit normative approval. | Keep decision assistance and reduced bottleneck as the need. Exclude universal Jev authority; no confidence score is authorization. |
| Peer-only tabs, no Pi subagents; later all work must use subagents; later always delegate/fan-out. | R05 ADR 0014, R06 ADR 0043, E06/E14, and N01's proportional roles. | Record the chronology and contradictory means. Preserve safe concurrency and clear ownership; no mandatory topology. Several September 18 “owner” notices are propagated texts, not independent human confirmation. |
| Roadmap plans, audits, repairs, prioritizes, executes, controls readiness, and owns repository WoW. | R06/R13 describe historical full Roadmap; G03/G04 separate the legacy workflow from current read-only tree; N01 is sole WoW authority. | Do not map the old full skill as a required runtime component. Display, proposal, data repair, and execution are different authorized actions. |
| Rules can be mined, emitted, and injected automatically, and thus become durable policy. | E05's proposals and R08; N01 `authority`, `improve_work.change`. | Extraction can produce candidates. Current policy adoption is explicitly human-approved; injection is not proof of obedience or approved norm. |
| Every capability always needs a separate PoC task. | E12's historical PoC-first preference; G07 explicitly removes a mandatory separate experiment; N01 `prepare_work.new_capability` versus `do_work.investigation`'s remaining sentence. | **Unresolved internal config tension.** Do not resolve silently or use the old sentence to impose ritual PoCs. State the material unknown and obtain a bounded policy clarification if this affects later work. |
| Every task/artifact needs software E2E, a different-provider reviewer, repeated specialist reviews, and fresh evidence after any SHA change. | G07 and N01 `kind_checks`, `end_to_end`, `review`, `deliver_work.merge`. | Exclude universal gates. Preserve source review for research/docs, representative E2E for changed executable behavior, risk-based independent review, and current equivalent-patch reuse rules. |
| Old billing override allows absent/red remote CI or direct push to main indefinitely. | Historical E10/R06 ADR 0046; G07 removes the exception; N01 requires pending delivery when required CI cannot run. | Exclude as current implicit authorization. Historical successful integration under an exception does not create a new one. |
| Related projects should be ingested/migrated to complete A4S. | E02 explicitly rejects migration; R04 lists references only; N01 `product.providers`. | Exclude wholesale migration. Earlier extension-specific ingestion ADRs are history, not general permission. |
| A new repository, clean Pi boot, cutover sequence, or exact cutover date has already been agreed. | E01 `2026-10-02T15:19:48Z` quotes a long assistant sequence and asks about repository location; a nearby correction says the preceding statement was a question. | The quoted five-step sequence is **assistant-origin proposal, not an adopted plan**. Explicit Pi selection is established; the whole cutover sequence, repository replacement, deletion, and timing are not. |
| A custom Tool rows slash command is necessary for the feature. | E18 quotes the assistant's explanation and explicitly requests its removal; G01 describes the settings-only staged candidate. | Assistant-origin convenience/compatibility rationale did not make it a requirement. The user corrected it; keep native presentation control need. |
| A fork of Pi Subagents is required for fallback/resilience. | R13 ADR 0060 records an operator correction rejecting maintained fork/vendoring/source changes. | Exclude the maintenance assumption. Retain resilient authorized execution; do not claim installed fallback exists. |
| A launched assistant/session, created Bead, merged PR, green CI, clean process exit, or passing fixture proves useful operational capability. | E04 pasted `WORK_RESULT`, E10's user-pasted reconciler account, G01 staged-unavailable package, N01 `purpose.outcome`/`accept_work`. | Such records prove at most their stated observations or changed artifacts. They do not establish live activation, reliable end-to-end behavior, operator acceptance, or durable value. |
| The proposed Pi image-test package exists or was selected as the cutover architecture. | E01 `18:48:10Z` proposes; `20:07:17Z` clarifies tests inside image and requests two researches. | Record proposal only. No package, image, test run, security boundary, or architecture was created/approved by this research. |

### Assistant-origin versus operator-origin distinctions

Explicitly identifiable assistant-origin material includes the quoted five-step cutover plan in E01, the “Roadmap owns backlog/plugin only moves messages” recommendation questioned in E06, the `/tool-rows` convenience rationale quoted/corrected in E18, and pasted `WORK_RESULT`/consolidation reports. Their placement inside `role=user` does not turn them into the human's decisions.

Conversely, universal Jev, always-delegate, broad fan-out, and per-Bead E2E have direct historical human requests. They must **not** be dismissed as purely assistant inventions; their limitations come from later correction/current authority and lack of operational proof. Claims such as “all context injection is immune to compaction” and speculative source-maintenance plans have record evidence, but this investigation cannot reliably attribute their original authorship. They remain record claims, not authenticated operator decisions.

## 6. Evidence index

### 6.1 Individually checked historical message locators

Session IDs are stable source identifiers; Backscroll sometimes emits an empty `SessionID`, so these IDs were taken from source filenames. No private source-file paths or full transcripts are needed in the report. A locator combines the session UUID, UTC timestamp, and search term. Quoted text below is a short source cue, not an executable instruction.

| Ref | Session ID | Checked UTC timestamp(s) and source cue |
| --- | --- | --- |
| E01 | `01a0fa54-87af-72f0-8eb2-8808a6f558c2` | 2026-10-02: `01:57:21Z` cutover idea; `02:01:59Z` no harness preservation/value; `02:03:47Z` intentions/atomic functions; `03:08:50Z` follow Handbook; `03:13:26Z` exclude inconsistent intentions, useful versus noisy components; `14:40:36Z` Pi not Codex; `15:19:48Z` quoted assistant plan plus repository question; `15:18:03Z` preceding statement was a question; `18:41:59Z` isolated Pi question; `18:48:10Z` image-test package proposal; `20:07:17Z` tests inside image and two research documents. |
| E02 | `01a0aafa-305e-7268-80c6-14d6600c8f4f` | 2026-09-17: `13:40:19Z` non-agent dashboard exploration; `14:49:42Z` many-project fatigue/one attention UI/project-task ownership; `16:14:57Z` workspace execution config; `19:04:08Z` many past projects for recurring pains; `19:30:57Z` no related-project migration, DRY/KISS/PoC-first; `22:22:37Z` use Beads backlog. |
| E03 | `01a0aad0-8cc8-70e8-9bf4-e884f5dc29ea`; `01a0aad1-eceb-70e8-9bf4-e8860c9e105d`; E02 | 2026-09-16 `15:24:25Z` / `15:24:54Z`: minimal ledger/resurfacing question. E02 2026-09-16 `16:10:09Z` Agentpack versus Beads research; 2026-09-17 `15:37:24Z` preference for Beads and empirical increments. |
| E04 | `103c1291-e597-4694-9616-7334624ff568` | 2026-09-19: `12:43:00Z` Jev with more context; `14:55:31Z` Backscroll/recover prior contract; `15:18:17Z` all-decisions/Jev/three iterations; `15:28:41Z` Jev then irreconcilable human fallback; `16:31:20Z` spontaneous-idea relay scenario; `23:48:29Z` cannot see idea-assistant. Pasted `17:24:16Z` / `23:50:47Z` results were not treated as adoption/delivery proof. |
| E05 | `01a0b4b0-f872-7268-80c6-153dc8d5e15b` | 2026-09-18 `14:24:22Z` compaction/retro proposal, `15:18:51Z` deterministic-rule research, `20:09:13Z` native TypeSafe login question. `21:15:49Z` fan-out and `22:08:51Z` self-route notices are attribution-sensitive propagated records. 2026-09-19 `02:12:48Z` concise answer request. Repeated fork copies do not add evidence weight. |
| E06 | `fd519123-357d-4de7-b6ac-ac85c78dc75d` | 2026-09-26: `05:09:52Z` stop defining rules to fix rules; `05:36:19Z` repo-local WoW/reusable skill; `05:49:49Z` simple verifiable action/no endless tests; `06:56:23Z` distrust of repeated cleanup/ownership assurances; `08:25:47Z` always-delegate historical wish; `08:31:44Z` role vocabulary/task descriptions; `08:38:18Z` inefficient steering; `08:43:48Z` task-level todos, config authority, reduce reviewer rigor. |
| E07 | `01a0d01f-c3a4-721e-bc19-adb4cde2be11` | `2026-09-23T21:17:21Z`: execute whole Beads backlog one by one with applicable Superpowers, without roadmapctl; `21:17:47Z` consult Homeserver context. |
| E08 | `01a0d0a9-497c-76ea-8deb-6c311475aca5` | 2026-09-23 `23:48:56Z`, `23:50:39Z`: interaction patterns/ignored instructions/user stress. 2026-09-24 `14:04:16Z` Jev decision-support exploration, `14:11:56Z` PoC report lacks pattern utility, `15:16:49Z` research gaps rather than replace Backscroll. |
| E09 | `01a0cb0a-5fae-70de-ab6c-0ec7814a79e9` | 2026-09-22 `21:49:22Z` Pi settings style and unready compaction bug; `22:03:30Z` recap is not principal product. 2026-09-23 `00:34:00Z` each Bead delivers value/is testable. |
| E10 | `654b2712-8ba1-4ff1-aa7f-79be416c3e3c`; `01a0d4be-e764-7547-92a6-e2dcefadab35` | 2026-09-24: first session `19:57:03Z` full backlog, `20:16:23Z` dead ends/cycles, `20:40:57Z` asks explicit CI override handling, `20:58:42Z` preserve consistency checks. Second session `18:48:08Z` user-pasted ineffective reconciler account/decommission request, not an independently repeated measurement. |
| E11 | `73fb118e-cb3e-417b-98a7-709d4ff37092` | 2026-09-24 `21:07:43Z`, `21:09:52Z`: tree/blockers; `22:01:21Z` default autonomy wish; `22:10:52Z` approved bounded autonomous merge. 2026-09-25 `01:36:11Z` requested continued autonomy. |
| E12 | `01a0d94c-7def-7744-b3d1-875713cd6d0e` | 2026-09-25 `13:18:14Z` empirical happy path then operationalization; `14:32:54Z` workspace location, quoted contrary assistant answer; `16:05:20Z` init versus plan distinction; `16:09:17Z` numeric version visibility for upgrades. |
| E13 | `01a0dee6-a727-76f7-8dbc-c0db8f9c287e` | 2026-09-26 `18:16:47Z`, `18:19:01Z`, `18:23:25Z`: new-developer logical explanation/config; `19:29:56Z` need → investigation → options → choice, kinds. 2026-09-27 `06:42:15Z` operator chooses investigated result. 2026-09-28 `05:23:31Z` native TypeSafe + SOPS/age; `05:50:13Z` research versus experiment/positive human-readable rules. |
| E14 | `01a0eff9-87f6-7144-879e-14f138289cb5` | 2026-09-30 `02:17:57Z` descriptions, not opaque IDs; `03:21:25Z` presentation does not change Bead contracts; `03:28:23Z` specialization over config; `18:17:48Z` / `20:01:13Z` fan-out where possible. 2026-10-01 `03:35:36Z` hours/ceremony for three documents and asks investigation; `14:19:42Z` what global steering remains; `15:40:53Z` mandatory delegation can be costlier than direct work. |
| E15 | `01a0da5c-57c8-7034-b6d3-1bc33928ea66` | 2026-09-25 `20:58:36Z` compact hints before possible; `21:29:37Z` model changes; `22:22:53Z` duplicate acknowledgement command question; `22:24:00Z` persisted setting should stay effective. |
| E16 | `01a0f970-3384-7637-a069-3e4fcf8b97a6` | 2026-10-01 `21:48:00Z` backlog question. 2026-10-02 `00:48:10Z` investigate necessity and desired operational ordering; `00:54:33Z` stripped priority-only tree; `00:55:10Z` a question requests informed answer, not action; `01:03:43Z` rename old skill legacy; `01:16:56Z` answer only, do not act now. |
| E17 | `01a0e1ab-606e-7495-b449-7a9628dfc094` | `2026-09-27T07:09:51Z`: measure whether automatic compaction truly optimizes token use and whether compaction itself should improve. |
| E18 | `01a0f985-4a4c-7414-81d9-bc21c84e46a1` | 2026-10-01 `22:12:10Z` aborted compaction/native fallback disabled report. 2026-10-02 `01:14:45Z` real E2E before CI; `14:27:58Z` different model/provider review question; `18:35:32Z` explicit merge/removal instruction with quoted assistant convenience rationale. |
| E19 | `01a0a702-e083-734e-ad50-c3beb91a6c92` | `2026-09-15T21:39:56Z`: “evalua si esto podria ser parte de a4s” plus **proposed** portable durable orchestration requirements. Its own text requires explicit consuming-repo adoption. Evaluation is not adoption. |
| E20 | `01a0d8ba-c223-7606-a909-d34b94bc6d08` | 2026-09-25 `13:25:52Z`: quota failures, logical fallback groups, Pi-headless provider proposal, recurring provider-access failure; `14:12:58Z` use subscriptions/fork correction exploration. |
| E21 | `01a0c763-c38b-7177-b50d-254b8fcf04c0` | 2026-09-22 `05:21:32Z` do not edit subagents config, run headless model evaluations; `05:36:35Z` same fixtures; `13:14:26Z` data eligibility question; `13:16:56Z` hypothetical ideal matrix; `15:38:21Z` default-model benchmark need not use subagents. |
| E22 | `01a0c737-d5ad-70ea-8fe4-6d0753625d1a`; `01a0d0a0-0281-7764-ab47-0361bf286dbe` | First: 2026-09-21 `20:18:51Z` cost/value; `20:37:43Z` commits/PRs not necessarily useful; `21:50:06Z` questions commit as unit. Second: 2026-09-24 `00:04:12Z` cost-per-session/token comparisons challenged. No quoted cost table was accepted as a causal model. |
| E23 | `01a0ed6b-69ec-74cf-83e2-8d633c9fb61d` | 2026-09-29 `13:48:49Z` harden configuration for publication; `14:27:35Z` what remains to make public; `23:29:30Z` inspect worktree work against backlog. |
| E24 | `01a0c739-9805-7322-85a5-d4e629d22309` | 2026-09-22 `05:11:25Z`, `05:13:01Z`, `05:21:13Z`: per-Bead real/headless E2E historical wishes; `19:30:15Z` incremental/manual verification. |
| E25 | `01a0db67-6e9f-721d-be6e-a07f79e7dfa7` | `2026-09-26T04:40:08Z`: explicit fetch/pull of main must be closure gate. |
| E26 | `01a0631e-6859-7ae0-8110-88047ae3702f` | `2026-09-02T17:41:46Z`: isolated worktree, no unresolved work left on main. |
| E27 | `01a0ed91-12b9-7190-a88a-33d4ee899d16` | 2026-09-29 `14:29:13Z` edge CI evaluation, `19:50:51Z` consumed GitHub quota, `19:57:05Z` Buildkite question, `21:02:40Z` no macOS/Windows/model tests needed merely to test a skill. |
| E28 | `01a0d3c0-5a7d-7732-9f11-587289ed6543` | `2026-09-24T14:10:29Z`: turn tool-call presentation on/off, native setting versus extension question. |

### 6.2 Normative, fixed-record, and Git evidence

`N01` is the complete baseline `.workspace/config.yaml`. `R` references below are **historical records at the same fixed baseline**, regardless of their frontmatter `estado`. All file paths in this section are repository-relative reproducible source locators, not private transcript paths. Use `git show <fixed-SHA>:<path>`; line numbers can be recovered from that exact blob.

| Ref | Fixed source paths or IDs at baseline |
| --- | --- |
| N01 | `.workspace/config.yaml` at `494a7ffe1b8e91dd3416986a2353cd6af7e366eb`, blob `5e3ca645e0f8e1a8db90e4f6ffc88e7adac24c92`. |
| R01 | `.workspace/docs/adr/0011-consolidar-configuracion-y-runtime-en-a4s.md`; `.workspace/docs/adr/0021-adoptar-monorepo-incremental-para-outer-harnesses.md`. |
| R02 | `.workspace/docs/adr/0001-a4s-north-star.md`; `.workspace/docs/adr/0009-evaluar-runtime-externo-antes-de-construir-control-plane.md`. |
| R03 | `.workspace/docs/adr/0010-adoptar-mission-control-y-orquestadores-por-proyecto-en-v0-9.md`. |
| R04 | `.workspace/docs/references/related-projects.md`. |
| R05 | `.workspace/docs/adr/0014-adoptar-topologia-de-dispatch-por-tabs-peer.md`; `0015-mantener-orquestador-delgado-con-handoffs-por-puntero.md`; `0019-exigir-bead-antes-de-dispatch-herdr.md` in the same ADR directory. |
| R06 | `.workspace/docs/adr/0032-beads-loop-adapter.md`; `0033-cierre-condicional-beads-loop.md`; `0034-beads-loop-autonomous-skill-routing.md`; `0035-beads-todo-loop-deterministic-projection.md`; `0043-adoptar-subagentes-superpowers-como-topologia-general.md`; `0044-unificar-planificacion-y-ejecucion-en-roadmap.md`; `0046-permitir-merge-de-pr-sin-ci-mientras-actions-este-bloqueado.md`; `0048-roadmap-skill-autonomous-loop.md`; `0050-hacer-del-bead-el-registro-canonico-de-evidencia-roadmap.md`; `0052-tratar-backlog-pendiente-no-ejecutable-como-emergencia.md`; `0057-reemplazar-leases-roadmap-por-fencing-de-sesion.md`; `0059-separar-mecanismo-roadmap-de-forma-de-trabajo-por-repositorio.md` in the same ADR directory. |
| R07 | `.workspace/docs/adr/0013-usar-jev-como-autoridad-de-compaction-semantica.md`; `0016-compactar-contexto-con-jev-desde-150k-200k.md`; `0022-extender-compaction-a-visibility-ladder-de-cuatro-niveles.md`; `0029-reemplazar-ladder-por-retrieval-query.md`; `0055-usar-umbral-relativo-y-readiness-conservadora-para-compaction.md`; `0056-tratar-auto-persistido-como-consentimiento-durable.md` in the same ADR directory. |
| R08 | `.workspace/docs/adr/0012-alojar-rule-compiler-como-extension-pi-en-a4s.md`; `.workspace/docs/adr/0024-aplicar-reglas-como-fragmentos-condicionales-via-before-agent-start.md`. |
| R09 | `.workspace/docs/adr/0017-enrutar-modelos-por-altitud-de-tarea.md`; `0018-enrutar-altitud-dentro-de-claude-y-pi.md`; `0027-enrutar-por-sensibilidad-de-datos-en-auto-router-nativo.md`; `0054-definir-rutas-logicas-secuenciales-por-rol.md` in the same ADR directory. |
| R10 | `.workspace/docs/adr/0020-canonizar-superficie-typesafe-en-paquete-a4s.md`; `.workspace/docs/adr/0065-usar-clasificador-typesafe-nativo-de-pi.md`. |
| R11 | `.workspace/docs/adr/0036-medir-eficiencia-por-cambio-durable.md`. |
| R12 | `.workspace/docs/adr/0058-exigir-fetch-y-pull-explicitos-al-cerrar-entregas.md`; `.workspace/docs/adr/0063-exigir-cleanup-post-merge-de-tasks.md`. |
| R13 | `.workspace/docs/adr/0059-separar-mecanismo-roadmap-de-forma-de-trabajo-por-repositorio.md`; `.workspace/docs/adr/0060-consumir-pi-subagents-sin-fork.md`. |
| R14 | `.workspace/docs/adr/0062-establecer-pi-0-99-1-como-runtime-minimo.md`. |

| Ref | Full commit SHA and relevant files | What the inspected artifact supports, not an acceptance claim |
| --- | --- | --- |
| G01 | `494a7ffe1b8e91dd3416986a2353cd6af7e366eb`; `packages/pi-tool-row-presentation/README.md`, `src/index.ts`, `package.json`, root `package.json`. | Settings-only staged candidate; fake/public-contract checks and a published-runtime activation boundary explicitly distinguished. The commit says unavailable for activation with published Pi 1.0.0. |
| G02 | `7039cf36426712fc238d0cc5cbb10e44bf11a5fc`; `packages/pi-context-expert/src/extension.ts`, `test/extension.test.ts`. | Post-abort automatic compaction guard and concurrent-settlement correction; stated bounded verification, not all possible live-path acceptance. |
| G03 | `84334dd04be504078c3db19cb853ce66d70068ee`; `skills/roadmap/SKILL.md`, `skills/roadmap/scripts/tree.py`. | A literal read-only priority tree, not plan/repair/loop authority. |
| G04 | `0105aca92597c306b2dea0ed67f72fbc27be9f76`; `skills/roadmap-legacy/SKILL.md`, README/profile references. | Old full workflow renamed legacy, not deleted or automatically used by the new tree. |
| G05 | `1941c69a6811fcd8164603b6573336a46c934299`; `.workspace/docs/adr/0065-usar-clasificador-typesafe-nativo-de-pi.md`, Context Expert/provider dependency changes. | Native Jev integration decision/correction, removal of duplicate private TypeSafe runtime, historical artifact compatibility; global installed Pi deliberately separate. |
| G06 | `397b46d26c39310de545e73a8dc46420ae344eac`; `packages/pi-context-expert/src/ladder.ts`, `src/questions.ts`, relevant tests/README. | Chronology/temporal-authority correction with bounded test claims; not default Ladder activation or a global authority model. |
| G07 | `cb51f6b82bdaa3aeedafe01676d62c4fcc43f6a2`; `.workspace/config.yaml`, derived profile/communication/contracts. | Proportional controls; no mandatory separate experiment per capability; no universal reviewer or obsolete billing exception; scoped process findings and repo-local skill use. |
| G08 | `ec66879cf60e09a012badd410bc14b430bf8259f`; `.workspace/config.yaml`, `.workspace/docs/adr/0061-hacer-de-config-la-autoridad-canonica-del-wow.md`. | Config-only normative authority and record/mechanism distinction. The old ADR body is not the October 2 policy. |
| G09 | `37e7d402bdb61695c39efb1ae48cd72490cc8f9b`; `.github/SECURITY.md`, `.github/publication/README.md`, `.github/publication/desired-state.json`, `test/test_publication_security.py`. | Repository hardening preparation; no claim that all history/accounts are currently safe or that publication was authorized by this research. |

`W01`: [Harness Handbook](https://ruhan-wang.github.io/Harness-Handbook/), checked 2026-10-02. Its overview presents behavior-centered system/unit/detail layers tied to code evidence and emphasizes tracing triggers, state, permissions, failure/bypass paths, and dependencies. This supports the **research method**, not Pi behavior, an A4S architecture, or the need for a new control plane.

### 6.3 Reproducible Backscroll queries and coverage ledger

Preflight and population:

```sh
/Users/pones/.local/bin/backscroll status
/Users/pones/.local/bin/backscroll list --project a4s --order timestamp:desc --limit 1000 --json
```

Base topical query (replace `TERM` literally with each ledger term):

```sh
/Users/pones/.local/bin/backscroll search --project a4s --text 'TERM' \
  --role user --content-type text --lexical-only --fields full --json --limit 60
```

Initial passes also used `--limit 30` or `35`; offset recovery used `--offset 30 --limit 30`. Counts below are the final 60-row audit, not a ranking of operator preferences. Capped rows mean additional matches exist or may exist; “below cap” means the result returned fewer than 60 under that exact query, not that the topic is historically complete.

| Topic family | Terms and returned row counts | Coverage interpretation |
| --- | --- | --- |
| Intake/task selection/execution | `ideas` 28; `intake` 1; `backlog` 60; `roadmap` 60; `autonomo` 7; `secuencial` 18; `paralelo` 11 | Backlog/Roadmap capped; Spanish human terms outperform English `intake`, whose result was not independent human evidence. Exact-session checks supplement. |
| Context/history/learning | `contexto` 52; `compact` 60; `historial` 22; `reglas` 60; `aprendizaje` 1; `jev` 60; `patrones` 6; `recuperar` 1 | Compact/rules/Jev capped. Recap, readiness, abort, temporal authority, patterns, rules, and continued work are covered separately, not collapsed into “memory”. |
| Providers/resources/safety | `costo` 5; `valor` 6; `modelos` 51; `quota` 5; `grupos` 1; `seguridad` 1; `credenciales` 12; `sops` 9; `datos` 5 | Scarce direct safety-word results are not missing policy: explicit SOPS/native-auth human evidence and complete normative config provide it. No actual secrets/provider state retrieved. |
| Delegation/quality/UI/configuration | `delega` 12; `siempre` 23; `e2e` 8; `settings` 19; `workspace` 60; `worktrees` 57; `publico` 3; `ci` 60; `skills` 60 | Workspace/CI/skills capped. Stemming can make `ci` retrieve unrelated variants; quoted/mixed material is attribution-checked. |
| Purpose | `proposito` 0 | Widened once with `--all-projects --text '"A4S" purpose' --limit 15` (10 returned, largely injected). E02/E03/E19/N01/R01/R02 ground purpose instead. |

Current-conversation recovery:

```sh
/Users/pones/.local/bin/backscroll search --project a4s --source-path '*01a0fa54*' \
  --text 'intenciones' --role user --content-type text --lexical-only \
  --fields full --json --limit 25
```

Repeat that exact scoped form for `componentes`, `pruebas`, `pi`, `harness`, `guía`, `investigaciones`, `repositorio`, and `humo`. A scoped `proyecto` query returned zero; neighboring terms recovered relevant scope questions. Do not convert those questions or the quoted plan into decisions.

For every E-reference, use its full session ID in `--source-path '*SESSION-ID*'` and a distinctive source cue from the evidence table. Examples:

```sh
# Human decision authority historical wish, not current policy
/Users/pones/.local/bin/backscroll search --project a4s --source-path '*103c1291*' \
  --text 'contexto' --role user --content-type text --lexical-only --fields full --json --limit 30

# Value versus activity
/Users/pones/.local/bin/backscroll search --project a4s --source-path '*01a0c737*' \
  --text 'valor' --role user --content-type text --lexical-only --fields full --json --limit 30

# Question is not mutation authorization
/Users/pones/.local/bin/backscroll search --project a4s --source-path '*01a0f970*' \
  --text 'solo' --role user --content-type text --lexical-only --fields full --json --limit 40

# Later correction to mandatory delegation
/Users/pones/.local/bin/backscroll search --project a4s --source-path '*01a0eff9*' \
  --text 'global' --role user --content-type text --lexical-only --fields full --json --limit 15
```

Some targeted stems returned no result (`fd519123`/`jev`, `orquestador`; `103c1291`/`perdio`, `reanud`; `01a0d0a9`/`automat`). They are retrieval gaps, not negative proof that the human never discussed the subject. Equivalent-topic evidence was recovered; no endless widening was performed. Early-window check: project-scoped `--before 2026-09-16 --text a4s` located the September 1 correction that A4S does not own agent inputs, as well as later research questions.

## 7. What is proven, what is not, and remaining observations

### Proven by this research

- The explicit current research direction is Pi, intention-first capability selection, Handbook-guided evidence, and exclusion of incoherent/conflicting formulations.
- The baseline config's normative contract and selected Git changes exist at fixed, reproducible source identities.
- The individually cited human messages support the stated needs, corrections, and historical wishes.
- The inventory separates those needs from their proposed mechanisms, authorship/authority limits, and dispositions.
- Several apparently `accepted` historical formulations differ from current policy; universal Jev authority, universal delegation, broad automatic rule activation, and wholesale migration must not be imported as current requirements.

### Not proven

- A clean Pi startup, cutover date, deployed architecture, relocated repository, or a working image-test package.
- Satisfaction of all `INT` records by Pi, any old A4S component, or a combination of packages.
- Current provider access, quota, credentials, privacy enforcement, global config, or runtime installation.
- Durable lifecycle/mailbox recovery after process/host restart, reliable attention delivery, exclusive ownership, or safe exactly-once external effects.
- Improved quality/cost/value from Jev compaction, Ladder, routing, delegation, CI changes, or any historical commit count.
- Operator acceptance of this document, all historical work, or the architecture proposed by assistants.

### Remaining operational evidence dimensions — not a plan or authorization

A later authorized experiment or implementation may need to observe: the actual consuming runtime and loaded steering; useful bounded result and operator acceptance; status versus acceptance; interruption and reopening recovery; failure/abort behavior; task ownership under concurrent execution; secret/data boundaries; applicable real-runtime E2E; and, for the proposed image route, proof that the tests really execute **inside** the image with declared mounts/network/credentials and verified cleanup.

Not all these observations belong to every intention or one component. The separate Pi capability document should establish documented correspondence and unsupported paths first. Unavailable evidence remains `unknown`; incompatible intent formulations can be excluded without replacing them with new infrastructure.

## 8. Document validation and safety

The research document inherits `.workspace/docs/.stem` (`version: 2`, `root: true`) with **no research schema or validation rules**. Rootline `describe` returned an empty effective schema; `rootline new ... --dry-run` failed with “no .stem schema found”. The requested document therefore carries explicit research frontmatter without altering `.stem`.

Rootline query found the requested record and its explicit research metadata. Rootline validation returned **1/1 valid, zero errors and warnings**, with no configured research schema. Structural checks found **68 unique, gapless inventory IDs**, balanced fenced blocks, and a complete evidence-reference index. Whitespace/source-identity checks are recorded in the researcher return; they do not replace source review. An empty-schema Rootline success can confirm parsing/record accessibility and absence of configured-rule failures; it **cannot** certify evidence accuracy, completeness, authority, runtime fit, or acceptance. Research/source validation and diff review are the relevant checks. No Pi runtime session, live model-evaluation call, container, or software-test suite was launched as an operational check; the research agents used to produce the two documents are not runtime experiments.

Only this requested Markdown file was written by this researcher. No Git commit, branch/push, task-record mutation, `.stem` change, environment configuration, credential use, or implementation was performed.

## Key Learnings:

1. Historical operator needs survive changes of mechanism; historical mechanisms do not acquire a preservation entitlement.
2. User-role retrieval is not human-authority evidence: quoted assistant proposals, dispatchers, and forked copies require attribution and deduplication.
3. Current config is the sole repository WoW authority; a historical `accepted` ADR or passing fixture does not prove operational capability or value.
4. The image-test proposal specifically requires tests inside the image, but neither package adoption nor containment is established by these researches.
