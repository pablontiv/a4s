---
title: "Desirable A4S intentions compared with Pi capabilities through the Harness Handbook"
type: research
status: documentary-crosswalk-not-adopted
date: "2026-10-02"
language: en
project: A4S
bead: a4s-kx5
baseline_sha: 73a95469867529d0b2bdad89711cbbce5f1db103
normative_authority: ".workspace/config.yaml on integrated main"
intentions: 68
capabilities_considered: 42
runtime: Pi
installed_version: "1.0.0"
public_documentation: "https://pi.dev/docs/latest"
documentation_accessed: "2026-10-02"
runtime_tests: not-run
implementation_authorization: none
cutover_authorization: none
---

# Desirable A4S intentions compared with Pi capabilities through the Harness Handbook

## 1. Question and supported answer

**Question:** Which desirable A4S outcomes have a coherent path using Pi, which need something outside its native contract, and which historical formulations should not be forced into the selected runtime?

**Answer:** Pi supplies a documented conversation-and-tool substrate, not the complete fulfillment of A4S's intentions. Several needs can be pursued through native behavior; others are decisions about authority, evidence, human acceptance, or existing external systems rather than missing runtime components. Extensibility supports specific candidate paths, not a promise that any desired capability is available. The useful comparison is therefore **desired outcome → necessary responsibility → evidenced means → remaining owner and failure boundary**, not old package → replacement package.

The main findings are:

1. A bounded assignment can use native Pi entrypoints, tools, events, and session history. Its correctness, useful acceptance, Git delivery, and task state remain separate responsibilities.
2. Conversation persistence is relevant to continuity, but does not establish crash-safe task ownership, durable scheduling, exactly-once external effects, or accepted-result recovery. These stronger outcomes remain external/unknown in the scoped catalogue.
3. Instructions, skills, and templates can express the way of working. Loading them does not enforce it. The Handbook exposes this responsibility boundary; it does not choose A4S's policy or supply Pi's missing controls.
4. The proposed package that launches an image and executes **Pi's tests inside it** has plausible documented integration means. Its suite, source identity, image, access boundary, cancellation, and cleanup are still unresolved. Neither the package nor the image was implemented or tested.
5. The exact current tool-row candidate cannot be treated as loadable on the inspected public declaration set. Its required `registerSetting` and `registerTranscriptPresentationPolicy` ports are missing there. A custom dialog is not equivalent to the requested native settings experience.
6. Universal Jev authority, automatic activation of mined rules, unconditional delegation, mandatory legacy controllers, and activity-count success are not requirements to preserve. Rejecting these formulations does not reject useful decision support, learning, concurrency, continuity, or evidence.

**No roadmap, package selection, policy amendment, deletion, repository relocation, runtime activation, or cutover is authorized by this report.** It supports a later choice of a small useful result. It does not declare all 68 desires current requirements, all 42 capacities necessary, or any proposed check passed.

### How to read this report

Read this section and section 7 for the decision boundary; section 5 for critical behavior chains; section 4 for a particular `INT-###`; section 6 to check whether a Pi feature has a real demand. The earlier inventories remain the source records for intention provenance and capability contracts:

- [A4S intentions inventory](2026-10-02-a4s-intentions-inventory.md): all historical evidence, attribution cautions, dispositions, and currentness labels.
- [Pi capability catalogue](2026-10-02-pi-handbook-capabilities.md): public interfaces, all 23 Handbook stages, catalogue gaps, and proposed checks.

## 2. Evidence, provenance, and method

### 2.1 Fixed local baseline and inherited research

| Evidence | Observation and limitation |
|---|---|
| A4S baseline | Clean synchronized main `73a95469867529d0b2bdad89711cbbce5f1db103` before creating the dedicated research worktree. The two input reports are integrated by [PR #20](https://github.com/pablontiv/a4s/pull/20). This does not make their research suggestions normative. |
| Current authority | [Integrated config](../../config.yaml), Git blob `5e3ca645e0f8e1a8db90e4f6ffc88e7adac24c92`. It governs conducting this work, not an immutable future architecture. |
| Intentions file | SHA-256 `0e0b42dec78268a6b8d226a39415f35c6261ba069ff82428518994dd788ebfab`; 68 identifiers. Historical statuses and rejected formulations are inherited, not silently reactivated. |
| Capability file | SHA-256 `2b71a957ce1cd37c5aa49c19175e20176e661480284d001cd3d060cdd1055cac`; 42 identifiers. Its first inquiry needed no Pi source exception; this inquiry adds the bounded declaration check below. |
| Clarification | Individually checked current-project Backscroll message `2026-10-02T20:43:51Z` states that intentions are desirable. The operator subsequently authorized this comparison. That is research authorization, not adoption of each historical wish. |
| Installed Pi | Package metadata for `@earendil-works/pi-coding-agent` reports version `1.0.0`, Node `>=22.19.0`, and test script `vitest --run`. Metadata is not startup, test execution, registry-release attestation, or account access. |
| Targeted API exception | Installed public `dist/core/extensions/types.d.ts`, SHA-256 `6c78c89ad1ffb421e81ff0ad11ceff1a635b21fd818a32aa3e87009392298d9f`, inspected only for the exact tool-row ports. No blanket private implementation audit was performed. |

This crosswalk **inherits**, rather than repeats, the intentions inventory's 34 topical searches, deduplication, 66-ADR survey, and selected Git evidence. Its 308 candidate-human records are not 308 authenticated decisions; its eight capped lexical terms and incomplete whole-corpus saturation remain limitations. The 40-page Pi and 23-stage coverage belongs to the capability catalogue, not a claim that this comparison re-audited every upstream source file.

The new material check is narrow: current research clarification, current configuration and input bytes, public Pi reference refresh, and the exact A4S tool-row candidate against installed public declarations. Online `latest` is moving. No new upstream commit pin or equality between online docs, installed distribution, modified Pi, and a future image is asserted.

### 2.2 Public source reading path

The following primary documentation was consulted on 2026-10-02, including the preparation resumed for this report. These links are version-sensitive evidence, not instructions to run anything:

| Responsibility | Primary sources and relevant catalogue entries |
|---|---|
| Method and reference responsibilities | [Harness Handbook methodology](https://ruhan-wang.github.io/Harness-Handbook/); [Codex responsibility index](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/index.html). All stage definitions are linked in the catalogue's section 4; session, side-effect, collaboration, and testing introductions were refreshed directly. |
| Entry and lifecycle | [How Pi Works](https://pi.dev/docs/latest/how-pi-works), [CLI Integration](https://pi.dev/docs/latest/cli-integration), [SDK](https://pi.dev/docs/latest/sdk), [RPC Mode](https://pi.dev/docs/latest/rpc), [RPC Commands](https://pi.dev/docs/latest/rpc-commands), [JSON Event Stream](https://pi.dev/docs/latest/json): CAP-01, 09–14, 35. |
| Effective inputs | [Configuration](https://pi.dev/docs/latest/configuration), [Environment Variables](https://pi.dev/docs/latest/environment-variables), [Settings](https://pi.dev/docs/latest/settings), [Skills](https://pi.dev/docs/latest/skills), [Prompt Templates](https://pi.dev/docs/latest/prompt-templates), [Pi Packages](https://pi.dev/docs/latest/packages): CAP-02–08. |
| History and context | [Sessions](https://pi.dev/docs/latest/sessions), [Session File Format](https://pi.dev/docs/latest/session-format), [Compaction](https://pi.dev/docs/latest/compaction), [Extensions](https://pi.dev/docs/latest/extensions): CAP-12–13, 18–20. |
| Models and provider boundaries | [Models](https://pi.dev/docs/latest/models), [Providers](https://pi.dev/docs/latest/providers), [Custom Providers](https://pi.dev/docs/latest/custom-provider), [Virtual Models](https://pi.dev/docs/latest/virtual-models): CAP-21–28, 34. |
| Execution and isolation | [Run Pi Safely](https://pi.dev/docs/latest/security), [Containerization](https://pi.dev/docs/latest/containerization), [MCP](https://pi.dev/docs/latest/mcp), [Codemode](https://pi.dev/docs/latest/codemode): CAP-04, 15–17, 29–30, 38–40. |
| Presentation | [Terminal UI](https://pi.dev/docs/latest/tui), [RPC Extension UI](https://pi.dev/docs/latest/rpc-extension-ui), and the fixed [A4S tool-row candidate README](../../../packages/pi-tool-row-presentation/README.md): CAP-31–32, 41; INT-060–061. |

The capability catalogue carries less central contracts such as themes, keybindings, export, and diagnostics. They were considered for relevance, not all freshly audited here. A Pi Durable announcement appears in navigation; a scheduling/job contract is still outside the scoped CLI/SDK/RPC evidence. **Unknown in this scope is not absence from every Pi product.**

### 2.3 Applying the Handbook closely without claiming more evidence than we have

The Handbook's layered approach starts with system flow, groups responsibilities, then localizes behavior and implementation evidence. Here:

- **L1:** trace one selected result through input, effective runtime/configuration, model/tool work, visible output, persistence, and disposal.
- **L2:** identify which actor or subsystem owns each responsibility. A session, a task, a provider account, a Git branch, and a container are different state owners.
- **Documentary L3:** identify public contract, trigger, transition, failure, and a proposed observation that could refute the fit. Only the tool-row mismatch has a targeted declaration-level check. This is **not** a generated Pi implementation handbook or a complete code-evidence audit.

`H#` is a responsibility location in the Codex reference map, not a Pi module, build order, policy clause, or mandatory component. Missing Codex parity is immaterial unless the selected A4S result actually needs that behavior. Section 5 makes the most consequential state/error paths explicit; section 4 accounts for every intention without creating a component for it.

## 3. Interpretation and governance

### 3.1 Orthogonal fit codes

| Code | Documentary verdict | Not established |
|---|---|---|
| **D** | A narrowly named behavior has a direct native contract. | Execution, quality, authority, containment, or acceptance of the whole intention. |
| **P** | Native means cover part of the desirable outcome; a stated responsibility remains. | Complete native fulfillment. |
| **X** | A public extension/embedding point supports a candidate implementation path. | Existing implementation, compatibility of an old package, maintenance value, or delivery. |
| **E** | A human decision/process or external tool/service owns the outcome. Pi may invoke or display it. | A missing Pi component that must be built. |
| **U** | Evidence does not settle a necessary behavior, exact dependency, or chosen boundary. | Impossibility; permission to invent an adapter; approval to investigate every uncertainty. |

Codes can coexist. `E` is often the correct separation, not a failure. No percentage of migrated intentions is computed: broad outcomes and small preferences are not equal units. A `D` for one primitive must not upgrade an entire intent to satisfied. A refuted **exact candidate** is distinguished from an unknown or undesirable **whole outcome**.

The source inventory's `N/D/H/R/Q/U` currentness labels use a different namespace: normative text, direct research direction, historical human need, record, question/proposal, unknown. They are retained in each record. In particular, `N` proves a rule is written, not that Pi enforces it; source `D` is not the fit code `D`.

### 3.2 Governance owners and current controls

These references shorten the crosswalk. They identify current repository controls; none is a new rule, implementation package, or immutable target-policy decision.

| Ref | Current responsibility and config keys | Future choice kept separate |
|---|---|---|
| G-01 | Operator chooses the result and reserved effects; `roles`, `choose_work`, `do_work.safety`, `deliver_work.reserved_authority`. | How an eventual consuming Pi path proves authorized scope and refuses ambiguous effects. A classifier is not the operator. |
| G-02 | One integrated policy source, historical records non-normative; `authority`, `do_work.knowledge`, `improve_work.change`. | Deliberate future policy changes need authorization; a new runtime does not automatically import old mechanisms. |
| G-03 | Ready work, dependencies, progress and criteria; `define_work`, `prepare_work.shared_readiness`, `track_work`, `accept_work.evidence`. | Ownership/durability semantics beyond the current record contract, if an actual chosen result needs them. |
| G-04 | Credentials, external-effect controls and safe access; `do_work.credentials`, `do_work.external_effects`, `do_work.safety`. | Concrete image/network/data boundary. Native provider resolution does not grant permission to disclose input or mutate live systems. |
| G-05 | Sanitized durable evidence, scoped history and exact cleanup; `do_work.history`, `do_work.knowledge`, `accept_work.evidence`, `deliver_work.close`, `improve_work.cleanup`. | Retention and recovery of necessary state without hoarding raw session or credential output. |
| G-06 | Tested/consumed artifact identity; `accept_work.end_to_end`, `accept_work.public_api`, `deliver_work.cadence`, `product.providers`. | A compatible public Pi version, image/source identity and suite rather than a locally modified runtime posing as released support. |
| G-07 | Kind- and risk-specific checks, review, PR and CI; `accept_work.kind_checks`, `accept_work.review`, `deliver_work`. | Any future proportional CI/test-allocation change, not a blanket waiver inferred from cost concerns. |
| G-08 | Direct reversible design, self-contained reuse, references not migrations; `prepare_work.design`, `product`. | Selected integration surface, repository scope and cutover criteria only when chosen. |
| G-09 | Material-unknown experiment vs blanket PoC wording; `prepare_work.new_capability`, `do_work.investigation`. | The two clauses are in tension. Do not silently choose a universal separate PoC gate or remove it; escalate when a chosen path depends on that interpretation. |
| G-10 | Description-first factual communication; `choose_work.backlog_decisions`, `track_work.progress`; current direct reply-length instruction. | Presentation preferences and persistent opt-in scope, not semantic acceptance or safety enforcement. |

The Handbook is the **analysis method and responsibility map** in this comparison; governance is the set of explicit decisions governing authority, state, evidence, risk, and delivery. A Handbook stage mentioning approvals is not itself an adopted approval policy. Conversely, a coherent future governance change is not technically impossible merely because it differs from today's config. This report records that decision separately and changes neither side.

## 4. Complete intention-to-capability crosswalk

Each record preserves its original desired outcome and authority evidence, links the relevant public-contract catalogue entries and Handbook responsibilities, identifies the remaining owner, and gives a falsification/acceptance observation. **Every proposed check in this section is NOT RUN.** For policy/preferences the check is a workflow observation, not a demand for an automated test. For executable paths the eventual environment must be separately selected and authorized; this report does not launch it.

### 4.1 Purpose and scope

#### INT-001

- **Desirable outcome:** Turn recurring multi-repository effort into usable, verified capability.
- **Intention provenance:** N01 `purpose.outcome`; R01 ADR 0021, 2026-09-21; E02, 2026-09-17. **Source currentness (not adoption):** N; the product purpose is explicit.
- **Contract/evidence path:** [CAP-01](2026-10-02-pi-handbook-capabilities.md#cap-01--entrypoints-and-output-modes), [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations). **Handbook responsibility:** [H1](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-1.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi can perform bounded repository work. Executor owns result verification; operator owns useful acceptance; Git/task tools own delivery. No catalogue primitive proves portfolio value.
- **Governance:** G-03, G-07, G-08.
- **Proposed check — NOT RUN:** Perform one chosen useful assignment; inspect its actual consuming result and acceptance independently of settlement or commit count.

#### INT-002

- **Desirable outcome:** Prevent open commitments from disappearing when focus, incoming work, or sessions change.
- **Intention provenance:** E03, 2026-09-16/17; R02 ADR 0001, 2026-08-31. **Source currentness (not adoption):** H/R; current task records and blockers are N under `define_work`, `track_work`.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H6](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-6.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E/U. Remaining boundary/owner:** Conversation recovery is relevant, but commitments need an authoritative work record and attention path. Existing Beads can be examined first; native durable commitment resurfacing is unestablished.
- **Governance:** G-03, G-05.
- **Proposed check — NOT RUN:** Reopen after an interruption and reconcile one pending commitment from the work record; fail if only a transcript survives or a finished task restarts.

#### INT-003

- **Desirable outcome:** Reduce the human fatigue of coordinating many projects and deciding where attention is needed.
- **Intention provenance:** E02, `2026-09-17T14:49:42Z`; R03 ADR 0010, 2026-09-17. **Source currentness (not adoption):** H/Q; explicit reported fatigue and interest in centralization.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction), [CAP-36](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H9](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-9.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html).
- **Documentary fit: P/E/U. Remaining boundary/owner:** Events and display can reveal local progress. Cross-project prioritization and actionable attention remain outside one Pi session; neither a global LLM nor new dashboard is intrinsic.
- **Governance:** G-03, G-10.
- **Proposed check — NOT RUN:** Observe whether the human can locate the next actionable decision across a bounded project sample without repeated status chasing; do not substitute polling counts for benefit.

#### INT-004

- **Desirable outcome:** Keep a comprehensible A4S project boundary without preserving the old harness simply because it exists.
- **Intention provenance:** E01, 2026-10-02; E02, 2026-09-17; R01 ADRs 0011/0021. **Source currentness (not adoption):** D/N for the research's A4S boundary; H/Q for relocation details.
- **Contract/evidence path:** [CAP-02](2026-10-02-pi-handbook-capabilities.md#cap-02--runtime-location-environment-and-platform-setup), [CAP-03](2026-10-02-pi-handbook-capabilities.md#cap-03--layered-settings-and-resource-discovery), [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation). **Handbook responsibility:** [H3](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-3.html), [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html).
- **Documentary fit: E. Remaining boundary/owner:** A4S remains the project and Pi the selected runtime. Directory placement, product scope and legacy deactivation are operator/design decisions, not consequences of package loading.
- **Governance:** G-02, G-08.
- **Proposed check — NOT RUN:** Compare the actual startup/resource set with the explicitly chosen boundary; verify no legacy path is still required before claiming a cutover. No deletion follows this check.

#### INT-005

- **Desirable outcome:** Use the selected existing runtime rather than compare or maintain unwanted runtime paths indefinitely.
- **Intention provenance:** E01, `2026-10-02T14:40:36Z`: “usaremos pi no Codex”. **Source currentness (not adoption):** D; selection is explicit.
- **Contract/evidence path:** [CAP-01](2026-10-02-pi-handbook-capabilities.md#cap-01--entrypoints-and-output-modes), [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints). **Handbook responsibility:** [H1](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-1.html), [H8](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-8.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html).
- **Documentary fit: D/P. Remaining boundary/owner:** Pi provides documented native entrypoints. Selecting Pi does not choose CLI vs SDK vs RPC, providers, isolation, or prove a clean operational base.
- **Governance:** G-06, G-08.
- **Proposed check — NOT RUN:** Start only the later chosen entrypoint with the intended version and effective inputs; obtain a bounded output, query state where applicable, interrupt, and recover history.

#### INT-006

- **Desirable outcome:** Understand real runtime behavior before modifying it; do not force inconsistent intentions.
- **Intention provenance:** E01, `03:08:50Z`, `03:13:26Z` on 2026-10-02; W01. **Source currentness (not adoption):** D; the requested guiding method is explicit.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-41](2026-10-02-pi-handbook-capabilities.md#cap-41--shared-messagetypes-and-reusable-uiutilities). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H18](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-18.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: E. Remaining boundary/owner:** The Handbook supplies an evidence method, not a runtime feature. Executor traces the needed Pi contract; incompatible reference internals are omitted rather than reproduced.
- **Governance:** G-06, G-07.
- **Proposed check — NOT RUN:** For a chosen behavior, trace trigger, owner, states, errors and evidence through the consuming interface; report unknowns instead of claiming full code-level equivalence.

#### INT-007

- **Desirable outcome:** Add small useful functions incrementally, not a noisy inventory of preserved components.
- **Intention provenance:** E01, `02:03:47Z`, `03:13:26Z`; E12, 2026-09-25; N01 `prepare_work.design`. **Source currentness (not adoption):** D/N.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-16](2026-10-02-pi-handbook-capabilities.md#cap-16--executable-extension-registration). **Handbook responsibility:** [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: X/E. Remaining boundary/owner:** Skills/packages/extensions are possible delivery forms, not predetermined atomic units. Prefer existing native behavior; accept an addition only for a demonstrated useful gap.
- **Governance:** G-07, G-08, G-09.
- **Proposed check — NOT RUN:** Show one independently acceptable result and why an existing native/external path is insufficient; reject extra abstractions with no observation supporting their value.

#### INT-008

- **Desirable outcome:** Reuse lessons from other projects without migrating them by implication.
- **Intention provenance:** E02, `2026-09-17T19:30:57Z`; R04; N01 `product.providers`. **Source currentness (not adoption):** N/H; migration exclusion is directly supported.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H7](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-7.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html).
- **Documentary fit: E. Remaining boundary/owner:** Reusable resources and integration can consume external providers. Related repository histories are references; no ownership transfer or wholesale migration is implied.
- **Governance:** G-02, G-08.
- **Proposed check — NOT RUN:** Inspect selected dependency boundaries and the actual repository diff; reject unrelated vendoring, copied policy or another repository's mutation.

### 4.2 Authority and governance

#### INT-009

- **Desirable outcome:** Make informed choices without becoming the bottleneck for every technical detail.
- **Intention provenance:** E04, `2026-09-19T15:18:17Z`, `15:28:41Z`; N01 `roles`, `choose_work`. **Source currentness (not adoption):** H for universal Jev; N gives the operator result choice and reserved authority.
- **Contract/evidence path:** [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-26](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations). **Handbook responsibility:** [H5](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-5.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Native classifier/model access can assist a decision. The operator still chooses result and reserved action; universal Jev approval is an excluded historical formulation.
- **Governance:** G-01, G-02.
- **Proposed check — NOT RUN:** Give conflicting evidence and uncertain classifier output; verify it is presented as advice and no result/authority is changed on that output alone.

#### INT-010

- **Desirable outcome:** Know one complete, current source for the way of working.
- **Intention provenance:** E13, 2026-09-26/27; E14, 2026-09-30; N01 `authority`; G08. **Source currentness (not adoption):** N.
- **Contract/evidence path:** [CAP-03](2026-10-02-pi-handbook-capabilities.md#cap-03--layered-settings-and-resource-discovery), [CAP-05](2026-10-02-pi-handbook-capabilities.md#cap-05--system-prompts-and-globalancestor-context), [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state). **Handbook responsibility:** [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi can supply instruction inputs; A4S owns which source governs. Multiple loaded resources can still contradict config, so presence is not enforcement.
- **Governance:** G-02.
- **Proposed check — NOT RUN:** Inspect effective global, ancestor, project, skill and extension steering; locate competing clauses and show that a branch or historical record cannot become current policy.

#### INT-011

- **Desirable outcome:** Ask questions and inspect status without accidentally authorizing action.
- **Intention provenance:** E16, `2026-10-02T00:55:10Z`; E14 `03:21:25Z`; N01 `do_work.safety`; G03. **Source currentness (not adoption):** D/H/N.
- **Contract/evidence path:** [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-17](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** Read-only status is an interaction/authorization contract. Tool mediation can guard calls, but natural-language intent and trusted code remain separate boundaries.
- **Governance:** G-01, G-10.
- **Proposed check — NOT RUN:** Ask a status question, paste a plan and quote a command in fixtures; verify no task/config/live mutation occurs without an independently authorized action.

#### INT-012

- **Desirable outcome:** Allow authorized work to continue without repeated approval ceremony.
- **Intention provenance:** E11, 2026-09-24/25; N01 `do_work.modes`; G07. **Source currentness (not adoption):** N requires an explicit autonomous scope.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html).
- **Documentary fit: P/X/E/U. Remaining boundary/owner:** Pi can run and continue input; an authorized multi-task loop remains executor/host responsibility. Queueing or continuation hooks are not durable backlog autonomy.
- **Governance:** G-01, G-03.
- **Proposed check — NOT RUN:** Choose bounded autonomous scope; confirm independent work continues only inside it and stops for missing controls/decisions. A status query must not cancel that scope.

#### INT-013

- **Desirable outcome:** Preserve control over consequential or unsafe changes while delegating routine execution.
- **Intention provenance:** N01 `authority.deviation`, `external_effects`, `reserved_authority`; G07. **Source currentness (not adoption):** N.
- **Contract/evidence path:** [CAP-04](2026-10-02-pi-handbook-capabilities.md#cap-04--project-resource-trust), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-17](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation), [CAP-39](2026-10-02-pi-handbook-capabilities.md#cap-39--tool-only-isolation-and-remote-execution-adaptation). **Handbook responsibility:** [H2](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-2.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** Tool gates can mediate configured calls; OS/container boundary owns confinement. Project trust, watching a transcript and hiding a tool are not comprehensive effect control.
- **Governance:** G-01, G-04.
- **Proposed check — NOT RUN:** Attempt a forbidden fixture write/network effect through direct, nested and extension paths; confirm deny behavior at the intended boundary, including noninteractive mode.

#### INT-014

- **Desirable outcome:** Avoid controls whose ceremony exceeds their risk or useful evidence.
- **Intention provenance:** E14 `2026-10-01T03:35:36Z`; E06 `2026-09-26T08:43:48Z`; G07; N01 `accept_work.review`. **Source currentness (not adoption):** N; current proportionality supersedes universal historical gates.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-17](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls), [CAP-42](2026-10-02-pi-handbook-capabilities.md#cap-42--developer-verification-and-pi-core-regression-suites). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: E. Remaining boundary/owner:** Proportional controls are policy and task design, not another runtime gate framework. Native test or hook availability does not justify universal use.
- **Governance:** G-07, G-09.
- **Proposed check — NOT RUN:** Compare a research task and an executable change; require evidence relevant to each and reject redundant reviewer/E2E/experiment ceremony not required by the result or risk.

#### INT-015

- **Desirable outcome:** Understand who proposes, chooses, builds, reviews, and owns each result.
- **Intention provenance:** E02 `14:49:42Z`; E06 `2026-09-26T08:31:44Z`; N01 `roles`. **Source currentness (not adoption):** N for current vocabulary; H for old topology.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-36](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work). **Handbook responsibility:** [H8](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-8.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html).
- **Documentary fit: E. Remaining boundary/owner:** Roles express responsibility. SDK sessions/subprocesses could implement separate workers, but executor and implementer may be one actor; topology does not confer authority.
- **Governance:** G-01, G-03.
- **Proposed check — NOT RUN:** For one result identify chooser, implementer, reviewer if needed and evidence owner; verify no overlapping writer or unowned acceptance stage.

#### INT-016

- **Desirable outcome:** Preserve why decisions changed without allowing old instructions to govern again.
- **Intention provenance:** N01 `authority.records`, `knowledge`, `decision_records`; G08; G06. **Source currentness (not adoption):** N.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory). **Handbook responsibility:** [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi retains branch history; current decision authority belongs to integrated policy and explicit approved changes. Persisted accepted-looking ADRs are not active rules.
- **Governance:** G-02, G-05.
- **Proposed check — NOT RUN:** Retrieve an old accepted record and its superseding current evidence; ensure the explanation preserves chronology without reactivating its instructions or editing history.

### 4.3 Intake, backlog and execution

#### INT-017

- **Desirable outcome:** Capture spontaneous ideas across active/dormant projects and independent research without losing them.
- **Intention provenance:** E04 `2026-09-19T16:31:20Z`. **Source currentness (not adoption):** H/Q: a concrete scenario and bounded requested role.
- **Contract/evidence path:** [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** A prompt can capture an idea and an external record can retain it. Cross-project routing/intake schema is not a native durable inbox; a custom package is only one possible means.
- **Governance:** G-01, G-03, G-05.
- **Proposed check — NOT RUN:** Record one idea with provenance and unresolved scope, then retrieve it later without launching project work, creating unsupported commitments, or losing the idea on disconnect.

#### INT-018

- **Desirable outcome:** Keep intake from silently deciding or changing active projects.
- **Intention provenance:** E04 `16:31:20Z`; N01 `choose_work.changed_decision`. **Source currentness (not adoption):** H/N.
- **Contract/evidence path:** [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-17](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls), [CAP-26](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** Recording, proposing, choosing and executing are distinct transitions. Neither a prompt template nor classification establishes permission to reprioritize/start work.
- **Governance:** G-01, G-03.
- **Proposed check — NOT RUN:** Capture an ambiguous idea; compare backlog and current work before/after and verify only the explicitly authorized intake artifact changed.

#### INT-019

- **Desirable outcome:** Have identifiable work records rather than untracked execution.
- **Intention provenance:** E02 `2026-09-17T22:22:37Z`; R05 ADR 0019; N01 `define_work.beads`. **Source currentness (not adoption):** N for epic/task and kind labels; R for every-tab dispatch contract.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H6](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-6.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi session IDs/entries identify conversation, not the accepted work contract. Beads owns current A4S task records; custom entries may reference them without replacing them.
- **Governance:** G-03, G-05.
- **Proposed check — NOT RUN:** Show Description, ID, Result, Scope and readiness for a selected task; reject a session/tab ID or callback as a substitute for missing work fields.

#### INT-020

- **Desirable outcome:** Size tasks so each delivers a testable, independently acceptable result.
- **Intention provenance:** E09 `2026-09-23T00:34:00Z`; N01 `define_work.units`, `classification`. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: E. Remaining boundary/owner:** Task sizing and kind are agreed by acceptable result. Pi instructions can communicate them but do not make a research document an implementation task.
- **Governance:** G-03, G-07.
- **Proposed check — NOT RUN:** Check a proposed task has one independently verifiable result, explicit boundaries and kind-specific evidence; split only genuinely independent acceptance outcomes.

#### INT-021

- **Desirable outcome:** See the real backlog and priorities without hidden ranking, filtering, mutation, or invented readiness.
- **Intention provenance:** E11, 2026-09-24; E16, 2026-10-01/02; G03/G04. **Source currentness (not adoption):** D/R; current `roadmap` is read-only display, not an executor.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi can invoke/present an existing backlog tool. Recorded priorities and read-only semantics remain the external tool/skill contract; no native ranker is required.
- **Governance:** G-01, G-03, G-10.
- **Proposed check — NOT RUN:** Render a fixture backlog including missing fields; compare output with recorded priorities and snapshot data to prove no filtering-by-invention, backfill or mutation.

#### INT-022

- **Desirable outcome:** Know what has been accepted, what remains, and why it is blocked.
- **Intention provenance:** E06 `08:31:44Z`, `08:43:48Z`; E16; N01 `track_work`. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction). **Handbook responsibility:** [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Native run state supplies progress only. Work acceptance, pending criteria and blockers must come from task evidence; idle and worker DONE are insufficient.
- **Governance:** G-03, G-07, G-10.
- **Proposed check — NOT RUN:** Present a settled run with failing/missing acceptance evidence and a blocked dependency; verify status remains pending/blocked with the actual reason.

#### INT-023

- **Desirable outcome:** Avoid impossible backlogs, circular dependencies, dead ends, or repeated “sanitized” claims without evidence.
- **Intention provenance:** E10 `2026-09-24T20:16:23Z`, `20:58:42Z`; E06 `06:56:23Z`; N01 `prepare_work`, `track_work.blockers`. **Source currentness (not adoption):** H/N for readiness; R for Doctor algorithms.
- **Contract/evidence path:** [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: E/U. Remaining boundary/owner:** Dependency/readiness checks belong to the chosen task system. The catalogue does not establish a native graph validator, and a missing field cannot be repaired by inspection.
- **Governance:** G-03.
- **Proposed check — NOT RUN:** Inspect circular or missing dependencies and absent criteria; report exact failures without modifying records or treating an empty executable list as completion.

#### INT-024

- **Desirable outcome:** Continue independent authorized work when one task is blocked, and explain the stop condition.
- **Intention provenance:** R06 ADRs 0052/0059; N01 `do_work.modes.autonomous`, `track_work.blockers`. **Source currentness (not adoption):** N for scoped continuation; emergency wording is historical only.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html).
- **Documentary fit: P/X/E/U. Remaining boundary/owner:** Native runs and controlled continuation support pieces of scoped work. Skip/stop decisions belong to executor/host and task authority, not unconditional self-continuation.
- **Governance:** G-01, G-03.
- **Proposed check — NOT RUN:** Block one task in a bounded fixture scope; verify only independent ready work proceeds and the failed objective is not closed or its unavailable control bypassed.

#### INT-025

- **Desirable outcome:** Resume a task without double execution, false ownership, or reopening completed stages.
- **Intention provenance:** R06 ADRs 0033/0057; N01 `track_work.controller_identity`; E03 continuity question. **Source currentness (not adoption):** H/R; current config identifies `PI_SESSION_ID` but does not mandate the whole old fencing algorithm.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E/U. Remaining boundary/owner:** Resume restores conversation. Exclusive task ownership, crash recovery, fencing and external-effect reconciliation have no complete native contract evidenced here; a session ID is not a lock.
- **Governance:** G-03, G-04, G-05.
- **Proposed check — NOT RUN:** Interrupt after a fixture effect, restart, and introduce a competing owner; verify no duplicate execution/closure and that unresolved effect/owner state blocks the dependent path.

#### INT-026

- **Desirable outcome:** Execute a chosen backlog/epic with consistent methods rather than require operator babysitting.
- **Intention provenance:** E07 `2026-09-23T21:17:21Z`; R06 ADRs 0032–0035/0044/0048; N01 `do_work.modes`. **Source currentness (not adoption):** H/N for execution need; legacy workflow is R, not current read-only Roadmap.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html).
- **Documentary fit: P/X/E/U. Remaining boundary/owner:** Pi can consume instructions and perform runs. Chosen-backlog selection, readiness, evidence and durable continuation are outside the read-only Roadmap display contract.
- **Governance:** G-01, G-03, G-07.
- **Proposed check — NOT RUN:** Execute a later selected bounded backlog using existing task tools; verify dependency order, accepted results and stop reasons without expanding scope or silently reviving the legacy controller.

### 4.4 Continuity, context and learning

#### INT-027

- **Desirable outcome:** Preserve commitments, steering, and results across disconnect, process interruption, and reopening.
- **Intention provenance:** E03; E19 proposed requirements, 2026-09-15; R02 ADR 0001. **Source currentness (not adoption):** H/R/Q; continuity need supported, complete portable contract not adopted.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-35](2026-10-02-pi-handbook-capabilities.md#cap-35--orderly-sessionruntime-shutdown), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H6](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-6.html), [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H17](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-17.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E/U. Remaining boundary/owner:** Native conversation/session navigation helps continuity, but shutdown/disconnect does not prove work acknowledgement, crash-safe queues or recovery of accepted stages.
- **Governance:** G-03, G-05.
- **Proposed check — NOT RUN:** Reopen after normal exit and hard interruption at separate lifecycle points; reconcile task/effects/history explicitly and report any lost input or ambiguous unfinished effect.

#### INT-028

- **Desirable outcome:** Recover pertinent prior work without guessing, repeating investigations, or obeying stale history.
- **Intention provenance:** E04 `2026-09-19T14:55:31Z`; E08 `2026-09-24T15:16:49Z`; N01 `do_work.history`. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Session history and external Backscroll/document access support retrieval. Query relevance, authorship, deduplication and present authority remain executor responsibilities.
- **Governance:** G-02, G-05.
- **Proposed check — NOT RUN:** Answer one contextual question with primary source identity/date and current verification; include a copied user-role wrapper to show it is not treated as a new human decision.

#### INT-029

- **Desirable outcome:** Keep useful context available while reducing token and attention cost.
- **Intention provenance:** E09 `2026-09-22T22:03:30Z`; E17 `2026-09-27T07:09:51Z`; R07 ADRs 0013/0022/0029. **Source currentness (not adoption):** H/R; efficiency question remains open.
- **Contract/evidence path:** [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-19](2026-10-02-pi-handbook-capabilities.md#cap-19--compaction-and-branch-summarization), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-27](2026-10-02-pi-handbook-capabilities.md#cap-27--prompt-caching-and-warming), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: D/P/X/E. Remaining boundary/owner:** Native compaction supports bounded context. Retrieved context and custom transforms are candidate means; outcome quality and net cost benefit are unproven. No Context Expert preservation follows.
- **Governance:** G-02, G-05, G-07.
- **Proposed check — NOT RUN:** Compare equivalent useful outcomes before/after context reduction, including missing decisions, retrieval, total usage and rework; refute an optimization that loses required context.

#### INT-030

- **Desirable outcome:** Suggest or run compaction only when there is genuinely compactable history.
- **Intention provenance:** E09 `2026-09-22T21:49:22Z`; E15 `2026-09-25T20:58:36Z`; R07 ADR 0055. **Source currentness (not adoption):** H/R for operational problem and correction record.
- **Contract/evidence path:** [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-19](2026-10-02-pi-handbook-capabilities.md#cap-19--compaction-and-branch-summarization), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing). **Handbook responsibility:** [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html).
- **Documentary fit: D/P/X. Remaining boundary/owner:** Native context usage and compaction have documented eligibility/settings. A custom suggestion must respect actual compactable history, not a universal token heuristic.
- **Governance:** G-06, G-10.
- **Proposed check — NOT RUN:** Use a short session and a long eligible session; verify suggestions, command results and cancellation agree, avoiding a misleading hint followed by nothing-to-compact.

#### INT-031

- **Desirable outcome:** Make a persisted setting work consistently across sessions without repeated opt-in ceremony.
- **Intention provenance:** E15 `2026-09-25T22:22:53Z`, `22:24:00Z`; R07 ADR 0056. **Source currentness (not adoption):** H/R; specific auto-mode semantics recorded.
- **Contract/evidence path:** [CAP-03](2026-10-02-pi-handbook-capabilities.md#cap-03--layered-settings-and-resource-discovery), [CAP-19](2026-10-02-pi-handbook-capabilities.md#cap-19--compaction-and-branch-summarization), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction). **Handbook responsibility:** [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H9](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-9.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html).
- **Documentary fit: D/P/X/E. Remaining boundary/owner:** Pi persists native preferences; an A4S-specific setting needs its own public contract and scope. Exact generic native settings registration is not established for current candidates.
- **Governance:** G-01, G-06, G-10.
- **Proposed check — NOT RUN:** Set an explicitly bounded preference, restart and inspect its effect; confirm it persists without silently authorizing rules, deployments, model changes or external effects.

#### INT-032

- **Desirable outcome:** Respect interruption/abort and fail visibly instead of immediately repeating unsafe or unwanted context work.
- **Intention provenance:** E18 `2026-10-01T22:12:10Z`; G02. **Source currentness (not adoption):** H/R; fixed commit documents a bounded correction.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-19](2026-10-02-pi-handbook-capabilities.md#cap-19--compaction-and-branch-summarization), [CAP-25](2026-10-02-pi-handbook-capabilities.md#cap-25--retry-and-context-overflow-recovery), [CAP-35](2026-10-02-pi-handbook-capabilities.md#cap-35--orderly-sessionruntime-shutdown). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H17](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-17.html).
- **Documentary fit: D/P/X. Remaining boundary/owner:** Pi exposes interruption and failure state. RPC abort alone leaves queued messages eligible; custom summaries and external work need separately guarded failure behavior.
- **Governance:** G-01, G-03, G-06.
- **Proposed check — NOT RUN:** Clear queues then abort in a bounded run; independently inspect pending input, retry/compaction and partial effects. Fail on silent substitution or unintended continuation.

#### INT-033

- **Desirable outcome:** Distinguish current instruction/state from superseded or historical material after compaction and retrieval.
- **Intention provenance:** G06; N01 `authority`, `history`; R07 ADR 0029. **Source currentness (not adoption):** N for precedence; R for projection mechanism.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-19](2026-10-02-pi-handbook-capabilities.md#cap-19--compaction-and-branch-summarization), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** Active-branch reconstruction and retrieved context can preserve chronology. A4S must label/verify current versus superseded evidence; a classifier cannot grant authority.
- **Governance:** G-02, G-05.
- **Proposed check — NOT RUN:** Compact and retrieve conflicting old/new instructions; verify current policy/source remains distinguishable and an abandoned branch does not become active state.

#### INT-034

- **Desirable outcome:** Learn which interactions repeatedly cause ignored instructions, stress, rework, and similar outcomes.
- **Intention provenance:** E08 `2026-09-23T23:48:56Z`, `23:50:39Z`, `2026-09-24T14:11:56Z`. **Source currentness (not adoption):** H/Q; requested objective directly evidenced.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-26](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing), [CAP-33](2026-10-02-pi-handbook-capabilities.md#cap-33--export-share-diagnostics-and-feedback). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** Diagnostics/history can support incident analysis. Pattern finding, causal explanation and improvement are research outcomes; classifier labels or semantic similarity alone do not fulfill them.
- **Governance:** G-05, G-07.
- **Proposed check — NOT RUN:** Use bounded incidents with competing clauses, effective steering and consequences; test whether the proposed explanation accounts for observed rework rather than just grouping messages.

#### INT-035

- **Desirable outcome:** Turn verified lessons into durable guidance without new contradictory rules or accidental automatic authority.
- **Intention provenance:** E05, 2026-09-18; R08 ADRs 0012/0024; E06 `2026-09-26T05:09:52Z`; N01 `improve_work.change`. **Source currentness (not adoption):** H/Q/R; current norm requires operator-approved change.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-26](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** Pi can persist/present proposed lessons. Normative adoption remains operator-approved config change; automatic rule injection is an excluded formulation, not a missing feature to restore.
- **Governance:** G-01, G-02, G-05.
- **Proposed check — NOT RUN:** Derive one sourced lesson, retain it as a proposal, and verify no effective policy changes until approved/integrated. An uncertain lesson must remain reviewable, not silently activated.

#### INT-036

- **Desirable outcome:** Keep durable knowledge and execution evidence in understandable, queryable, appropriately scoped places.
- **Intention provenance:** E12 `2026-09-25T14:32:54Z`; R06 ADR 0050; N01 `knowledge`, `accept_work.evidence`. **Source currentness (not adoption):** N.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H6](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-6.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Conversation storage complements, but does not replace, Rootline documents and task-canonical evidence. Durable work facts need the appropriate external owner and sanitized provenance.
- **Governance:** G-03, G-05.
- **Proposed check — NOT RUN:** Retrieve a durable finding and task evidence without raw provider/session caches; verify references survive restart and missing temporary files do not masquerade as durable proof.

### 4.5 Delegation and attention

#### INT-037

- **Desirable outcome:** Avoid silent idle/blocked work and get actionable requests/results to the right human or executor.
- **Intention provenance:** E02 `14:49:42Z`; R03 ADR 0010; E10 `2026-09-24T18:48:08Z`; R05 ADR 0015. **Source currentness (not adoption):** H/R; current blocker reporting is N.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction), [CAP-36](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work), [CAP-37](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html).
- **Documentary fit: P/X/E/U. Remaining boundary/owner:** Events/notifications can expose active work. Reliable cross-session wakeup and actionable human attention need a chosen external/host delivery path; polling is not intrinsically required.
- **Governance:** G-03, G-10.
- **Proposed check — NOT RUN:** Cause a real bounded blocker and verify the intended human receives one actionable status, with ownership and next decision; test restart/delivery failure if a durable notification path is selected.

#### INT-038

- **Desirable outcome:** Parallelize independent work and serialize actual dependencies.
- **Intention provenance:** E05 `2026-09-18T21:15:49Z` is propagated/attribution-sensitive; E14 `2026-09-30T18:17:48Z`, `20:01:13Z` independently requests fan-out. **Source currentness (not adoption):** H for desired concurrency; N permits ordering within authorized dependencies/scope.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-17](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls), [CAP-36](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work). **Handbook responsibility:** [H8](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-8.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html).
- **Documentary fit: X/E. Remaining boundary/owner:** Multiple sessions/processes can be constructed. Caller owns authorization, shared writer isolation, quotas, dependency serialization, results and cancellation; fork is not a Git worktree.
- **Governance:** G-01, G-03, G-04.
- **Proposed check — NOT RUN:** Compare independent and shared-writer fixture tasks; allow only safe concurrent paths and prove separate outputs/ownership with no overlap or stranded child after cancellation.

#### INT-039

- **Desirable outcome:** Keep coordination focused while work is delegated when it actually helps.
- **Intention provenance:** E06 `2026-09-26T08:25:47Z`; E14 `2026-10-01T15:40:53Z`; G07. **Source currentness (not adoption):** H; current roles allow executor and implementer to be the same.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-36](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work). **Handbook responsibility:** [H8](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-8.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html).
- **Documentary fit: X/E. Remaining boundary/owner:** Delegation is possible construction, not native managed supervision or a universal rule. Direct execution remains valid when cheaper and sufficient.
- **Governance:** G-03, G-07, G-08.
- **Proposed check — NOT RUN:** For a selected task compare direct work with bounded delegation on evidence/overhead; reject automatic fan-out and verify delegated scope does not exceed the parent result.

#### INT-040

- **Desirable outcome:** Obtain a genuinely fresh, complete review where the risk warrants it.
- **Intention provenance:** N01 `accept_work.review`; E06 `08:43:48Z`; G07; E18 `2026-10-02T14:27:58Z`. **Source currentness (not adoption):** N; preferred cross-family/provider when readily available, focused self-review fallback recorded.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-36](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work). **Handbook responsibility:** [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: X/E. Remaining boundary/owner:** Pi can run another bounded reviewer context/model. Freshness, complete candidate coverage and real independence are review conditions owned by the workflow.
- **Governance:** G-01, G-06, G-07.
- **Proposed check — NOT RUN:** For a risk-triggered review verify exact candidate, fresh context and findings; record readily available provider/family and justified fallback without adding a routine docs review stack.

#### INT-041

- **Desirable outcome:** Transfer enough context and result evidence without bloating the coordinating agent.
- **Intention provenance:** R05 ADR 0015; R06 ADRs 0043/0050; E04 intake overload scenario. **Source currentness (not adoption):** H/R; N requires evidence and blockers, not one fixed transport.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-18](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration), [CAP-36](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H15](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/X/E. Remaining boundary/owner:** Custom entries, files and tool results can carry bounded handoffs. Sender/receiver own provenance, completeness and durable evidence; a result pointer is not acceptance.
- **Governance:** G-03, G-05.
- **Proposed check — NOT RUN:** Transfer a result with task/candidate/source identity and limits; verify receiver can retrieve it after temporary output removal and does not infer integration from submitted text.

### 4.6 Providers, credentials and failure

#### INT-042

- **Desirable outcome:** Use available subscriptions/providers appropriately rather than stall or introduce another unwanted runtime.
- **Intention provenance:** E20 `2026-09-25T13:25:52Z`, `14:12:58Z`; R09 ADRs 0018/0054. **Source currentness (not adoption):** H/Q; present research runtime is Pi.
- **Contract/evidence path:** [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-22](2026-10-02-pi-handbook-capabilities.md#cap-22--provider-authentication-and-credential-resolution), [CAP-34](2026-10-02-pi-handbook-capabilities.md#cap-34--network-transport-and-providerclient-support). **Handbook responsibility:** [H5](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-5.html), [H7](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-7.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H19](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-19.html).
- **Documentary fit: D/P/E/U. Remaining boundary/owner:** Native provider selection/authentication is available in contract. Actual subscriptions, account limits, model eligibility and service uptime are external and unverified.
- **Governance:** G-04, G-06.
- **Proposed check — NOT RUN:** Later authorized provider check distinguishes configured, auth-ready and actually usable routes; report unavailable/quota state without assuming a catalogue entry guarantees service.

#### INT-043

- **Desirable outcome:** Know the actual model/provider route before reacting to quota or reporting identity.
- **Intention provenance:** E05 `2026-09-18T22:08:51Z` is propagated/attribution-sensitive; R09 ADR 0054; E20 quota problem. **Source currentness (not adoption):** R/H; no live-route test here.
- **Contract/evidence path:** [CAP-02](2026-10-02-pi-handbook-capabilities.md#cap-02--runtime-location-environment-and-platform-setup), [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-24](2026-10-02-pi-handbook-capabilities.md#cap-24--virtual-model-routing), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing). **Handbook responsibility:** [H3](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-3.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html).
- **Documentary fit: D/P. Remaining boundary/owner:** Pi exposes selected identity and routing/assistant dispatch evidence. The selected virtual name, shell metadata and actual physical request must not be conflated.
- **Governance:** G-04, G-06.
- **Proposed check — NOT RUN:** Run a deterministic routed fixture and inspect selected versus dispatched provider/model per attempt, including resume/missing registration; do not act on a stale quota broadcast.

#### INT-044

- **Desirable outcome:** Recover from quota/network/provider failure without repeating paid work or duplicating effects.
- **Intention provenance:** E20 `2026-09-25T13:25:52Z`; R09 ADR 0054; N01 `external_effects`. **Source currentness (not adoption):** H/Q/R; resilience is supported, fallback implementation not established.
- **Contract/evidence path:** [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-24](2026-10-02-pi-handbook-capabilities.md#cap-24--virtual-model-routing), [CAP-25](2026-10-02-pi-handbook-capabilities.md#cap-25--retry-and-context-overflow-recovery), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H19](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-19.html).
- **Documentary fit: P/X/E/U. Remaining boundary/owner:** Native retry and programmable virtual routing support parts of recovery. Cross-provider fallback, quota policy and duplicate-effect barriers are not blanket guarantees.
- **Governance:** G-01, G-04, G-06.
- **Proposed check — NOT RUN:** Inject transient, quota and post-tool failure separately; verify attempt bounds, visible failure, route identity and no duplicated fixture effect. Stop/reconcile after an ambiguous live effect.

#### INT-045

- **Desirable outcome:** Choose models/topologies from fair, relevant evidence, including cost and real results.
- **Intention provenance:** E21 `2026-09-22T05:36:35Z`, `15:38:21Z`; E22; R09 ADRs 0017/0018. **Source currentness (not adoption):** H/Q; no model winner adopted here.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-26](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing). **Handbook responsibility:** [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi can standardize runs and collect usage. Fair fixtures, data eligibility, outcome scoring, physical attribution and accepted value are evaluation-method responsibilities.
- **Governance:** G-01, G-04, G-07.
- **Proposed check — NOT RUN:** Compare equivalent tasks with fixed inputs, admissible providers and complete usage/rework evidence; leave missing billing and model quality unknown rather than declaring a winner from token counts.

#### INT-046

- **Desirable outcome:** Avoid duplicated provider authentication, transport, and private integration maintenance.
- **Intention provenance:** R10 ADRs 0020/0065; G05; N01 `do_work.credentials`. **Source currentness (not adoption):** N for credential policy; R for package/runtime correction.
- **Contract/evidence path:** [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-22](2026-10-02-pi-handbook-capabilities.md#cap-22--provider-authentication-and-credential-resolution), [CAP-23](2026-10-02-pi-handbook-capabilities.md#cap-23--custom-providers-and-stream-normalization), [CAP-26](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations). **Handbook responsibility:** [H5](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-5.html), [H7](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-7.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H19](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-19.html).
- **Documentary fit: D/P/E. Remaining boundary/owner:** Native provider/model operations support avoiding a duplicate private integration. Custom provider ports exist only for demonstrated unmet protocol needs; old TypeSafe machinery has no preservation entitlement.
- **Governance:** G-04, G-06, G-08.
- **Proposed check — NOT RUN:** Verify the chosen path resolves through the intended native provider and public contract, with no private imports or competing auth store; recheck the exact consuming runtime/version.

#### INT-047

- **Desirable outcome:** Keep credentials usable for authorized operations without exposing plaintext in repository or evidence.
- **Intention provenance:** E13 `2026-09-28T05:23:31Z`; N01 `do_work.credentials`; G09. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-22](2026-10-02-pi-handbook-capabilities.md#cap-22--provider-authentication-and-credential-resolution), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation). **Handbook responsibility:** [H5](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-5.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi owns native provider resolution; SOPS/age and operator-approved operations own other-service secrets. Containers and export paths can still expose supplied credentials.
- **Governance:** G-04, G-05.
- **Proposed check — NOT RUN:** With fake credentials test source precedence, cancellation and redacted output; separately verify required encrypted source/identity before a later credential-dependent action, without printing secret material.

#### INT-048

- **Desirable outcome:** Respect data sensitivity when selecting remote providers and publishing reusable artifacts.
- **Intention provenance:** E21 `2026-09-22T13:14:26Z`, `13:16:56Z`; R09 ADR 0027; E23; N01 `credentials`, `safety`. **Source currentness (not adoption):** H/Q/R; credential safety is N.
- **Contract/evidence path:** [CAP-17](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls), [CAP-21](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints), [CAP-24](2026-10-02-pi-handbook-capabilities.md#cap-24--virtual-model-routing), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration), [CAP-34](2026-10-02-pi-handbook-capabilities.md#cap-34--network-transport-and-providerclient-support), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation). **Handbook responsibility:** [H5](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-5.html), [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H19](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-19.html).
- **Documentary fit: P/X/E/U. Remaining boundary/owner:** Choosing routes/tools does not establish data-class eligibility. Network/OS limits and a chosen data policy must cover model requests, nested tools, exports and mounts.
- **Governance:** G-01, G-04.
- **Proposed check — NOT RUN:** Use sanitized fixtures for eligible/ineligible routes and blocked destinations; confirm no sensitive payload leaves through another tool or diagnostic path. Historical classifications remain unadopted.

#### INT-049

- **Desirable outcome:** Make failure/retry boundaries explicit and reproducible before another live attempt.
- **Intention provenance:** R09 ADR 0054; N01 `external_effects`, `do_work.investigation`; G02. **Source currentness (not adoption):** N for live mutation retry controls.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-17](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls), [CAP-25](2026-10-02-pi-handbook-capabilities.md#cap-25--retry-and-context-overflow-recovery), [CAP-35](2026-10-02-pi-handbook-capabilities.md#cap-35--orderly-sessionruntime-shutdown). **Handbook responsibility:** [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H17](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-17.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Runtime errors/retry events can support diagnosis. Cause, failing reproduction, review and renewed live authorization are separate workflow controls, not agent retry semantics.
- **Governance:** G-01, G-04, G-07.
- **Proposed check — NOT RUN:** Inject failure before and after a fixture effect; record observed cause, changed condition and reproduction. Verify a failed live mutation cannot be retried merely because retry is enabled.

### 4.7 Quality, delivery, value and tests

#### INT-050

- **Desirable outcome:** Measure value by useful accepted outcomes, not visible activity.
- **Intention provenance:** E22 `2026-09-21T20:37:43Z`, `21:50:06Z`; R11 ADR 0036; E01 `02:01:59Z`; N01 `purpose`, `track_work.progress`. **Source currentness (not adoption):** H/N for outcome emphasis; specific efficiency metric is R, outside current WoW.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing), [CAP-33](2026-10-02-pi-handbook-capabilities.md#cap-33--export-share-diagnostics-and-feedback). **Handbook responsibility:** [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi usage/status provides cost/activity context. Useful accepted outcomes and durable consuming changes require independent result evidence; no native success metric replaces them.
- **Governance:** G-03, G-07.
- **Proposed check — NOT RUN:** Present high-activity/low-value and small-useful-result cases; confirm reporting distinguishes accepted utility, missing proof and operational cost without count-based success.

#### INT-051

- **Desirable outcome:** Demonstrate changed behavior through its real representative entry point.
- **Intention provenance:** E24, 2026-09-22; E18 `2026-10-02T01:14:45Z`; N01 `accept_work.end_to_end`; G07. **Source currentness (not adoption):** N; changed executable paths require safe representative E2E when available.
- **Contract/evidence path:** [CAP-01](2026-10-02-pi-handbook-capabilities.md#cap-01--entrypoints-and-output-modes), [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-16](2026-10-02-pi-handbook-capabilities.md#cap-16--executable-extension-registration), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation), [CAP-42](2026-10-02-pi-handbook-capabilities.md#cap-42--developer-verification-and-pi-core-regression-suites). **Handbook responsibility:** [H1](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-1.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi provides representative consuming entrypoints. The chosen executable contract determines E2E, environment and observations; a structural fake does not establish activation.
- **Governance:** G-06, G-07.
- **Proposed check — NOT RUN:** Invoke the changed path in the actual pinned runtime/selected non-production environment and inspect result/effects. Retain focused pre-release checks as limited evidence, not released support.

#### INT-052

- **Desirable outcome:** Validate research and documents against sources without inventing unnecessary software tests.
- **Intention provenance:** E13 `2026-09-26T19:29:56Z`, `2026-09-28T05:50:13Z`; N01 `accept_work.kind_checks`; G07. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: E. Remaining boundary/owner:** Source comparison, Rootline and diff checks own research validation. Pi/model/container execution is unnecessary unless the accepted research result requires such an experiment.
- **Governance:** G-05, G-07.
- **Proposed check — NOT RUN:** Verify source references, claims, identifier coverage and diff; make unrun runtime checks explicit. Do not add a model-dependent E2E test to turn source research green.

#### INT-053

- **Desirable outcome:** Prove a material unknown cheaply before expensive operationalization, without ritual experiments for known paths.
- **Intention provenance:** E12 `2026-09-25T13:18:14Z`; N01 `prepare_work.new_capability`, `design`; G07. **Source currentness (not adoption):** H/N, with an internal config tension noted in section 5.
- **Contract/evidence path:** [CAP-01](2026-10-02-pi-handbook-capabilities.md#cap-01--entrypoints-and-output-modes), [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation), [CAP-40](2026-10-02-pi-handbook-capabilities.md#cap-40--proposed-package-that-starts-an-image-and-runs-tests-inside-it), [CAP-42](2026-10-02-pi-handbook-capabilities.md#cap-42--developer-verification-and-pi-core-regression-suites). **Handbook responsibility:** [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: E/U. Remaining boundary/owner:** A small safe probe can resolve a material unknown. The current PoC clauses conflict; policy interpretation must not be inferred from native integration options or historical ritual.
- **Governance:** G-07, G-08, G-09.
- **Proposed check — NOT RUN:** Identify the single blocking unknown and cheapest discriminating observation; if task choice depends on universal separate-PoC wording, seek a bounded policy decision rather than silently applying/removing it.

#### INT-054

- **Desirable outcome:** Deliver integrated task results promptly without bypassing quality/security gates.
- **Intention provenance:** E11; E10 `2026-09-24T20:40:57Z`; N01 `deliver_work`; G07. **Source currentness (not adoption):** N; PR delivery and current applicable controls govern.
- **Contract/evidence path:** [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: E. Remaining boundary/owner:** Pi may invoke Git/forge tools; accepted PR integration remains Git/CI/workflow responsibility. Queue or runtime completion is not authorization to bypass a failing required check.
- **Governance:** G-01, G-07.
- **Proposed check — NOT RUN:** Verify applicable checks, exact candidate and remote CI before merge; leave a missing control pending. Do not revive expired billing exceptions or direct-main fallbacks.

#### INT-055

- **Desirable outcome:** Close only when the actual reviewed candidate is integrated and stable main is synchronized/clean.
- **Intention provenance:** E25 `2026-09-26T04:40:08Z`; N01 `deliver_work.close`; R12 ADR 0058. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-13](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-35](2026-10-02-pi-handbook-capabilities.md#cap-35--orderly-sessionruntime-shutdown). **Handbook responsibility:** [H11](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H17](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-17.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Session end supplies no Git postconditions. Reviewed head, merged PR, synchronized clean stable main and resource ownership are external facts.
- **Governance:** G-03, G-05, G-07.
- **Proposed check — NOT RUN:** After verified integration inspect main/origin equality, worktree/branch/PR identities and retained evidence; refuse cleanup/closure on any wrong head, dirty state or unknown ownership.

#### INT-056

- **Desirable outcome:** Retain enough sanitized, reproducible evidence without accumulating raw transcripts and disposable artifacts.
- **Intention provenance:** N01 `prepare_work.shared_readiness`, `accept_work.evidence`, `deliver_work.close`; R06 ADR 0050. **Source currentness (not adoption):** N.
- **Contract/evidence path:** [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-33](2026-10-02-pi-handbook-capabilities.md#cap-33--export-share-diagnostics-and-feedback). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Native history/export may contain confidential material. Task/document owners classify and sanitize durable/disposable/retained outputs; exporting everything is not required.
- **Governance:** G-04, G-05.
- **Proposed check — NOT RUN:** Retrieve sanitized verdict/provenance after disposable output cleanup and verify no raw credential/provider cache is retained by default or specifically retained evidence deleted.

#### INT-057

- **Desirable outcome:** Remove orphaned task resources safely without losing work or making inactive automation look productive.
- **Intention provenance:** E10, 2026-09-24; E26, 2026-09-02; R12 ADR 0063; N01 `improve_work.cleanup`. **Source currentness (not adoption):** N for exact bounded post-merge cleanup; old global sweeps are H.
- **Contract/evidence path:** [CAP-14](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-35](2026-10-02-pi-handbook-capabilities.md#cap-35--orderly-sessionruntime-shutdown), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation), [CAP-40](2026-10-02-pi-handbook-capabilities.md#cap-40--proposed-package-that-starts-an-image-and-runs-tests-inside-it). **Handbook responsibility:** [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H17](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-17.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Runtime disposal and image cleanup are separate from exact Git task cleanup. OS/container/Git owners must verify identity; name-based orphan sweeps are excluded.
- **Governance:** G-01, G-05.
- **Proposed check — NOT RUN:** Test repeated cleanup on exact owned fixture resources plus an unrelated retained resource; verify only the allowed set is removed and ambiguous identity blocks deletion.

#### INT-058

- **Desirable outcome:** Spend CI time and provider quota only on relevant verification.
- **Intention provenance:** E27 `2026-09-29T19:50:51Z`, `21:02:40Z`; G01/G07 record boundaries. **Source currentness (not adoption):** H/Q; exact hosting solution not chosen here.
- **Contract/evidence path:** [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation), [CAP-42](2026-10-02-pi-handbook-capabilities.md#cap-42--developer-verification-and-pi-core-regression-suites). **Handbook responsibility:** [H13](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: P/E/U. Remaining boundary/owner:** Pi can expose usage and run tests; CI allocation/provider quota/hosting are external decisions. The catalogue selects neither Buildkite nor a reduced verification matrix.
- **Governance:** G-06, G-07.
- **Proposed check — NOT RUN:** Compare proposed checks with changed behavior and accepted criteria; retain required evidence, measure real cost and show what a removed job would stop proving before proposing a policy change.

#### INT-059

- **Desirable outcome:** Execute tests in an explicitly isolated image rather than merely start an image and test outside it.
- **Intention provenance:** E01 `2026-10-02T18:48:10Z`, clarified `20:07:17Z`. **Source currentness (not adoption):** D/Q; precise proposed means, not implemented.
- **Contract/evidence path:** [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-16](2026-10-02-pi-handbook-capabilities.md#cap-16--executable-extension-registration), [CAP-35](2026-10-02-pi-handbook-capabilities.md#cap-35--orderly-sessionruntime-shutdown), [CAP-38](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation), [CAP-40](2026-10-02-pi-handbook-capabilities.md#cap-40--proposed-package-that-starts-an-image-and-runs-tests-inside-it), [CAP-42](2026-10-02-pi-handbook-capabilities.md#cap-42--developer-verification-and-pi-core-regression-suites). **Handbook responsibility:** [H2](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-2.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html), [H17](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-17.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: X/E/U. Remaining boundary/owner:** Package/command means can launch an external image runner. Exact Pi suite/source, engine access, image and process location remain unknown. This is not A4S-test substitution or host-wide isolation.
- **Governance:** G-04, G-05, G-06, G-07, G-09.
- **Proposed check — NOT RUN:** Independently prove the selected Pi test process and target version are inside the image, with failure/timeout/abort/deny/cleanup evidence and no host fallback; see section 5.6.

### 4.8 Presentation, reuse and ways of working

#### INT-060

- **Desirable outcome:** Configure capabilities through a consistent native experience rather than proliferating special commands/UIs.
- **Intention provenance:** E09 `2026-09-22T21:49:22Z`; E18 `2026-10-02T18:35:32Z`; G01. **Source currentness (not adoption):** H/D/R.
- **Contract/evidence path:** [CAP-03](2026-10-02-pi-handbook-capabilities.md#cap-03--layered-settings-and-resource-discovery), [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-16](2026-10-02-pi-handbook-capabilities.md#cap-16--executable-extension-registration), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction), [CAP-41](2026-10-02-pi-handbook-capabilities.md#cap-41--shared-messagetypes-and-reusable-uiutilities). **Handbook responsibility:** [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H9](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-9.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H18](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-18.html).
- **Documentary fit: P/X/U. Remaining boundary/owner:** Native common preferences and extension UI exist. The exact candidate's native settings ports are missing from installed declarations; generic dialogs/slash commands are not equivalent fulfillment.
- **Governance:** G-06, G-08, G-10.
- **Proposed check — NOT RUN:** Require an actually published compatible port/version and consuming TUI check for native row, shared persistent state and restart. Do not use mapped types/pi-local success as release proof.

#### INT-061

- **Desirable outcome:** Reduce transcript/tool noise while preserving useful visibility and user choice.
- **Intention provenance:** E28 `2026-09-24T14:10:29Z`; E18; G01. **Source currentness (not adoption):** H/R; the baseline calls the package a staged candidate.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-12](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection), [CAP-16](2026-10-02-pi-handbook-capabilities.md#cap-16--executable-extension-registration), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction), [CAP-32](2026-10-02-pi-handbook-capabilities.md#cap-32--themes-keybindings-and-terminal-capabilities), [CAP-41](2026-10-02-pi-handbook-capabilities.md#cap-41--shared-messagetypes-and-reusable-uiutilities). **Handbook responsibility:** [H9](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-9.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html), [H18](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-18.html), [H22](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-22.html).
- **Documentary fit: P/X/U. Remaining boundary/owner:** Presentation primitives support some custom rendering; the exact full/compact/hidden transcript-policy candidate is blocked by its missing host port. Visibility is not deletion or access control.
- **Governance:** G-05, G-06, G-10.
- **Proposed check — NOT RUN:** With a compatible later runtime verify mode changes, shortcut, persistence and complete stored evidence in TUI; test headless/RPC behavior separately and never claim hiding secures content.

#### INT-062

- **Desirable outcome:** See human work descriptions and task-level progress, not opaque IDs or one todo per subagent.
- **Intention provenance:** E06 `08:31:44Z`, `08:43:48Z`; E14 `2026-09-30T02:17:57Z`, `03:21:25Z`; N01 `choose_work.backlog_decisions`. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Pi can show status or retrieved task data. Current Bead fields and task-level progress come from the external work contract, not a subagent/session list.
- **Governance:** G-03, G-10.
- **Proposed check — NOT RUN:** Show Description, ID, Result, Scope and actual criteria with missing fields explicit; verify presentation causes no backfill/readiness change and one worker is not falsely one completed task.

#### INT-063

- **Desirable outcome:** Let a new developer understand purpose, roles, task kinds, and flow directly and logically.
- **Intention provenance:** E13 `2026-09-26T18:16:47Z`, `18:19:01Z`, `18:23:25Z`, `2026-09-28T05:50:13Z`; N01. **Source currentness (not adoption):** H/N for clear authority and explicit definitions.
- **Contract/evidence path:** [CAP-05](2026-10-02-pi-handbook-capabilities.md#cap-05--system-prompts-and-globalancestor-context), [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates). **Handbook responsibility:** [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html).
- **Documentary fit: E. Remaining boundary/owner:** Pi can supply written context, but comprehension is an artifact/teaching outcome. A command list or loaded prompt is not a self-contained explanation of ways of working.
- **Governance:** G-02, G-10.
- **Proposed check — NOT RUN:** Have the intended new-developer audience trace purpose, roles, result choice, kinds, authority and acceptance directly from config; identify unexplained terms without inventing another normative guide.

#### INT-064

- **Desirable outcome:** Reuse a small, maintainable mechanism across repositories without imposing one repository's policy everywhere.
- **Intention provenance:** E06 `2026-09-26T05:36:19Z`; R13 ADRs 0059/0060; N01 `product`. **Source currentness (not adoption):** N/R.
- **Contract/evidence path:** [CAP-06](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills), [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-16](2026-10-02-pi-handbook-capabilities.md#cap-16--executable-extension-registration), [CAP-29](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration). **Handbook responsibility:** [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H7](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-7.html), [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H14](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html).
- **Documentary fit: D/P/X/E. Remaining boundary/owner:** Native skills/templates/packages/public embedding support reusable means. Local policy and actual need must remain external inputs; no shared framework or provider fork is implied.
- **Governance:** G-02, G-06, G-08.
- **Proposed check — NOT RUN:** Use a selected small mechanism in two disposable repositories with different policies; verify self-contained dependencies and no inherited A4S authority or private runtime import.

#### INT-065

- **Desirable outcome:** Know which source/runtime/configuration was tested and consumed.
- **Intention provenance:** E12 `2026-09-25T16:09:17Z`; R14 ADR 0062; G05/G07; N01 `deliver_work.cadence`. **Source currentness (not adoption):** N for permitted consumption; R/H for release/version proposals.
- **Contract/evidence path:** [CAP-02](2026-10-02-pi-handbook-capabilities.md#cap-02--runtime-location-environment-and-platform-setup), [CAP-03](2026-10-02-pi-handbook-capabilities.md#cap-03--layered-settings-and-resource-discovery), [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-09](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk), [CAP-10](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control), [CAP-41](2026-10-02-pi-handbook-capabilities.md#cap-41--shared-messagetypes-and-reusable-uiutilities), [CAP-42](2026-10-02-pi-handbook-capabilities.md#cap-42--developer-verification-and-pi-core-regression-suites). **Handbook responsibility:** [H3](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-3.html), [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H18](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-18.html), [H23](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Version metadata, public types and resource configuration can expose identity. A reproducible result needs the actual consumed artifact/source/config, not only the development lockfile.
- **Governance:** G-05, G-06.
- **Proposed check — NOT RUN:** Record and compare runtime package, source/image identity, extension artifact and effective configuration; reject claims based on a different global/local-modified binary or floating latest label.

#### INT-066

- **Desirable outcome:** Bootstrap/upgrade another repository knowingly and detect stale operating configuration.
- **Intention provenance:** E12 `2026-09-25T16:05:20Z`, `16:09:17Z`. **Source currentness (not adoption):** H/Q; an explored capability with a clarified distinction.
- **Contract/evidence path:** [CAP-02](2026-10-02-pi-handbook-capabilities.md#cap-02--runtime-location-environment-and-platform-setup), [CAP-03](2026-10-02-pi-handbook-capabilities.md#cap-03--layered-settings-and-resource-discovery), [CAP-08](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations). **Handbook responsibility:** [H3](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-3.html), [H4](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html), [H22](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-22.html).
- **Documentary fit: P/X/E/U. Remaining boundary/owner:** Pi configuration/package means can support inspection/installation. A4S bootstrap/doctor/upgrade behavior is not established; current Roadmap has no inferred init command.
- **Governance:** G-01, G-02, G-06, G-08.
- **Proposed check — NOT RUN:** Detect a known stale configuration read-only in a fixture; require a separately chosen mutation payload before bootstrap/upgrade and verify rollback if that future result is selected.

#### INT-067

- **Desirable outcome:** Improve the way of working from observed failures without endless rules or unsolicited new work.
- **Intention provenance:** E06 `2026-09-26T05:09:52Z`, `08:38:18Z`; E14 `2026-10-01T03:35:36Z`; N01 `improve_work`; G07. **Source currentness (not adoption):** N/H.
- **Contract/evidence path:** [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-20](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory), [CAP-26](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations), [CAP-28](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing), [CAP-33](2026-10-02-pi-handbook-capabilities.md#cap-33--export-share-diagnostics-and-feedback). **Handbook responsibility:** [H12](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html), [H20](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html), [H21](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html).
- **Documentary fit: P/E. Remaining boundary/owner:** History/diagnostics support failure review, not automatic process change. Executor proposes sourced improvements; operator owns normative adoption. Findings must not create new tasks by themselves.
- **Governance:** G-01, G-02, G-05, G-07.
- **Proposed check — NOT RUN:** Review a bounded repeated failure with outcome evidence; propose one proportionate change and verify no rule/Bead/runtime behavior changes from a question, hypothesis or mined pattern alone.

#### INT-068

- **Desirable outcome:** Receive a concise, factual answer at the requested level while retaining the full evidence when needed.
- **Intention provenance:** E05 `2026-09-19T02:12:48Z`; E06 `2026-09-26T05:49:49Z`; E16 `00:55:10Z`; E01 research request. **Source currentness (not adoption):** H/D; exhaustive artifacts and concise chat are compatible.
- **Contract/evidence path:** [CAP-07](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates), [CAP-11](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events), [CAP-15](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations), [CAP-31](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction). **Handbook responsibility:** [H10](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html), [H16](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html).
- **Documentary fit: P/E. Remaining boundary/owner:** Native output/UI supports delivery format, not response discipline or truth. Executor owns concise factual chat with a durable detailed artifact and explicit unresolved evidence.
- **Governance:** G-05, G-10.
- **Proposed check — NOT RUN:** Compare a status reply with the source artifact and actual task state; verify no menu, invented completion, hidden failure or substantive answer stored only internally.

## 5. Critical behavior chains and discriminating failures

These are analytical chains, not implemented state machines or a new shared protocol. Their labels make transitions and ownership inspectable. The hypothetical checks remain **NOT RUN**; their order is not a roadmap. Source contracts support the primitives; the complete result is a research inference to validate later.

### 5.1 Useful assignment: native execution is not accepted delivery

**Related:** INT-001, 019–022, 050–055; CAP-01, 09–11, 15; H1, H10, H13–14, H16, H23.

```text
operator-chosen result + ready task + bounded authorized access
  -> chosen native Pi entrypoint receives input
  -> model/tool work produces output and observable effects
  -> Pi becomes settled (or fails/interruption occurs)
  -> executor independently checks the agreed result and controls
  -> useful acceptance / pending / failure is recorded in the work system
  -> Git/CI integration and exact cleanup, if the result requires a PR
```

Pi's RPC receipt separates input disposition from later events. A successful `prompt` receipt can mean handled or queued; it is not a verdict. `agent_end` may precede further automatic work, while `agent_settled` indicates final runtime quiescence. Neither owns A4S acceptance. [RPC Commands](https://pi.dev/docs/latest/rpc-commands), [JSON Event Stream](https://pi.dev/docs/latest/json)

**Failure localization:** rejected input belongs to the interface; provider/tool errors belong to execution; an incorrect changed file belongs to result verification; a failed required CI job belongs to delivery. Do not classify all four as “task completed” or all as the same retryable failure. The current acceptance/delivery responsibilities are G-03/G-07, not fields invented on a Pi event.

**Discriminating observation:** a settled response that makes no accepted useful change must remain an unaccepted result. A verified small change may be useful despite little activity. Run a later bounded assignment directly before considering a generic orchestrator. This is a proposed decision test, not a claim that the assignment has succeeded.

### 5.2 Contextual query and learning: source before synthesized authority

**Related:** INT-010, 016, 028, 033–036, 067; CAP-05–07, 13, 18–20, 26, 29; H12, H20–21.

```text
question about prior work
  -> current source / pertinent Backscroll or document lookup
  -> authenticate origin, date, duplication and scope
  -> compare current checkout/policy with historical claims
  -> select bounded context and answer with provenance and unknowns
  -> any lesson remains a sourced proposal until explicitly adopted
```

Native session access addresses retained conversation, not the entire cross-project search or authority problem. MCP can connect retrieval providers; this does not choose one or guarantee trustworthy results. Current A4S already identifies Backscroll and Rootline as history/document interfaces. A generic semantic store or rule compiler is not entailed by the comparison. [Sessions](https://pi.dev/docs/latest/sessions), [MCP](https://pi.dev/docs/latest/mcp), G-02/G-05

**Failure localization:** missing required source → unknown answer boundary; copied user-role wrapper → attribution failure; current branch treated as integrated authority → policy error; an obsolete instruction activated after retrieval → context/authority error. Classification may help selection, but may not authorize mutation.

**Discriminating observation:** answer a real bounded contextual query where an older accepted-looking record conflicts with current policy. Show primary evidence and current state before synthesized advice. If that can be done directly with existing tools, an extra retrieval package has no demonstrated necessity. A recurring retrieval failure could motivate a narrower chosen capability later; it does not do so automatically here.

### 5.3 Interruption and recovery: conversation, queue, work ownership and effects

**Related:** INT-002, 025, 027, 032, 044, 057; CAP-12–14, 25, 35, 37; H11, H15, H17, H21.

```text
active run + possibly queued input + separately owned task/effects
  -> intended stop semantics are chosen
  -> if canceling all pending input: clear queues, then abort
  -> inspect remaining input, recorded messages and partial tool effects
  -> dispose/exit, or separately handle process loss
  -> reopen session history
  -> reconcile task owner, completed criteria and external effect state
  -> continue only an authorized, non-duplicating next action
```

RPC's documented queue semantics require `clear_queue` before `abort` to reproduce interactive Escape; abort alone can continue remaining queued messages. Normal shutdown and abrupt process loss are different cases. The SDK makes `SessionManager` authoritative for finalized branch context; replacing a live message array does not replace persisted history. [RPC Commands](https://pi.dev/docs/latest/rpc-commands), [SDK](https://pi.dev/docs/latest/sdk)

**State owners:** Pi session tree owns conversation projection; Pi live session owns input queues/run flags; work records own task facts; a selected concurrency mechanism would own exclusive claims; Git/container/provider services own actual effects. A session ID can correlate these, not prove their atomicity or exclusivity. Current `controller_identity` names `PI_SESSION_ID`; that is not evidence of fencing.

**Failure localization:** input accepted but not durably queued; process killed after an effect but before a result; abandoned branch used for reconstruction; two writers resuming one task; unknown external outcome. The first unresolved contract blocks only the dependent recovery path. It is not evidence that simple resume is unusable or a reason to invent a durable controller immediately.

**Discriminating observation:** test normal restart separately from a hard interruption around a harmless fixture effect, and inspect both session and work record. Reconcile instead of blindly retrying when an effect is ambiguous. Durable scheduler/controller fit remains unknown in scoped CAP-37; Pi Durable would need a separate concrete contract before being proposed.

### 5.4 Context economy and compaction: quality before optimization

**Related:** INT-029–033, 035, 045, 050; CAP-18–19, 27–28; H12–13, H20–21.

```text
active branch + measured/estimated context + required decisions
  -> native eligible compaction or explicit bounded request
  -> summary/recent-history boundary or visible cancellation/failure
  -> subsequent context is reconstructed for the same active branch
  -> required decisions and tool-result relationships remain recoverable
  -> compare outcome quality, retrieval/rework and total operational cost
```

Pi documents native compaction, branch summaries, settings, and customization hooks; raw history is retained. Its native path is the baseline candidate, not a fallback to recreate an old package around by default. A custom strategy is justified only if an actual result reveals a gap. [Compaction Reference](https://pi.dev/docs/latest/compaction)

**Failure localization:** no compactable material → misleading suggestion problem; canceled summary → failed/canceled operation, not success; stale branch context → state reconstruction problem; missing required decision → result quality problem. Historical Context Expert fixes provide hypotheses, not proof of the new runtime path. Universal Jev iterations and automatically emitted rules remain excluded formulations.

**Discriminating observation:** use short/long sessions plus a fact that must remain usable after compaction. Evaluate accepted output and rework, not just tokens removed. Session accounting can include summary/tool usage, but does not establish invoice totals, subscription quota, net value, or hard budget enforcement. Caching/warming should remain optional unless measured benefit exceeds cost. [Settings](https://pi.dev/docs/latest/settings), [RPC Commands](https://pi.dev/docs/latest/rpc-commands)

### 5.5 Provider resilience: selection, actual dispatch and effect boundaries

**Related:** INT-042–049; CAP-21–26, 28–29, 34; H5, H7, H13–14, H19–20.

```text
authorized eligible provider + model selection
  -> actual physical request with observable identity
  -> success OR classified transport/quota/context/auth failure
  -> permitted bounded retry/router decision OR final visible failure
  -> reconcile any tool or external effect before replaying work
  -> report actual dispatch, attempts, usage and unknown account state
```

Native model selection and provider authentication reduce the need for duplicated private integrations. They do not prove service availability or account quota. Virtual models supply programmable per-request routing; selected logical identity and physical dispatch are separate. Retry-route switching must be deliberate router logic, not an assumed blanket quota failover. [Models](https://pi.dev/docs/latest/models), [Providers](https://pi.dev/docs/latest/providers), [Virtual Models](https://pi.dev/docs/latest/virtual-models)

**Failure localization:** no credentials → readiness/auth; incompatible endpoint → request contract; recognized overflow → context recovery; transient provider failure → bounded retry; exhausted quota → external eligibility/availability; tool effects before failure → reconciliation. The scoped native retry defaults are three agent retries apart from the initial request, with provider retries defaulting to zero; the exact consuming configuration still needs inspection. [Settings](https://pi.dev/docs/latest/settings)

**Discriminating observation:** deterministic fake-provider failures can establish retry counts and route identity without real account/credential access. Include an effect after which blind replay must be refused. MCP tool calls are not automatically retried by its integration; Codemode script failure also does not roll back prior tool effects. These different semantics must remain visible in any later chosen path. [MCP](https://pi.dev/docs/latest/mcp), [Codemode](https://pi.dev/docs/latest/codemode)

No provider winner, unrestricted sensitivity routing, subscription entitlement, duplicate-effect guarantee, custom provider, or global fallback group is selected here.

### 5.6 Image-contained Pi tests: the user's subject stays Pi

**Related:** INT-013, 047–049, 051, 053, 056–059, 065; CAP-08, 15–16, 35, 38–42; H2, H14, H17–18, H23.

```text
chosen Pi suite/source and expected verdict + bounded engine authority
  -> explicitly identified image and test inputs
  -> launcher starts the selected test process INSIDE that image
  -> independent observation establishes process location and target identity
  -> runner collects pass/fail/timeout/abort plus sanitized evidence
  -> exact owned image/process/output resources are cleaned and verified
```

Packages distribute reusable resources; native shell execution or a public extension command/tool can invoke a chosen external runner. These means support a **candidate**, not an already implemented image-testing package. The installed `test: vitest --run` script is not a selection or guarantee of an executable upstream source suite in the distribution. CAP-42 identifies the need for the appropriate source/dependency/build environment. [Pi Packages](https://pi.dev/docs/latest/packages), [CLI Integration](https://pi.dev/docs/latest/cli-integration), capability catalogue CAP-40/CAP-42

There are two different propositions, not an automatic architecture choice:

- **Tests inside an image:** a host Pi command can launch that test environment. This meets the proposed location only if the real test process is independently verified there; the launcher/Pi/extensions on the host remain outside that boundary.
- **Whole Pi process inside isolation:** Pi and its extensions/tools are inside the selected external boundary. This is relevant if the chosen result also requires isolating the agent runtime, not merely its tests.

Tool-only isolation is narrower and does not establish either proposition for every custom extension. Writable mounts, supplied environment, credentials and reachable services can still expand effective access. A different working directory or successful `pwd` output is not comprehensive containment evidence. [Containerization](https://pi.dev/docs/latest/containerization), [Run Pi Safely](https://pi.dev/docs/latest/security)

**Unresolved decisions:** exact upstream suite/entrypoint and source revision; test fixtures/dependencies/build; image/engine/version identity; trusted launcher and engine access; read/write mounts; provider/network needs; lifecycle/cancellation; sanitized output schema; retained evidence and exact cleanup. Some suites may need provider access; this cannot be assumed for all tests or inferred from the script name. No test subject is silently replaced with A4S behavior tests.

**Proposed discriminating checks — all NOT RUN:**

| Observation | Pass condition for a future selected experiment | Failure/inconclusive boundary |
|---|---|---|
| Pi identity | Actual source/distribution under test matches the selected contract; image identity and effective resources are recorded. | Floating latest label or host/global/modified Pi stands in for the chosen target. |
| Real execution location | A process/location observation independent of launcher claims proves the selected Pi tests execute inside the image. | Image starts but the actual suite runs on the host, or there is no selected suite. |
| Failing fixture | An intentional known failure reaches a failed verdict with relevant sanitized evidence. | Launcher success/exit zero is reported as suite success. |
| Access denial | Required forbidden fixture paths/services remain inaccessible at the selected boundary. | A mount, extension, environment or fallback escapes the intended test boundary. |
| Timeout/abort | Report is distinct from pass; partial effects are visible and owned processes are terminated. | Canceled test silently retries/runs on host, leaves unknown effects or orphaned jobs. |
| Evidence and cleanup | Durable verdict/source identity survive; only exactly owned disposable resources are removed with verified postconditions. | Retained evidence is erased, unrelated resources are swept, or cleanup success is merely asserted. |

A one-off explicit command could be enough to prove the material unknown. A reusable package would add a stable invocation, diagnostics and lifecycle maintenance burden and needs a demonstrated recurring benefit. That tradeoff is for a later chosen result, with G-09's PoC tension named if material. No runner code, Dockerfile, image build, provider call or runtime experiment occurred here.

### 5.7 Native presentation: exact API gap, not abstract impossibility

**Related:** INT-031, 060–061, 065; CAP-03, 08, 16, 31–32, 41; H4, H9, H16, H18, H22.

```text
native settings selection / shortcut
  -> same persisted preference handle
  -> transcript presentation policy receives the density
  -> live invalidation and restart restore the intended display
  -> underlying history/evidence remains independently available
```

This is the exact A4S candidate's desired path, not a documented complete public Pi path. Its [fixed-baseline README](../../../packages/pi-tool-row-presentation/README.md) states that it is pre-release and blocked by two unpublished ports. The inspected installed public declarations contain `ExtensionAPI`, `registerTool` and `registerCommand`, but neither `registerSetting` nor `registerTranscriptPresentationPolicy`. The public extension guide does not establish equivalent generic ports. This bounded negative declaration check refutes **compatibility of that exact candidate with that inspected contract**, not all possible future presentation mechanisms. [Extensions](https://pi.dev/docs/latest/extensions)

**Failure localization:** absent setting registration → dependency/API gap, not an adoption gate that tests can fake away; absent transcript-policy port → presentation integration gap; in-memory structural tests → limited contract evidence; modified local Pi E2E → evidence about a different artifact. Candidate code being integrated in A4S is distinct from being released/loadable in published Pi.

**Do not force equivalence:** a custom dialog or revived slash command could expose some preference, but would change the requested native UX. Native UI components and RPC dialogs also have different mode contracts; `hasUI` does not promise custom TUI rendering in RPC, and headless modes have no UI. [Terminal UI](https://pi.dev/docs/latest/tui), [RPC Extension UI](https://pi.dev/docs/latest/rpc-extension-ui)

**Decision boundary:** defer the exact candidate until a compatible public contract is evidenced; or explicitly choose a narrower/different UX with its tradeoff; or omit the capability if the benefit is insufficient. This research chooses none, patches neither Pi nor A4S, and does not invent a future version. Hiding rows is presentation, not secure redaction or history deletion.

## 6. Inverse capability-relevance ledger

Every catalogue entry is considered below. The links back to intentions are generated from section 4's actual relationships, not invented demand. A listed relationship may be partial, optional, a rejected historical means, or a contract-gap investigation. It does not make the feature necessary. Where no intention requires an additional feature, leave it unselected instead of generating a new requirement to use it.

| Capability | Crosswalk relationships | Relevance and non-requirement boundary |
|---|---|---|
| [CAP-01 — Entrypoints and output modes](2026-10-02-pi-handbook-capabilities.md#cap-01--entrypoints-and-output-modes) | [INT-001](#int-001), [INT-005](#int-005), [INT-051](#int-051), [INT-053](#int-053) | Core entry means for bounded work. Choose one consuming mode for a result, not every launch surface or Codex binary family. |
| [CAP-02 — Runtime location, environment, and platform setup](2026-10-02-pi-handbook-capabilities.md#cap-02--runtime-location-environment-and-platform-setup) | [INT-004](#int-004), [INT-043](#int-043), [INT-065](#int-065), [INT-066](#int-066) | Relevant to known runtime/location/config identity. OS bootstrap parity and support for every platform are not required by these intentions. |
| [CAP-03 — Layered settings and resource discovery](2026-10-02-pi-handbook-capabilities.md#cap-03--layered-settings-and-resource-discovery) | [INT-004](#int-004), [INT-010](#int-010), [INT-031](#int-031), [INT-060](#int-060), [INT-065](#int-065), [INT-066](#int-066) | Relevant to effective resources and persisted native preferences. Configuration layering is not enforcement or generic custom-settings registration. |
| [CAP-04 — Project-resource trust](2026-10-02-pi-handbook-capabilities.md#cap-04--project-resource-trust) | [INT-013](#int-013) | Relevant to preventing silent project-resource loading. Project trust is not a sandbox, effect approval, or complete startup boundary. |
| [CAP-05 — System prompts and global/ancestor context](2026-10-02-pi-handbook-capabilities.md#cap-05--system-prompts-and-globalancestor-context) | [INT-010](#int-010), [INT-063](#int-063) | Relevant to current governing instruction inputs and clear context. Loading global/ancestor/project instructions is not proof they agree or are obeyed. |
| [CAP-06 — On-demand skills](2026-10-02-pi-handbook-capabilities.md#cap-06--on-demand-skills) | [INT-007](#int-007), [INT-008](#int-008), [INT-010](#int-010), [INT-014](#int-014), [INT-020](#int-020), [INT-021](#int-021), [INT-026](#int-026), [INT-035](#int-035), [INT-062](#int-062), [INT-063](#int-063), [INT-064](#int-064) | Useful reusable instruction mechanism. No universal skill stack, always-on ceremony or automatic policy activation follows. |
| [CAP-07 — Reusable prompt templates](2026-10-02-pi-handbook-capabilities.md#cap-07--reusable-prompt-templates) | [INT-010](#int-010), [INT-011](#int-011), [INT-014](#int-014), [INT-017](#int-017), [INT-018](#int-018), [INT-020](#int-020), [INT-021](#int-021), [INT-062](#int-062), [INT-063](#int-063), [INT-064](#int-064), [INT-068](#int-068) | Optional concise invocation/intake/presentation aid. Templates expand text, not authorization or durable task transitions. |
| [CAP-08 — Package distribution and host dependencies](2026-10-02-pi-handbook-capabilities.md#cap-08--package-distribution-and-host-dependencies) | [INT-004](#int-004), [INT-007](#int-007), [INT-008](#int-008), [INT-059](#int-059), [INT-060](#int-060), [INT-064](#int-064), [INT-065](#int-065), [INT-066](#int-066) | Relevant if a reusable package is chosen and its public dependencies are real. Distribution does not make a blocked candidate compatible. |
| [CAP-09 — In-process SDK](2026-10-02-pi-handbook-capabilities.md#cap-09--in-process-sdk) | [INT-001](#int-001), [INT-005](#int-005), [INT-006](#int-006), [INT-012](#int-012), [INT-015](#int-015), [INT-024](#int-024), [INT-026](#int-026), [INT-038](#int-038), [INT-039](#int-039), [INT-040](#int-040), [INT-045](#int-045), [INT-051](#int-051), [INT-053](#int-053), [INT-058](#int-058), [INT-064](#int-064), [INT-065](#int-065) | Possible in-process integration for controlled sessions/fixtures. An SDK host adds responsibility and is not mandatory when native CLI suffices. |
| [CAP-10 — Subprocess RPC control](2026-10-02-pi-handbook-capabilities.md#cap-10--subprocess-rpc-control) | [INT-001](#int-001), [INT-005](#int-005), [INT-006](#int-006), [INT-012](#int-012), [INT-015](#int-015), [INT-024](#int-024), [INT-026](#int-026), [INT-038](#int-038), [INT-039](#int-039), [INT-040](#int-040), [INT-045](#int-045), [INT-051](#int-051), [INT-053](#int-053), [INT-058](#int-058), [INT-065](#int-065) | Possible language-independent subprocess control. Protocol framing/deadlines/cancellation become caller responsibilities; no custom controller is thereby required. |
| [CAP-11 — Streamed run, tool, and retry events](2026-10-02-pi-handbook-capabilities.md#cap-11--streamed-run-tool-and-retry-events) | [INT-001](#int-001), [INT-003](#int-003), [INT-006](#int-006), [INT-022](#int-022), [INT-032](#int-032), [INT-034](#int-034), [INT-037](#int-037), [INT-041](#int-041), [INT-043](#int-043), [INT-049](#int-049), [INT-050](#int-050), [INT-055](#int-055), [INT-061](#int-061), [INT-067](#int-067), [INT-068](#int-068) | Direct runtime progress evidence. Preserve runtime states separately from accepted task results and value. |
| [CAP-12 — Native persistence and context projection](2026-10-02-pi-handbook-capabilities.md#cap-12--native-persistence-and-context-projection) | [INT-002](#int-002), [INT-016](#int-016), [INT-017](#int-017), [INT-019](#int-019), [INT-025](#int-025), [INT-027](#int-027), [INT-033](#int-033), [INT-035](#int-035), [INT-036](#int-036), [INT-041](#int-041), [INT-056](#int-056), [INT-061](#int-061) | Conversation tree/history is relevant to continuity and context. Not an accepted-work ledger or crash-safe task ownership proof. |
| [CAP-13 — Resume, navigation, fork, clone, and state queries](2026-10-02-pi-handbook-capabilities.md#cap-13--resume-navigation-fork-clone-and-state-queries) | [INT-002](#int-002), [INT-003](#int-003), [INT-016](#int-016), [INT-022](#int-022), [INT-025](#int-025), [INT-027](#int-027), [INT-028](#int-028), [INT-030](#int-030), [INT-055](#int-055) | Native resume/query/branch navigation fits conversational inspection. Forking conversation is not delegation, exclusive ownership or Git isolation. |
| [CAP-14 — Steering, follow-up, queues, and interruption](2026-10-02-pi-handbook-capabilities.md#cap-14--steering-follow-up-queues-and-interruption) | [INT-012](#int-012), [INT-024](#int-024), [INT-025](#int-025), [INT-026](#int-026), [INT-027](#int-027), [INT-032](#int-032), [INT-037](#int-037), [INT-044](#int-044), [INT-049](#int-049), [INT-057](#int-057) | Native queues/steering/interruption are relevant to controlled runs. They are not crash-recoverable backlog selection or exactly-once work acknowledgement. |
| [CAP-15 — Built-in file and shell operations](2026-10-02-pi-handbook-capabilities.md#cap-15--built-in-file-and-shell-operations) | [INT-001](#int-001), [INT-011](#int-011), [INT-013](#int-013), [INT-017](#int-017), [INT-019](#int-019), [INT-020](#int-020), [INT-021](#int-021), [INT-023](#int-023), [INT-028](#int-028), [INT-036](#int-036), [INT-038](#int-038), [INT-041](#int-041), [INT-052](#int-052), [INT-054](#int-054), [INT-055](#int-055), [INT-056](#int-056), [INT-057](#int-057), [INT-059](#int-059), [INT-062](#int-062), [INT-066](#int-066), [INT-068](#int-068) | Basic means to inspect/change authorized files and invoke existing external tools. Generic shell reachability does not fulfill those tools' contracts. |
| [CAP-16 — Executable extension registration](2026-10-02-pi-handbook-capabilities.md#cap-16--executable-extension-registration) | [INT-007](#int-007), [INT-051](#int-051), [INT-059](#int-059), [INT-060](#int-060), [INT-061](#int-061), [INT-064](#int-064) | Candidate extension surface for demonstrated gaps. No entitlement to retain old hooks, fake absent APIs or start an unnecessary daemon. |
| [CAP-17 — Tool mediation, exposure, and nested calls](2026-10-02-pi-handbook-capabilities.md#cap-17--tool-mediation-exposure-and-nested-calls) | [INT-011](#int-011), [INT-013](#int-013), [INT-014](#int-014), [INT-018](#int-018), [INT-038](#int-038), [INT-048](#int-048), [INT-049](#int-049) | Relevant to guarded tool behavior. Call mediation is narrower than process confinement and should not become indiscriminate approval ceremony. |
| [CAP-18 — Context transforms and branch-sensitive extension state](2026-10-02-pi-handbook-capabilities.md#cap-18--context-transforms-and-branch-sensitive-extension-state) | [INT-010](#int-010), [INT-012](#int-012), [INT-019](#int-019), [INT-024](#int-024), [INT-026](#int-026), [INT-029](#int-029), [INT-033](#int-033), [INT-035](#int-035), [INT-041](#int-041) | Possible context/branch-state customization. Native behavior first; continuation and reconstruction need guard conditions, not always-on rule/compiler machinery. |
| [CAP-19 — Compaction and branch summarization](2026-10-02-pi-handbook-capabilities.md#cap-19--compaction-and-branch-summarization) | [INT-029](#int-029), [INT-030](#int-030), [INT-031](#int-031), [INT-032](#int-032), [INT-033](#int-033) | Direct native baseline for compaction/readiness. Custom strategies require evidence of an actual remaining quality gap, not preservation by inertia. |
| [CAP-20 — History retrieval and long-term memory](2026-10-02-pi-handbook-capabilities.md#cap-20--history-retrieval-and-long-term-memory) | [INT-002](#int-002), [INT-016](#int-016), [INT-017](#int-017), [INT-028](#int-028), [INT-029](#int-029), [INT-033](#int-033), [INT-034](#int-034), [INT-035](#int-035), [INT-036](#int-036), [INT-052](#int-052), [INT-056](#int-056), [INT-067](#int-067) | Pertinent history retrieval is desired; general semantic memory remains external/unknown. No mandatory new store or historical authority resolver is selected. |
| [CAP-21 — Catalog, selection, and compatible endpoints](2026-10-02-pi-handbook-capabilities.md#cap-21--catalog-selection-and-compatible-endpoints) | [INT-005](#int-005), [INT-009](#int-009), [INT-040](#int-040), [INT-042](#int-042), [INT-043](#int-043), [INT-044](#int-044), [INT-045](#int-045), [INT-046](#int-046), [INT-048](#int-048) | Native model/provider selection fits runtime use. Catalogue visibility does not prove current account entitlement, availability or admissible input. |
| [CAP-22 — Provider authentication and credential resolution](2026-10-02-pi-handbook-capabilities.md#cap-22--provider-authentication-and-credential-resolution) | [INT-042](#int-042), [INT-046](#int-046), [INT-047](#int-047) | Native provider credential resolution is relevant. Other-service SOPS/age and live-effect permission remain external policy/control responsibilities. |
| [CAP-23 — Custom providers and stream normalization](2026-10-02-pi-handbook-capabilities.md#cap-23--custom-providers-and-stream-normalization) | [INT-046](#int-046) | Conditional only for a demonstrated unsupported protocol. A duplicate private provider is not desired; do not build one to use this API. |
| [CAP-24 — Virtual-model routing](2026-10-02-pi-handbook-capabilities.md#cap-24--virtual-model-routing) | [INT-043](#int-043), [INT-044](#int-044), [INT-048](#int-048) | Optional programmable routing for a selected recovery/identity need. A routing hook is neither adopted policy nor blanket quota fallback. |
| [CAP-25 — Retry and context-overflow recovery](2026-10-02-pi-handbook-capabilities.md#cap-25--retry-and-context-overflow-recovery) | [INT-032](#int-032), [INT-044](#int-044), [INT-049](#int-049) | Native bounded transient/overflow recovery is relevant. Exactly-once tools, cross-provider fallback and renewed live authorization are separate. |
| [CAP-26 — Classifier and image-model operations](2026-10-02-pi-handbook-capabilities.md#cap-26--classifier-and-image-model-operations) | [INT-009](#int-009), [INT-018](#int-018), [INT-034](#int-034), [INT-035](#int-035), [INT-045](#int-045), [INT-046](#int-046), [INT-067](#int-067) | Classifier branch may support decision/pattern research. Universal Jev authority is excluded; no corresponding image-generation desire was identified here. |
| [CAP-27 — Prompt caching and warming](2026-10-02-pi-handbook-capabilities.md#cap-27--prompt-caching-and-warming) | [INT-029](#int-029) | Optional context/cost optimization adjunct. Do not enable cache warming or promise savings without relevant measurements and provider evidence. |
| [CAP-28 — Session usage and cost, not account billing](2026-10-02-pi-handbook-capabilities.md#cap-28--session-usage-and-cost-not-account-billing) | [INT-029](#int-029), [INT-030](#int-030), [INT-034](#int-034), [INT-043](#int-043), [INT-045](#int-045), [INT-050](#int-050), [INT-058](#int-058), [INT-067](#int-067) | Useful usage/context feedback for evidence/evaluation. Not billing, remaining quota, outcome value or a complete hard-budget contract. |
| [CAP-29 — Built-in MCP integration](2026-10-02-pi-handbook-capabilities.md#cap-29--built-in-mcp-integration) | [INT-008](#int-008), [INT-017](#int-017), [INT-019](#int-019), [INT-021](#int-021), [INT-023](#int-023), [INT-028](#int-028), [INT-036](#int-036), [INT-041](#int-041), [INT-044](#int-044), [INT-047](#int-047), [INT-048](#int-048), [INT-052](#int-052), [INT-054](#int-054), [INT-064](#int-064) | Optional bridge to existing external tools/resources. Its existence creates no demand for more servers, Apps rendering or a new task system. |
| [CAP-30 — Codemode orchestration and scoped storage](2026-10-02-pi-handbook-capabilities.md#cap-30--codemode-orchestration-and-scoped-storage) | None required by this crosswalk | No additional Codemode-specific intention selected. Optional tool composition may help a later path; its VM is not host isolation or transactional rollback. |
| [CAP-31 — Terminal UI and RPC interaction](2026-10-02-pi-handbook-capabilities.md#cap-31--terminal-ui-and-rpc-interaction) | [INT-003](#int-003), [INT-011](#int-011), [INT-021](#int-021), [INT-022](#int-022), [INT-031](#int-031), [INT-037](#int-037), [INT-060](#int-060), [INT-061](#int-061), [INT-062](#int-062), [INT-068](#int-068) | Relevant to factual status and bounded presentation. Mode-specific UI does not resolve native settings-port gaps or acceptance semantics. |
| [CAP-32 — Themes, keybindings, and terminal capabilities](2026-10-02-pi-handbook-capabilities.md#cap-32--themes-keybindings-and-terminal-capabilities) | [INT-061](#int-061) | Shortcut/terminal behavior may be relevant to presentation. No explicit new theme, terminal fleet or multiplexer scheduler is desired. |
| [CAP-33 — Export, share, diagnostics, and feedback](2026-10-02-pi-handbook-capabilities.md#cap-33--export-share-diagnostics-and-feedback) | [INT-034](#int-034), [INT-050](#int-050), [INT-056](#int-056), [INT-067](#int-067) | Optional diagnostic/evidence inputs, with privacy/publication limits. Sharing/upload is not required; raw transcript retention is not default evidence. |
| [CAP-34 — Network transport and provider/client support](2026-10-02-pi-handbook-capabilities.md#cap-34--network-transport-and-providerclient-support) | [INT-042](#int-042), [INT-048](#int-048) | Relevant provider connectivity substrate. Transport configuration/offline startup is not a network authorization boundary or general remote-execution relay. |
| [CAP-35 — Orderly session/runtime shutdown](2026-10-02-pi-handbook-capabilities.md#cap-35--orderly-sessionruntime-shutdown) | [INT-027](#int-027), [INT-032](#int-032), [INT-049](#int-049), [INT-055](#int-055), [INT-057](#int-057), [INT-059](#int-059) | Relevant to orderly run/resource disposal. Not complete abrupt-exit recovery, transactional effect cleanup or exact Git ownership verification. |
| [CAP-36 — Delegation and background work](2026-10-02-pi-handbook-capabilities.md#cap-36--delegation-and-background-work) | [INT-003](#int-003), [INT-015](#int-015), [INT-037](#int-037), [INT-038](#int-038), [INT-039](#int-039), [INT-040](#int-040), [INT-041](#int-041) | Possible bounded delegation construction. No native managed-supervision contract established; direct work remains valid and always-delegate is excluded. |
| [CAP-37 — Goals, durable schedules, and autonomous acceptance](2026-10-02-pi-handbook-capabilities.md#cap-37--goals-durable-schedules-and-autonomous-acceptance) | [INT-002](#int-002), [INT-003](#int-003), [INT-012](#int-012), [INT-023](#int-023), [INT-024](#int-024), [INT-025](#int-025), [INT-026](#int-026), [INT-027](#int-027), [INT-037](#int-037) | Strong durable jobs/ownership/attention intentions expose a scope gap. Concrete Pi Durable/external contracts remain unknown; do not fill it with a speculative controller. |
| [CAP-38 — Whole-process container/VM isolation](2026-10-02-pi-handbook-capabilities.md#cap-38--whole-process-containervm-isolation) | [INT-004](#int-004), [INT-013](#int-013), [INT-047](#int-047), [INT-048](#int-048), [INT-051](#int-051), [INT-053](#int-053), [INT-057](#int-057), [INT-058](#int-058), [INT-059](#int-059) | Relevant when isolating the whole test/runtime process is chosen. External environment must enforce the access boundary; cwd and mounts alone do not prove safety. |
| [CAP-39 — Tool-only isolation and remote execution adaptation](2026-10-02-pi-handbook-capabilities.md#cap-39--tool-only-isolation-and-remote-execution-adaptation) | [INT-013](#int-013) | A narrower optional tool-execution boundary. It is not selected as a substitute for tests inside an image or whole-Pi containment. |
| [CAP-40 — Proposed package that starts an image and runs tests inside it](2026-10-02-pi-handbook-capabilities.md#cap-40--proposed-package-that-starts-an-image-and-runs-tests-inside-it) | [INT-053](#int-053), [INT-057](#int-057), [INT-059](#int-059) | Directly corresponds to the user's proposed image-test package, as proposal only. Need actual Pi suite, location, failure/abort and cleanup observations. |
| [CAP-41 — Shared message/types and reusable UI/utilities](2026-10-02-pi-handbook-capabilities.md#cap-41--shared-messagetypes-and-reusable-uiutilities) | [INT-006](#int-006), [INT-060](#int-060), [INT-061](#int-061), [INT-065](#int-065) | Public types/UI contracts support identity and compatibility checks. No demand for a new protobuf/codegen framework or one package per Handbook utility group. |
| [CAP-42 — Developer verification and Pi-core regression suites](2026-10-02-pi-handbook-capabilities.md#cap-42--developer-verification-and-pi-core-regression-suites) | [INT-014](#int-014), [INT-051](#int-051), [INT-053](#int-053), [INT-058](#int-058), [INT-059](#int-059), [INT-065](#int-065) | Relevant to the proposed subject: Pi's tests. Establish source/suite/build/entrypoint; A4S tests and structural extension fakes are different checks. |

## 7. Non-matches, future decisions, and supported selection boundary

### 7.1 Do not force these correspondences

| Tempting correspondence | Why it fails or changes the outcome | Appropriate disposition in this research |
|---|---|---|
| Every intention becomes one component | Desired outcomes span runtime, process, tools and human acceptance; many share the same native behavior. | Account for the intent, not a package count. Add nothing without selected need and evidence. |
| Every Handbook stage becomes a Pi feature | The Codex map includes product/internal responsibilities not demanded by A4S. Methodological coverage is not required architectural parity. | Use relevant responsibilities; inherit the catalogue's 23-stage review without recreating Codex internals. |
| Handbook is A4S governance | It describes/localizes responsibility; it does not authorize mutations, choose evidence retention or amend config. | Keep method, runtime means and adopted policy separate. |
| Persisted conversation becomes durable execution authority | Session tree, live queue, task ownership, effects and acceptance have different owners and failure semantics. | Narrow continuity claim or defer the stronger outcome until a concrete contract is evidenced. |
| Loaded instructions become guaranteed compliance | Prompts/skills can conflict or be ignored; trusted extension code and tools can operate outside a textual policy. | Inspect effective steering and prove the selected behavior; apply an actual access boundary where needed. |
| `agent_settled` or worker DONE becomes task success | Neither verifies accepted result, integration, value or cleanup. | Treat as runtime observation only. |
| Classifier confidence becomes human choice | The score is advice, not authority; historical universal Jev wording conflicts with the current chosen-result boundary. | Keep optional decision support; exclude universal authority. |
| Automatically mined rules become current policy | Discovery and proposal are not adoption; stale source or branch state can inject contradictory instructions. | Keep sourced learning reviewable and unactivated until explicit normative change. |
| Fork becomes isolated multi-agent work | Conversation branching establishes neither Git writer separation nor child supervision and recovery. | Construct only a selected bounded delegation path, with explicit ownership; otherwise work directly. |
| Package launch proves isolated tests | Engine exit/launcher text does not prove actual suite location, target identity or denial/cleanup. Host launcher may remain outside the boundary. | Independently observe tests inside the chosen image; do not silently substitute test subjects. |
| Generic UI fulfills exact native settings/transcript ports | The candidate needs specific missing public APIs; custom dialog/command changes the requested UX. | Exact candidate currently blocked; defer, explicitly reformulate or omit. Do not patch private runtime merely to fill the matrix. |
| Native retry equals cross-provider quota resilience | Provider readiness/quota, route logic and effects need different evidence; replay can duplicate paid work or mutations. | Use bounded native behavior first; only selected proven recovery logic may be added. |
| Session cost/CI green proves useful value | Accounting and regression checks cover their own contracts, not usefulness or actual runtime activation. | Require relevant consuming outcome and independent acceptance evidence. |

Rejecting an exact formulation or current candidate **does not mandate deletion**, nor imply that an unrelated desired outcome is impossible. The phrase “if it cannot transfer, perhaps it should not exist” is a selection discipline: do not force a path. Unknowns can remain unresolved if they are unnecessary to the selected result.

### 7.2 Decisions still open, not automatically actionable backlog

1. **First useful result and acceptance:** select the actual outcome before deciding which subset of intentions matters. A bounded assignment and a contextual query are plausible discriminator shapes, not two new adopted components or an authorized experiment here.
2. **Recovery strength:** conversation continuity can use native sessions; stronger durable ownership/scheduling requires a concrete result and evidenced external/Pi contract. If not needed, omit it rather than implement a controller.
3. **Image test boundary and subject:** keep Pi tests inside the image as proposed. Choose source/suite and whether only tests or also the whole agent runtime must be confined. A host launcher does not automatically confine host Pi.
4. **Exact native UX:** missing public ports block the current candidate. Waiting preserves requested UX but delays benefit; choosing a different surface changes UX and adds maintenance; omission sacrifices the optional benefit. No alternative is adopted here.
5. **Policy tensions and future changes:** current G-09 PoC wording is unresolved; provider sensitivity/eligibility and autonomous ownership semantics are also not a fully adopted future policy. Present necessary changes as bounded proposals when a chosen result depends on them, without freezing today’s entire governance or silently bypassing it.
6. **Cutover:** neither new-repository location nor timing is resolved by this crosswalk. A4S remains the project, Pi the runtime. A later cutover needs an explicitly chosen base, effective input set, access boundary and observable acceptance. Research completion is not the cutover signal.

These are decision boundaries, not tasks created from findings. This report adds no ADR, migration, package, controller, test runner or new normative control.

### 7.3 A small selection test, not an implementation plan

For any later proposed atomic function, ask:

- Which coherent desirable outcome is selected, and what result would make the operator say it helped?
- What native or already existing external means can satisfy that result directly?
- Where does documentary evidence stop: exact contract/version, state owner, failure, access, acceptance?
- Is the remaining gap a genuine reusable behavior, a policy decision, an external contract, an irrelevant historical mechanism, or an unknown that can be left out?
- What smallest permitted observation would refute the claimed fit? What evidence would establish the result in the consuming runtime?

If the direct path works, add no wrapper. If a material gap remains and a public extension contract fits, propose a bounded addition with its ownership and maintenance cost. If the path is inconsistent, incompatible with the chosen constraint, or has no sufficient evidence, reformulate, defer or omit it; **do not build compatibility infrastructure merely to make the table complete**.

## 8. Validation and limitations

### 8.1 Research acceptance checks

Validation concerns this documentary artifact only. Operational checks in sections 4–5 remain **NOT RUN**. Repository CI, if passing on the PR, verifies its own repository suite; it does not execute the proposed Pi image tests or establish runtime fit.

- Gapless 68 intention records, each with source outcome/currentness, CAP/Handbook path, explicit fit/owner, governance reference and an unrun proposed check.
- All 42 catalogue entries considered in the inverse ledger; no requirement invented merely to exercise an available feature.
- Cross-reference coverage, duplicate/missing identifier detection, local link/anchor checks and public source reachability checks.
- Input file hashes/config baseline rechecked; exact candidate mismatch compared with installed public declarations.
- Rootline consultation/query/validation, whitespace, sanitized secret-pattern scan and bounded Git diff review.
- No code/config mutation, package activation, Pi/model/container execution or related-repository mutation.

Rootline's inherited `.workspace/docs/.stem` currently supplies no research schema or validation rules. A successful Rootline result demonstrates parse/access and no configured-rule violations; **it does not prove semantic completeness, source truth, technical compatibility or operator acceptance**. Manual structure/source/diff review supplies the additional documentary checks. Final observed results and PR/CI identity belong to task `a4s-kx5`, linked to this versioned artifact; they must not be inferred from this checklist.

### 8.2 Limits that remain material

- The intentions inventory is historical/lexical and attribution-bounded, not a census of authenticated wishes or proof of present adoption. No new saturation claim is made.
- Public documentation is a version-sensitive declared contract. Only the named installed declaration comparison provides additional exact-candidate negative evidence; installed metadata is not public-release attestation.
- Full Pi implementation tracing, crash consistency, account/provider eligibility, durable jobs and acceptance/recovery guarantees were not tested. A scoped unknown is not an impossibility result.
- The Handbook's implementation evidence belongs to its analyzed runtimes. This document uses its method but does not transplant Codex code claims to Pi or claim a complete generated Pi L3 map.
- Strong isolation depends on the actually selected external boundary, permissions, mounts, network and credentials. No image or launcher proof exists here.
- Historical A4S unit/fake/modified-runtime results cannot prove published Pi support or operator value. The current pre-release presentation candidate remains a bounded API mismatch, not a generic rejection of native UX.
- Actual utility, effort saved, cost reduction and accepted multi-repository results need later selected observations. Research integration itself is not product capability delivery.

**Conclusion:** use the two inventories as evidence inputs, the Handbook as the behavior/responsibility method, Pi as the selected runtime substrate, and explicit governance as the authority/evidence boundary. Choose a small useful outcome and prove its direct path before adding code. Keep incompatible formulations out and unnecessary unknowns unresolved rather than manufacturing a large harness to satisfy the inventory.
