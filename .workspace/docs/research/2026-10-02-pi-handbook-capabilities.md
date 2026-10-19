---
title: "Documented Pi capabilities across Harness Handbook responsibilities"
type: research
status: documentary-catalogue-not-adopted
date: "2026-10-02"
language: en
project: A4S
runtime: Pi
baseline: 494a7ffe1b8e91dd3416986a2353cd6af7e366eb
installed_package: "@earendil-works/pi-coding-agent"
installed_version: "1.0.0"
public_documentation: "https://pi.dev/docs/latest"
documentation_accessed: "2026-10-02"
runtime_tests: not-run
cutover_authorization: none
normative_authority: ".workspace/config.yaml on integrated main"
---

# Documented Pi capabilities across Harness Handbook responsibilities

## 1. Question, scope, and evidence boundary

**Question:** Which publicly documented Pi capabilities can perform, expose, or support the responsibilities in the Harness Handbook, and where does the documented correspondence stop?

This is an independent capability catalogue, not an inventory of A4S intentions. Read it beside the [independent A4S intentions inventory](2026-10-02-a4s-intentions-inventory.md); the pair is not a completed intention-by-capability mapping. A Pi feature does not establish that A4S needs it. A4S remains the project/repository; Pi is the runtime being studied. Codex is a comparative responsibility map, **not the selected runtime or an architecture to reproduce**. Nothing here authorizes a cutover, retains the old harness by default, selects a package, or establishes operational delivery.

The user proposal is an additional Pi package that **starts an image and runs Pi's tests inside that image**. It remains a proposal; the exact Pi suite and entrypoint have not been selected. A4S behavior tests and runner integration tests are different subjects and possible additional controls, not selected substitutes for Pi's tests.

### Method: preserve behavior, interface, and evidence separately

The Handbook's L1 follows the system flow; L2 groups coherent responsibilities and their inputs, outputs, dependencies, and state; L3 localizes triggers, transitions, failures, and implementation evidence. Its reported evaluation concerns localization/planning, not proof of successful implementation or delivered value. This document uses that organization without claiming a generated Pi code-evidence handbook. [Harness Handbook methodology](https://ruhan-wang.github.io/Harness-Handbook/)

For this documentary inquiry:

1. Establish Pi's documented request/session lifecycle (L1).
2. Catalogue public interfaces by responsibility, retaining distinct triggers, state owners, and limitations (L2).
3. Record decisive documented behavior and proposed falsification checks (documentary L3). Public documentation is sufficient for **documented correspondence**. Execution or a targeted implementation trace would be needed for a later operational/security guarantee; a blanket source audit is not a prerequisite for this catalogue.
4. Cover all 23 top-level Handbook stages, including internal and cross-cutting responsibilities. Stage numbers are navigation, not an implementation sequence.
5. Leave incompatible or undocumented correspondence absent/unknown. Do not fabricate an extension API or make every cell an adopted component.

**Evidence classes:** public documentation; installed package metadata/bundled documentation; research inference; proposed check **NOT RUN**. No Pi session, model request, container, package installation, credential resolution, or runtime test was started. No private transcripts or secrets were inspected. No Pi source-code exception was needed: the local cross-check used metadata and Markdown documentation only.

### Version and provenance snapshot

| Item | Observation and boundary |
|---|---|
| Research baseline | Worktree HEAD verified as `494a7ffe1b8e91dd3416986a2353cd6af7e366eb`; its `.workspace/config.yaml` was read. This document adds no repository norm. |
| Installed Pi | `/Users/pones/.local/lib/node_modules/@earendil-works/pi-coding-agent/package.json`: package version `1.0.0`, Node engine `>=22.19.0`, CLI bin `dist/bundle/cli.js`, public package entry `dist/index.js`. This is a metadata observation, not a successful startup. |
| Bundled documentation | `/Users/pones/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/`; `docs.json` lists 40 navigation pages. The relevant contracts were cross-checked in those files. |
| Public documentation | `pi.dev/docs/latest` and its linked reference/guide pages were consulted on 2026-10-02. `latest` is moving, not a commit pin; pages display “Latest.” Shared names/semantics do not prove the installed binary equals online `main`. |
| Source boundary | Public guides and references, plus the Handbook root/index and all 23 English top-level stage introductions. No social posts or marketing announcements serve as API evidence. |
| Pi Durable | The public navigation includes a Pi Durable announcement banner, but the studied CLI/SDK/RPC reference set does not establish a Durable scheduling/delegation contract. Its capabilities are **unknown/outside this catalogue**, not silently classified as absent from all Pi products. [Documentation scope](https://pi.dev/docs/latest) |

Selected local SHA-256 fingerprints make the cheap version cross-check reproducible; they are not upstream release attestation:

| Local file under the installed package | SHA-256 |
|---|---|
| `package.json` | `81ac04bbcbc8d80bdb28bcb88cabe8345ffabc6b4c9389fd74c85fab76a0aac6` |
| `docs/cli.md` | `f634d79780f8f5b650f5462da38ad7466aace3ef3fbe0dd0731cda2b6f6e897d` |
| `docs/rpc-commands.md` | `4deeee367852f4633ef594bc079f9e9fb14640a4e3ba8a69b7c89b6f54740838` |
| `docs/sdk.md` | `d9034ccbf2219a58712d8dd4fcdf47e687d77131e71dd5d119d8a71e9bd2a2e8` |
| `docs/extensions.md` | `26c7542e365fed7d6bd3f1d39b1ac38ef67c30ff1b714477ea49f97a3f7fde9c` |
| `docs/packages.md` | `5fe4a3009d7260fe1e2f54b64086fc3c8b4d678232bfa2dbc7e91fe588fc9ea5` |
| `docs/containerization.md` | `e309fcb9a0a7592c0dba000ef8ee90f2d7ef1e01e6a1ac2f0cd9760dd63dee0c` |

## 2. L1: Pi's documented system flow

```text
CLI / SDK / RPC input
  -> select cwd, configuration, trust, resources, credentials, model, session
  -> active-branch context + effective system prompt + tool declarations
  -> provider request / streamed assistant response
  -> tool calls / results and queued input
  -> additional turns, compaction or retry when applicable
  -> session-level settlement and visible/persisted results
  -> explicit disposal / shutdown
```

Pi's session manager owns the conversation tree; the active branch supplies subsequent history. Tool execution and extensions use the Pi process's OS permissions. Project trust gates resource loading, not all actions. This flow therefore **does not inherit Codex's approval or sandbox semantics**. [How Pi Works](https://pi.dev/docs/latest/how-pi-works)

Keep four outcomes distinct:

| Signal | What it establishes | What it does not establish |
|---|---|---|
| RPC `prompt` response with `success: true` | Input was started, queued, or handled, according to disposition. | Model work completed; tests passed; result accepted. |
| `agent_end` | One low-level run ended; `willRetry` can indicate more work. | Session is idle/settled. |
| `agent_settled` | Pi has no further automatic continuation for that session-level run. | Correctness, repository delivery, or human acceptance. |
| Test process/verdict plus operator acceptance | Separately recorded test evidence and acceptance of the requested result. | Either is inferred from a runtime event. |

These distinctions follow [RPC Mode](https://pi.dev/docs/latest/rpc) and [JSON Event Stream](https://pi.dev/docs/latest/json); the acceptance distinction is a research boundary and A4S policy, not a Pi protocol feature.

## 3. L2/L3 capability catalogue

### Classification and reading key

- **Documented:** the identified public documentation states the interface/behavior. This is not evidence that it was exercised here.
- **Operationally tested:** an actual consuming-runtime check recorded observations and a verdict; **none in this research**. Even a successful check does not itself establish operator acceptance/adoption.
- **Native:** documented CLI/core/SDK functionality, including explicitly bundled CLI extensions; this does not mean every SDK factory loads them automatically.
- **Extension:** a documented public plug-in point supports custom behavior; the behavior is not supplied or verified merely by that plug-in point.
- **External:** an external service, OS/container boundary, or host application owns the capability.
- **Absent:** the studied interface does not supply the named contract; not a claim that no third party could build it.
- **Unknown:** public evidence within scope does not settle the question.

CAP identifiers are stable within this catalogue, not an A4S registry or adopted package taxonomy. `H` refers to Handbook stages. Every proposed check below is **NOT RUN**. Runtime checks selected and authorized later should run against disposable fixtures **inside the proposed image**, rather than implicitly on the host; this does not make every catalogue check or all 23 responsibilities necessary. Exact optional flags/providers remain in the linked version-sensitive references.

### Startup, configuration, and reusable resources

#### CAP-01 — Entrypoints and output modes

**Native · H1, H8–10 ·** [CLI Integration](https://pi.dev/docs/latest/cli-integration), [Command Line](https://pi.dev/docs/latest/cli)

- **Interface/config:** `pi`, `--print`, `--mode json`, `--mode rpc`; SDK for in-process use. Prompt arguments, `@files`, and piped stdin are CLI inputs.
- **Trigger → output/state:** launch selects interactive, one-shot text/JSON, or long-lived RPC. Working directory selects project/session grouping. `--mode text` alone is not always one-shot; redirected streams normally select print behavior.
- **Limits/errors:** RPC rejects `@file`; use its prompt payload. No documented Codex app-server/daemon replacement is implied.
- **Check NOT RUN:** image entrypoint preserves argv/stdin and separates protocol stdout from stderr in each intended mode.

#### CAP-02 — Runtime location, environment, and platform setup

**Native + External · H2–3, H22 ·** [Environment Variables](https://pi.dev/docs/latest/environment-variables), [Quickstart](https://pi.dev/docs/latest/quickstart), [Windows](https://pi.dev/docs/latest/windows), [Termux](https://pi.dev/docs/latest/termux)

- **Interface/config:** `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`; CLI/RPC markers `AI_AGENT=pi`, `PI_CODING_AGENT=true`.
- **Trigger → output/state:** model-callable shell tools inject `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` per command. User `!`/`!!` commands do not receive that session injection. SDK embedding does not automatically set CLI process markers.
- **Limits/errors:** selected virtual-model identity is not physical dispatch identity. Working directory is not confinement. Android/Windows depend on their documented terminal/shell environments. OS bootstrap hardening equivalence is unknown.
- **Check NOT RUN:** image runtime version, paths, ephemeral-session metadata, and absence of stale inherited session variables.

#### CAP-03 — Layered settings and resource discovery

**Native · H3–4, H12 ·** [Configuration](https://pi.dev/docs/latest/configuration), [Settings Reference](https://pi.dev/docs/latest/settings)

- **Interface/config:** agent-directory and project `.pi/settings.json`; conventional extension/skill/prompt/theme directories and configured paths; `/settings`, `/reload`.
- **Trigger → output/state:** project settings override user settings; resource lists combine. Relative resource paths depend on the settings-file scope. CLI selections can override one invocation.
- **Limits/errors:** reload is not a universal reset of active tools. Configuration precedence is not evidence that A4S policy has been activated in a running session.
- **Check NOT RUN:** conflicting fixture settings and reload produce the expected effective resources without loading a sibling project.

#### CAP-04 — Project-resource trust

**Native, not a sandbox · H4, H14 ·** [Run Pi safely](https://pi.dev/docs/latest/security)

- **Interface/config:** `--approve`, `--no-approve`, user-level `defaultProjectTrust`, saved canonical-path decisions in `trust.json`, `/trust`, early `project_trust` handlers.
- **Trigger → output/state:** trust determines whether protected project settings/resources/packages load. Precedence is explicit override, eligible extension decision, closest saved decision, global default.
- **Limits/errors:** `sessionDir` is read before trust; context-file discovery is not trust-gated. Print/JSON/RPC cannot show the built-in trust prompt; unresolved `ask` skips protected resources. No blanket per-tool approval follows.
- **Check NOT RUN:** untrusted fixture loads neither project executable resources nor trust-gated prompt files; separately verify context loading and pre-trust session location.

#### CAP-05 — System prompts and global/ancestor context

**Native + Extension · H12 ·** [Configuration](https://pi.dev/docs/latest/configuration), [Command Line](https://pi.dev/docs/latest/cli)

- **Interface/config:** `SYSTEM.md` replaces; `APPEND_SYSTEM.md` appends. Trusted project files take precedence over same-named agent-directory files; those pairs do not merge. CLI replacement and repeatable append flags are separate controls.
- **Trigger → output/state:** context is discovered in the agent directory, cwd, and parents. `AGENTS.override.md` suppresses ordinary instruction files only in the same directory; it does not remove other ancestor/global context.
- **Limits/errors:** `--no-context-files` disables AGENTS/CLAUDE discovery, not every other system-prompt/resource input. Repository history does not automatically become authority.
- **Check NOT RUN:** nested fixture proves effective instruction provenance and separate replacement/append/no-context behavior.

#### CAP-06 — On-demand skills

**Native instructions · H12 ·** [Skills](https://pi.dev/docs/latest/skills)

- **Interface/config:** `SKILL.md` with name/description; user/project locations, `.agents/skills`, explicit paths/packages; `/skill:name`; optional `disable-model-invocation`.
- **Trigger → output/state:** startup advertises descriptions/paths; full instructions are read on demand or expanded by an explicit skill command. Bundled scripts remain ordinary executable artifacts.
- **Limits/errors:** a model may miss automatic loading. Missing descriptions/malformed files are not loaded; name collisions retain the first discovered skill with warnings. `allowed-tools` metadata is not evidence of an OS security boundary.
- **Check NOT RUN:** discovery, collision, explicit invocation, supporting-path resolution, and denied project trust in an image fixture.

#### CAP-07 — Reusable prompt templates

**Native text expansion · H10, H12 ·** [Prompt Templates](https://pi.dev/docs/latest/prompt-templates)

- **Interface/config:** Markdown prompt files, description/argument hints, positional/default/all-argument substitutions; `/template-name`.
- **Trigger → output/state:** command expansion becomes user input before agent submission. Raw input is first visible to extension input handlers unless an extension command consumes it.
- **Limits/errors:** no new executable enforcement point; project templates are trust-gated. Conventional directories discover direct Markdown children; configured paths/manifests can include nested resources.
- **Check NOT RUN:** quoted/default arguments, input interception, and template/extension command collisions.

#### CAP-08 — Package distribution and host dependencies

**Native package mechanism; package behavior may be third-party · H4, H14, H22 ·** [Pi Packages](https://pi.dev/docs/latest/packages)

- **Interface/config:** npm/git/local sources; `pi install/remove/list/config/update --extensions`; conventional resources or `package.json` `pi.extensions/skills/prompts/themes` manifest.
- **Trigger → output/state:** configured resources load after applicable trust. Versioned npm specs and selected git refs can be pinned; local paths are not copied/installed.
- **Limits/errors:** host Pi packages and `typebox` belong in `peerDependencies` with the documented `*` range, not bundled runtime copies. Duplicates can cause class/registry conflicts; local dependency trees remain the author's responsibility. Filters narrow a manifest. Gallery eligibility is not validation or native status.
- **Check NOT RUN:** pinned package loads one extension instance with declared peers and required local dependencies, without installer side effects outside its authorized directory.

### Session execution and lifecycle contracts

#### CAP-09 — In-process SDK

**Native public API · H8, H10–11, H17 ·** [SDK](https://pi.dev/docs/latest/sdk)

- **Interface/config:** `createAgentSession({ cwd, modelRuntime, settingsManager, sessionManager, resourceLoader, tools, customTools, ... })`; `prompt`, `subscribe`, `abort`, `waitForIdle`, `dispose`.
- **Trigger → output/state:** one `AgentSession` owns conversation/model/tools/queues/compaction/extensions. `SessionManager` owns finalized context; mutating the agent's message array does not replace persisted history. `AgentSessionRuntime` can replace sessions; subscriptions must be rebound.
- **Limits/errors:** concurrent prompt without steer/follow-up intent rejects. SDK does not automatically load CLI built-in MCP/Codemode/tool-search factories; their lifecycle binding must be supplied.
- **Check NOT RUN:** factory defaults/overrides, replacement subscriptions, resource binding, and disposal in a hermetic image fixture.

#### CAP-10 — Subprocess RPC control

**Native public protocol · H8, H10, H18–19 ·** [RPC Mode](https://pi.dev/docs/latest/rpc)

- **Interface/config:** `pi --mode rpc`; optional request IDs; exported `RpcClient`; stdin commands and stdout responses/events/extension UI.
- **Trigger → output/state:** asynchronous commands are correlated by ID, not response order. Prompt disposition differs from completion; handled prompts need not start a run.
- **Limits/errors:** strict LF-delimited JSON; Unicode separators inside strings are not record boundaries. Drain stdout continuously and honor backpressure. Handle parse/command errors, accepted-run provider failures, child exit, cancellation, and client deadlines separately.
- **Check NOT RUN:** concurrent IDs, handled input, LF/CRLF/Unicode framing, stderr isolation, and early process failure.

#### CAP-11 — Streamed run, tool, and retry events

**Native observability · H10, H13, H16, H20 ·** [JSON Event Stream](https://pi.dev/docs/latest/json)

- **Interface/config:** JSON mode emits a session header plus events; RPC uses the same session-event shapes without that header. Message/tool/queue/compaction/retry events provide structured progress.
- **Trigger → output/state:** wire updates are deltas; `message_end` is authoritative. Correlate tool events by `toolCallId`. `agent_end` can precede recovery/queued work; `agent_settled` marks no further automatic work.
- **Limits/errors:** SDK snapshots differ from wire deltas. Partial results depend on the tool contract; compaction/retry failures have distinct events. None is an accepted A4S outcome.
- **Check NOT RUN:** reconstruction and event order through tool errors, retry, abort, compaction, and settlement.

#### CAP-12 — Native persistence and context projection

**Native · H6, H11–12, H16, H21 ·** [Session File Format](https://pi.dev/docs/latest/session-format), [Message Types](https://pi.dev/docs/latest/message-types)

- **Interface/config:** persistent JSONL tree or in-memory manager/`--no-session`; entries with stable `id`/`parentId`; format version 3 with legacy migration.
- **Trigger → output/state:** active-branch projection applies compaction and branch-relative `context_edit`; raw entries remain. Message entries include user/assistant/tool/system/custom variants; model changes, usage, labels, summaries, and custom data are separately typed.
- **Limits/errors:** custom non-context entries and usage do not become model instructions. Persisted conversation is not an authoritative work/backlog database. Documented migration is not a crash-consistency or concurrent-writer guarantee.
- **Check NOT RUN:** serialization/migration, active-branch projection, immutable raw history, and ephemeral-session non-persistence.

#### CAP-13 — Resume, navigation, fork, clone, and state queries

**Native · H11, H16, H21 ·** [Sessions and Context](https://pi.dev/docs/latest/sessions), [RPC Commands](https://pi.dev/docs/latest/rpc-commands)

- **Interface/config:** `--continue/resume/session/session-id/fork/session-dir`; `/new/resume/tree/fork/clone/name/import`; RPC `get_state/messages/entries/tree/last_assistant_text`, switch/new/fork/clone.
- **Trigger → output/state:** tree navigation stays in one file; fork/clone create another session. `get_entries(since)` returns append-order history, including abandoned branches, with current `leafId`; state queries expose live flags and identity.
- **Limits/errors:** cancellation can report command success with `cancelled: true`; invalid entry cursors fail. Fork is conversation branching, not Git-worktree isolation, delegation, or a required A4S operation.
- **Check NOT RUN:** continuation identity, cross-cwd behavior, cancellation, cursor recovery, and branch divergence.

#### CAP-14 — Steering, follow-up, queues, and interruption

**Native · H10–11, H17 ·** [RPC Commands](https://pi.dev/docs/latest/rpc-commands), [Use Pi in the terminal](https://pi.dev/docs/latest/usage)

- **Interface/config:** RPC `prompt.streamingBehavior`, `steer`, `follow_up`, `clear_queue`, `abort`; steering/follow-up delivery modes.
- **Trigger → output/state:** steering enters after current assistant/tool work; follow-up after pending work. RPC queue clearing returns removed text. To reproduce interactive Escape, clear queues before abort and restore text in the client.
- **Limits/errors:** RPC `abort` alone is not queue cancellation: remaining messages can continue. A “queued” disposition does not guarantee later queue presence. Interrupted work is not automatically rolled back.
- **Check NOT RUN:** queued-input preservation, clear-before-abort, no unintended continuation, and tool-side effect visibility after cancellation.

#### CAP-15 — Built-in file and shell operations

**Native · H14, H22 ·** [Command Line](https://pi.dev/docs/latest/cli), [Configure shell commands](https://pi.dev/docs/latest/shell-aliases), [Windows](https://pi.dev/docs/latest/windows)

- **Interface/config:** default `read/bash/edit/write`; optional `grep/find/ls/powershell`; allow/exclude/no-tool controls. Bash shell path/prefix; user `!` includes output, `!!` does not.
- **Trigger → output/state:** commands use separate non-interactive shell processes. Files are read, exactly edited, created/overwritten, or searched. Custom shell operations can override execution.
- **Limits/errors:** cwd is a default, not an access boundary; shell aliases/setup do not persist automatically. PowerShell availability is native-Windows-specific. Tool disabling does not remove trusted extension code's host permissions.
- **Check NOT RUN:** read/edit/write errors, nonzero exit, output truncation, shell prefix, and fixture-only file access.

### Extension and context boundaries

#### CAP-16 — Executable extension registration

**Extension · H4, H10, H14, H18 ·** [Extensions](https://pi.dev/docs/latest/extensions)

- **Interface:** TypeScript/JavaScript factory; `pi.on/registerTool/registerCommand/registerShortcut/registerFlag/registerProvider/registerMcpServer/registerVirtualModel`; renderers and `pi.events`.
- **Lifecycle/limits:** async loading is awaited; reload replaces the runtime. Start long-lived resources at `session_start`, not the factory. Same process permissions.
- **Check NOT RUN:** registration collisions, reload invalidation, and no factory-started background resources.

#### CAP-17 — Tool mediation, exposure, and nested calls

**Native pipeline + Extension policy · H14 ·** [Extensions](https://pi.dev/docs/latest/extensions), [Codemode](https://pi.dev/docs/latest/codemode)

- **Interface/state:** `tool_call` can block/change input; `tool_result` composes results. TypeBox input; content/details and optional output schema/structured data. Exposure: `direct/model-only/codemode/deferred/hidden`; active declaration is not every callable tool.
- **Errors/limits:** handler failure blocks a call; nested calls use the same hooks. Calls may be parallel. Hints are unverified; structured redaction matters too.
- **Check NOT RUN:** policy applies to direct/nested calls; denied input, structured errors, parallel mutations, and hidden tools cannot bypass it.

#### CAP-18 — Context transforms and branch-sensitive extension state

**Extension · H12, H16, H21 ·** [Extensions](https://pi.dev/docs/latest/extensions), [Session File Format](https://pi.dev/docs/latest/session-format)

- **Interface/state:** `before_agent_start`, `context`, `context_with_system`; `appendEntry`, `sendMessage`; tool-result details; active `getBranch()`.
- **Lifecycle/limits:** preserve system-message contracts; rebuild only active-branch state. Cross-session data needs external storage. `agent_before_settle` can request continuation; `agent_settled` is notification-only. Command-only replacement/navigation avoids lifecycle deadlock.
- **Check NOT RUN:** branch-specific restoration, compaction survival, bounded continuation, and stale-context rejection after replacement.

#### CAP-19 — Compaction and branch summarization

**Native + Extension hook · H12–13, H21 ·** [Compaction Reference](https://pi.dev/docs/latest/compaction)

- **Interface/config:** `/compact`, threshold/overflow recovery, `compaction` and `branchSummary` settings; `session_before_compact`, `session_compact_failed`, `session_before_tree`.
- **Trigger → output/state:** threshold compares projected context to window minus reserve; a summary and recent boundary reconstruct subsequent context. Defaults: reserve 16,384; recent 20,000 tokens. Raw history is retained.
- **Limits/errors:** cancellation/provider failure is not success. Per-model overrides must be valid non-negative safe integers. Context-overflow recovery is not a provider-quota fallback. Custom summaries can carry usage/details.
- **Check NOT RUN:** boundary preservation, tool-result pairing, failed/cancelled summary, branch summary, and token-limit override errors.

#### CAP-20 — History retrieval and long-term memory

**Native history access; Extension/External retrieval; native general memory service unknown · H12, H21 ·** [Sessions and Context](https://pi.dev/docs/latest/sessions), [Message Types](https://pi.dev/docs/latest/message-types), [MCP Servers](https://pi.dev/docs/latest/mcp)

- **Interface/state:** session files/tree/query surfaces expose retained history; custom messages or retrieved MCP resources can supply selected context.
- **Trigger → output:** retrieval depends on a caller/extension's query and selection; compaction alone is not a cross-session search engine.
- **Limits/errors:** no documented general semantic-memory store, authority resolver, retention policy, or automatic promotion of historical A4S intent to current policy. This is a documentation gap, not proof that no package exists.
- **Check NOT RUN:** retrieved provenance/staleness and authoritative policy remain distinguishable from historical session text.

### Models, credentials, failures, and accounting

#### CAP-21 — Catalog, selection, and compatible endpoints

**Native + External model service · H4–5, H7, H13 ·** [Choose a Model](https://pi.dev/docs/latest/models)

- **Interface/config:** bundled/cached/refreshed catalogue; `--list-models`, `/model`, scoped models, thinking levels; agent `models.json` for compatible endpoints/overrides.
- **Trigger → output/state:** credential-ready models become selectable; sessions record selection/thinking changes. Catalogue refresh changes metadata, not account entitlements.
- **Limits/errors:** advertised API compatibility must match the endpoint's actual fields. A listed model, context window, or price is not live provider access or availability evidence.
- **Check NOT RUN:** offline catalogue, available/configured distinctions, exact provider/model selection, and rejected compatibility fields.

#### CAP-22 — Provider authentication and credential resolution

**Native + External identity · H5 ·** [Providers](https://pi.dev/docs/latest/providers), [Choose a Model](https://pi.dev/docs/latest/models)

- **Interface/config:** `/login/logout`, API-key env, private `auth.json`, command-resolved secrets, ambient cloud credentials; native provider configuration.
- **Trigger → output/state:** usual precedence: runtime key, stored credential, model configuration key, provider environment/ambient source. OAuth can refresh; providers can specialize the contract.
- **Limits/errors:** logout removes saved Pi credentials, not all environment/config values or upstream grants. Credential-printing commands expose secrets. Authentication readiness is not account billing/quota proof.
- **Check NOT RUN:** fake credentials, precedence, cancellation/expiry, and redacted logs; never retain real token output.

#### CAP-23 — Custom providers and stream normalization

**Extension · H5, H7, H13, H19 ·** [Custom Providers](https://pi.dev/docs/latest/custom-provider)

- **Interface/config:** `registerProvider` with complete `Provider` or legacy `ProviderConfig`; authentication, model refresh, existing stream adapters, or custom `stream/streamSimple`.
- **Trigger → output/state:** provider translates normalized transcript/tools into upstream requests and returns finalized assistant/usage/stop-reason events. Dynamic model publication can be persisted or transient.
- **Limits/errors:** custom streaming must honor cancellation and payload/response/stream instrumentation. Invalid streams/authentication or unknown overflow messages require guarded integration-specific handling, not arbitrary error rewriting.
- **Check NOT RUN:** text/tools/images where supported, malformed/Unicode streams, usage, abort, overflow, and cross-provider replay.

#### CAP-24 — Virtual-model routing

**Native contract + Extension/SDK routing logic · H7, H13 ·** [Virtual Models](https://pi.dev/docs/latest/virtual-models)

- **Interface/config:** `registerVirtualModel({ provider, id, route, ... })`; SDK `modelRuntime.registerVirtualModel`; route inputs include reason, previous/failed physical pair, transcript, branch state, signal.
- **Trigger → output/state:** every request selects a physical model/thinking pair. Selection is recorded separately from assistant dispatch; branch state survives compaction/fork. Direct requests do not retain route state.
- **Limits/errors:** no virtual-to-virtual routing; missing credentials/throwing routes fail. Retry model switching is router logic, not a guaranteed built-in fallback policy. Missing registration on resume can restore the last physical model.
- **Check NOT RUN:** user/continuation/retry/direct routing, selected-versus-dispatched provenance, sticky cache behavior, and invalid routes.

#### CAP-25 — Retry and context-overflow recovery

**Native, bounded/provider-dependent · H13, H19 ·** [Settings Reference](https://pi.dev/docs/latest/settings), [JSON Event Stream](https://pi.dev/docs/latest/json), [Compaction Reference](https://pi.dev/docs/latest/compaction)

- **Interface/config:** agent retry enable/count/backoff/delay; provider timeout/retry controls; retry/summary/compaction events and abort-retry commands.
- **Trigger → output/state:** transient failures can retry; recognized overflow can compact and retry. `retry.maxRetries` defaults to 3 agent-level retry attempts, separate from the initial request; `retry.provider.maxRetries` defaults to 0.
- **Limits/errors:** policy exhaustion is failure, not an accepted answer. No blanket guarantee of cross-provider quota fallback, exactly-once tools, or service availability. Do not conflate repeated model requests with retried external side effects.
- **Check NOT RUN:** deterministic transient/quota/overflow fixtures prove attempt counts, final errors, cancellation, and absence of unwanted duplicate actions.

#### CAP-26 — Classifier and image-model operations

**Native API + External services · H13–14 ·** [Choose a Model](https://pi.dev/docs/latest/models), [Codemode](https://pi.dev/docs/latest/codemode)

- **Interface/input/output:** non-chat model catalogue; `classify({ state, questions })` returns typed probabilities/scores; `generateImages({ input })` returns text/base64 image blocks. Extensions use model registry methods; Codemode exposes `models`.
- **State/errors:** result stop reason/error must be checked; usage can contribute to session totals. Generated images are not automatically saved. Classifiers/image models are not chat-picker models.
- **Limits:** a classification is decision support, not authorization or accepted outcome; selected provider credentials/prices remain external dependencies.
- **Check NOT RUN:** fake classifier/image results, provider failure, multimodal output, usage, and no accidental base64 logging.

#### CAP-27 — Prompt caching and warming

**Native best-effort optimization · H13, H20 ·** [Settings Reference](https://pi.dev/docs/latest/settings), [Choose a Model](https://pi.dev/docs/latest/models)

- **Interface/config:** cache-retention tier, model `promptCache` lifetime, global `cacheWarming` off/streaming/idle; `cache_warming_decision` customization.
- **Trigger → output/state:** eligible cache refreshes use declared lifetimes and estimated savings; recorded usage contributes to totals but not model context.
- **Limits/errors:** provider caching is best-effort; missing lifetime is not warming eligibility. Route/model/context changes can lose cached prefixes. Neither cost savings nor cache retention is guaranteed.
- **Check NOT RUN:** mock lifetime/cost/idle decisions and warming usage separate from conversation content.

#### CAP-28 — Session usage and cost, not account billing

**Native accounting with External evidence limits · H16, H20 ·** [RPC Commands](https://pi.dev/docs/latest/rpc-commands), [Message Types](https://pi.dev/docs/latest/message-types)

- **Interface/output:** `/session`, footer, `get_session_stats`, assistant/tool/usage entries; tokens, cost, current context usage.
- **State:** totals can include tool-reported usage and summarization across the full session, not just active visible messages. Context usage can be absent or unknown immediately after compaction.
- **Limits/errors:** catalog-derived cost and missing usage/prices are not invoices, remaining credits, subscription windows, reset times, or hard spending caps. No general public billing API contract was established.
- **Check NOT RUN:** known/unknown usage, nested-tool/summary charges, branch totals, physical router attribution, and explicit unknown billing fields.

### Integration, presentation, and cross-cutting support

#### CAP-29 — Built-in MCP integration

**Native CLI bundled extension + External servers · H7–8, H14, H19 ·** [MCP Servers](https://pi.dev/docs/latest/mcp)

- **Interface/config:** user/project `mcp.json`; stdio or streamable HTTP, OAuth; `/mcp` and shell management commands. Tools/resources expose direct, deferred, Codemode, or hidden access.
- **Trigger → output/state:** session startup connects enabled servers; discovered tools enter the tool pipeline. Resource list/template/read operations support retrieval. SDK requires explicit factories/binding.
- **Limits/errors:** legacy SSE/MCP Apps rendering are unsupported. Invalid entries are skipped/reported; resource reads may retry, tool calls are not retried automatically. A replacement extension can replace bundled session MCP behavior. Server annotations are not trusted enforcement.
- **Check NOT RUN:** local fake server, connection failure, exposure, resources, OAuth cancellation, nested permission gates, and non-repeated side effects.

#### CAP-30 — Codemode orchestration and scoped storage

**Native CLI bundled extension · H13–14, H18, H22 ·** [Codemode](https://pi.dev/docs/latest/codemode)

- **Interface/input/output:** raw async JavaScript; `tools`, `text/image`, `ALL_TOOLS`, search/describe helpers, `models`, `store/load`; output budget and optional whole-script deadline.
- **State:** successful store writes persist branch-relative custom entries; failed script writes do not. QuickJS has no Node/filesystem/network/timers; registered tools bridge outward.
- **Limits/errors:** 256 MB VM; no recursive scripts; bounded JSON store. Tool effects before script failure are not rolled back; MCP `isError` or shell nonzero results require inspection. This VM is not a sandbox for host tool implementations/extensions.
- **Check NOT RUN:** parallel partial success, deadline/cancellation, failed-store rollback versus real side effects, and branch-resumed values.

#### CAP-31 — Terminal UI and RPC interaction

**Native + Extension presentation · H9–10, H16 ·** [Terminal UI](https://pi.dev/docs/latest/tui), [RPC Extension UI](https://pi.dev/docs/latest/rpc-extension-ui), [Use Pi in the terminal](https://pi.dev/docs/latest/usage)

- **Interface/output/state:** transcript/editor/footer, widgets/dialogs/custom components/renderers; RPC `extension_ui_request/response` forwards supported select/confirm/input/editor requests and notifications.
- **Trigger:** input, streaming updates, tool progress, and explicit commands update display; dialogs can wait for matching client responses/timeouts.
- **Limits/errors:** RPC `hasUI` does not mean TUI custom components are available. Print/JSON have no UI; several terminal APIs degrade/no-op in RPC. Rendering is not enforcement.
- **Check NOT RUN:** TUI/RPC/headless behavior, ignored notification, cancelled/timed-out confirm, and compact tool progress.

#### CAP-32 — Themes, keybindings, and terminal capabilities

**Native + External terminal · H9, H22 ·** [Themes](https://pi.dev/docs/latest/themes), [Keybindings Reference](https://pi.dev/docs/latest/keybindings), [Terminal Setup](https://pi.dev/docs/latest/terminal-setup), [tmux](https://pi.dev/docs/latest/tmux)

- **Interface/config:** JSON themes/semantic colors, named keybinding actions, theme selection, regular/fullscreen modes, detected or overridden image/link/color capabilities.
- **Trigger → output/state:** load/reload preferences; components invalidate cached rendering when content/theme changes. Terminal and multiplexer protocols govern modified-key delivery.
- **Limits/errors:** missing/circular theme variables are invalid; forcing unsupported escape sequences can corrupt rendering. tmux configuration is external, not native scheduling/background job ownership.
- **Check NOT RUN:** invalid themes, key remapping, image-disabled output, resize/exit restoration, and the target terminal path.

#### CAP-33 — Export, share, diagnostics, and feedback

**Native; sharing has External effects · H16, H20 ·** [Sessions and Context](https://pi.dev/docs/latest/sessions), [Use Pi in the terminal](https://pi.dev/docs/latest/usage), [Slash commands](https://pi.dev/docs/latest/slash-commands)

- **Interface/output:** `/export` HTML/JSONL, `/copy`, `/share`, `/bug`, `/debug`; session/context/usage display.
- **Trigger → state:** explicit export writes artifacts; share/upload uses configured external services. Debug output can contain rendered terminal lines and messages; reports can include transcript/environment/error diagnostics.
- **Limits/errors:** inspect before publication; session output can contain confidential prompts/files/arguments. A report/export is not accepted behavior or independently verified evidence. Upload failure can offer local export.
- **Check NOT RUN:** sanitized fixture export/redaction and upload-disabled failure; no real external sharing in this research.

#### CAP-34 — Network transport and provider/client support

**Native settings/contracts + External connectivity · H7–8, H19 ·** [Settings Reference](https://pi.dev/docs/latest/settings), [Custom Providers](https://pi.dev/docs/latest/custom-provider), [Local Models with llama.cpp](https://pi.dev/docs/latest/llama-cpp)

- **Interface/config:** supported provider HTTP/SSE/WebSocket choices; proxy and idle/connect timeout settings; compatible endpoint and provider adaptation; llama.cpp router integration.
- **Trigger → output/state:** model/catalog/auth/tool requests use their protocol-specific clients; local models require a separate router/service.
- **Limits/errors:** transport selection is not a network authorization policy. `PI_OFFLINE` disables automatic network activity, not a proof that prompts/tools cannot communicate. No general Pi remote-exec/relay/server transport plug-in contract was established.
- **Check NOT RUN:** mock timeouts/proxy/offline startup and explicitly blocked unneeded network destinations.

#### CAP-35 — Orderly session/runtime shutdown

**Native + Extension cleanup · H17 ·** [RPC Mode](https://pi.dev/docs/latest/rpc), [SDK](https://pi.dev/docs/latest/sdk), [Extensions](https://pi.dev/docs/latest/extensions)

- **Interface/state:** close RPC stdin; SDK `dispose`; extension `ctx.shutdown`; idempotent `session_shutdown` resource cleanup.
- **Trigger → output:** runtime disposal/abort removes active subscriptions/contexts; orderly shutdown completes at the documented lifecycle boundary.
- **Limits/errors:** process kill, timeout, and external-job cleanup remain separate concerns; no general guaranteed transactional cleanup of arbitrary child jobs.
- **Check NOT RUN:** shutdown during active/idle work, closed stdin, stale context, and repeated cleanup without leaked image-test processes.

#### CAP-36 — Delegation and background work

**Extension/External construction; Native managed-agent contract absent in scope · H15 ·** [SDK](https://pi.dev/docs/latest/sdk), [CLI Integration](https://pi.dev/docs/latest/cli-integration), [Extensions](https://pi.dev/docs/latest/extensions)

- **Possible means:** a host/extension can create sessions or launch/control Pi subprocesses. That is a mechanism, not documented native spawn/message/wait/interrupt tools or a durable job controller.
- **Ownership/limits:** caller would own role/input boundaries, concurrency, results, cancellation, restart, and accepted outcome. A session fork supplies neither child-agent supervision nor isolated Git resources.
- **Check NOT RUN:** only if later chosen, test bounded child lifecycle/restart/cancellation and attribution; do not build a controller because a Handbook row exists.

#### CAP-37 — Goals, durable schedules, and autonomous acceptance

**Absent/Unknown in studied runtime contracts; External/Extension possible · H10–11, H15, H21 ·** [CLI Integration](https://pi.dev/docs/latest/cli-integration), [RPC Commands](https://pi.dev/docs/latest/rpc-commands), [Documentation scope](https://pi.dev/docs/latest)

- **Interface/state:** prompts and queues are documented; a generic persistent goal budget, recurring scheduler, durable task ledger, or accepted-result tool contract was not established by these references.
- **Limits:** timers/watchers in an extension or a continuously running process are not by themselves crash-recoverable scheduling. Pi Durable requires its own contract/version inquiry before classification.
- **Check NOT RUN:** if a concrete package/service is later proposed, verify due-time persistence, restart behavior, authority, cancellation, and acceptance without inferring them from Pi naming.

#### CAP-38 — Whole-process container/VM isolation

**External boundary with documented Pi setup · H2, H14, H23 ·** [Run Pi in an isolated environment](https://pi.dev/docs/latest/containerization), [Run Pi safely](https://pi.dev/docs/latest/security)

- **Interface:** documented plain Docker, Docker Sandboxes, OpenShell setups run Pi and its tools/extensions inside the environment. Runtime credentials/config/session volumes are explicit inputs.
- **Trigger → output/state:** external launcher starts the image/sandbox; outputs and any permitted mounts persist according to its configuration.
- **Limits:** writable mounts still change host files; environment/credentials/network remain exposed when provided. Documentation examples use floating image/package choices; research inference: pin versions/digests for a repeatable test claim. No native Pi sandbox toggle is implied.
- **Check NOT RUN:** image/version identity, least exposure, deny-by-default outbound access where applicable, write boundaries, and cleanup.

#### CAP-39 — Tool-only isolation and remote execution adaptation

**Extension + External backend · H14 ·** [Run Pi in an isolated environment](https://pi.dev/docs/latest/containerization), [Environment Variables](https://pi.dev/docs/latest/environment-variables)

- **Documented example:** Gondolin keeps Pi on the host while replacing selected built-in tools and user shell execution with micro-VM operations. Custom Bash/PowerShell factories expose spawn/environment hooks.
- **State/limits:** non-delegating extensions still run on the host. Gondolin's documented commands inherit host environment, potentially including keys; mounted files write through. This is narrower than whole-process isolation.
- **Check NOT RUN:** every relevant operation routes inside the image/VM, sensitive environment is omitted, and custom/nested operations cannot silently fall back to host execution.

#### CAP-40 — Proposed package that starts an image and runs tests inside it

**Extension + External container engine; proposal only · H14, H23 ·** [Pi Packages](https://pi.dev/docs/latest/packages), [Extensions](https://pi.dev/docs/latest/extensions), [Run Pi in an isolated environment](https://pi.dev/docs/latest/containerization)

- **Documented means, not a selected implementation:** package a command/tool that invokes an external image runtime, supplies a bounded test input, and returns observed test output/verdict through Pi. Plain Bash can launch an external command; a package adds repeatable behavior, not native Docker ownership.
- **Unknown:** image, engine access, test entrypoint, artifact contract, containment and cleanup are not specified or proved. No image-test-runner package was selected/installed.
- **Check NOT RUN:** the feasibility checks in section 5, especially independently proving that the test process ran **inside** the image.

#### CAP-41 — Shared message/types and reusable UI/utilities

**Native public contracts; internals Unknown · H18, H22 ·** [Message Types](https://pi.dev/docs/latest/message-types), [RPC Extension UI](https://pi.dev/docs/latest/rpc-extension-ui), [Terminal UI](https://pi.dev/docs/latest/tui)

- **Interface:** documented typed message/content/usage/stop-reason shapes, RPC envelopes/UI messages, components, focus/input/layout helpers, and extension declarations.
- **Trigger → output:** public consumers exchange typed records or compose terminal components rather than inventing schemas for native events.
- **Limits:** public exports do not promise replacement of all internal transport, database, path, build, or cryptographic subsystems. No counterpart to every Codex protobuf/schema generator is claimed.
- **Check NOT RUN:** contract/type compatibility and malformed-record/component-width fixtures against the pinned runtime.

#### CAP-42 — Developer verification and Pi-core regression suites

**External development workflow; documented integration checks · H23 ·** [Custom Providers](https://pi.dev/docs/latest/custom-provider), [SDK](https://pi.dev/docs/latest/sdk)

- **Evidence:** docs identify checked SDK/examples and provider integration test categories. Installed package metadata declares `test: vitest --run`; its top-level installed directories do not include a `test` directory.
- **Limits:** package metadata alone does not make the upstream monorepo suite executable from the installed distribution. Pi-core tests require an appropriate source/dependency/build environment; A4S behavior tests target a different A4S contract and are not selected substitutes. Passing either suite is not human acceptance.
- **Check NOT RUN:** establish the chosen suite/fixture/entrypoint and dependencies inside the image before reporting any verdict.

## 4. Exhaustive top-level Handbook coverage

Every row links its own Handbook introduction to preserve the original responsibility boundary without deriving the whole table from the index. **23/23 stages are considered; this is not 23/23 equivalence.** Native/Extension/External identify documentary means, and Absent/Unknown identify unfilled correspondence. The [Codex index](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/index.html) is a map, not a Pi implementation plan.

| H | Handbook responsibility | Relevant Pi documentation and CAPs | Correspondence and decisive caveat |
|---|---|---|---|
| 1 | [Process entrypoints and binary dispatch](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-1.html) | [CLI Integration](https://pi.dev/docs/latest/cli-integration); CAP-01, 09–10 | **Native:** CLI modes/SDK/RPC. **Absent:** documented one-for-one Codex binary/app/cloud launch family. |
| 2 | [Early process hardening and runtime bootstrap](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-2.html) | [Security](https://pi.dev/docs/latest/security); CAP-02, 38 | **External:** OS/container confinement. **Unknown:** equivalent native pre-main anti-debug/dump/env-sanitization contract; trust is not hardening. |
| 3 | [Installation context, home discovery, and local environment probing](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-3.html) | [Environment Variables](https://pi.dev/docs/latest/environment-variables); CAP-02–03, 15 | **Native:** agent/session/package paths, shell/platform setup. **Unknown:** complete doctor, managed install fingerprints, or shell snapshot equivalence. |
| 4 | [Configuration, feature resolution, and startup policy assembly](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-4.html) | [Configuration](https://pi.dev/docs/latest/configuration); CAP-03–08, 21 | **Native:** user/project settings/resources/model/tool choices. **Absent:** documented equivalent managed enterprise/cloud sandbox-policy assembly. |
| 5 | [Authentication, identity, and account readiness](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-5.html) | [Providers](https://pi.dev/docs/latest/providers); CAP-22–23, 29 | **Native/External:** provider/MCP authentication. **Unknown:** general account entitlements/billing identity; auth-ready does not prove quota. |
| 6 | [Persistence and local runtime services startup](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-6.html) | [Session File Format](https://pi.dev/docs/latest/session-format); CAP-09, 12 | **Native:** persistent/in-memory session initialization/migration. **Unknown:** equivalent SQLite state-service recovery; no public replacement hook established. |
| 7 | [Backend clients, remote catalogs, and startup refreshes](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-7.html) | [Choose a Model](https://pi.dev/docs/latest/models); CAP-21–24, 29, 34 | **Native/Extension/External:** catalogs/providers/MCP/local router. **Absent:** documented Codex task/connector/backend-directory parity. |
| 8 | [Transport and server runtime initialization](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-8.html) | [RPC Mode](https://pi.dev/docs/latest/rpc); CAP-09–10, 29 | **Native:** stdio RPC/in-process SDK; MCP clients. **Absent/Unknown:** corresponding daemon/app-server/remote execution relay contract. |
| 9 | [Frontend session startup and user-facing initialization](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-9.html) | [Use Pi in the terminal](https://pi.dev/docs/latest/usage); CAP-01, 13, 31–32 | **Native:** terminal and scripted sessions. **External/Extension:** custom clients. No Codex desktop frontend correspondence is assumed. |
| 10 | [Main event loop and request dispatch](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-10.html) | [How Pi Works](https://pi.dev/docs/latest/how-pi-works); CAP-09–11, 14, 16 | **Native/Extension:** prompt/queue/event/command dispatch. **Unknown:** arbitrary host resource serialization guarantees. |
| 11 | [Thread and session orchestration](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-11.html) | [Sessions](https://pi.dev/docs/latest/sessions); CAP-09, 12–14 | **Native:** session lifecycle/branching/resume/query. **Absent/Unknown:** durable goals, live agent graph, or subscribed multi-client thread service. |
| 12 | [Prompt, context, and extension assembly](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-12.html) | [Configuration](https://pi.dev/docs/latest/configuration); CAP-05–07, 18–20 | **Native/Extension:** instruction/resource/context composition and compaction. **External/Unknown:** long-term semantic memory; historical records are not policy activation. |
| 13 | [Turn execution and model interaction](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-13.html) | [Virtual Models](https://pi.dev/docs/latest/virtual-models); CAP-11, 19, 21–28, 30 | **Native/Extension:** streamed provider/tool loop, routing/retry. **Absent:** blanket quota fallback or outcome acceptance guarantee. |
| 14 | [Tool execution, approvals, and guarded side effects](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-14.html) | [Extensions](https://pi.dev/docs/latest/extensions), [Security](https://pi.dev/docs/latest/security); CAP-04, 15–17, 29–30, 38–40 | **Native:** tools/pipeline. **Extension:** per-call mediation. **External:** isolation. **Absent:** built-in blanket approvals/sandbox; trusted code can bypass a tool-only boundary. |
| 15 | [Multi-agent, collaboration, and background workflows](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-15.html) | [SDK](https://pi.dev/docs/latest/sdk); CAP-36–37 | **Extension/External:** construct sessions/processes. **Absent/Unknown:** managed collaboration/jobs/scheduler contract in studied runtime; no controller requirement follows. |
| 16 | [Result persistence, projection, and user-visible state updates](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-16.html) | [JSON Event Stream](https://pi.dev/docs/latest/json); CAP-11–13, 28, 31, 33 | **Native/Extension:** transcripts/events/renderers/statistics. Runtime status, test verdict, repository integration, and acceptance remain separate. |
| 17 | [Shutdown, cleanup, and teardown](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-17.html) | [RPC Mode](https://pi.dev/docs/latest/rpc); CAP-14, 35 | **Native/Extension:** abort/dispose/shutdown hooks. **External/Unknown:** durable job drain/restart and arbitrary process cleanup guarantees. |
| 18 | [Protocol schemas, shared types, and generated contracts](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-18.html) | [Message Types](https://pi.dev/docs/latest/message-types); CAP-10–12, 17, 31, 41 | **Native:** documented public records/types. **Absent/Unknown:** equivalent protobuf/OpenAPI/codegen family or all internal schema replacement APIs. |
| 19 | [Cross-cutting transport, networking, and client infrastructure](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-19.html) | [Custom Providers](https://pi.dev/docs/latest/custom-provider); CAP-10, 23, 25, 29, 34 | **Native/Extension:** protocol clients/provider adapters. **External/Unknown:** network enforcement, encrypted remote relay, general IPC replacement. |
| 20 | [Cross-cutting observability, analytics, and feedback](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-20.html) | [JSON Event Stream](https://pi.dev/docs/latest/json); CAP-11, 27–28, 33 | **Native/Extension:** event/usage/diagnostic feedback; settings govern telemetry choices. **Unknown:** equivalent complete OpenTelemetry/accepted-change analytics contract. |
| 21 | [Cross-cutting persistence abstractions and data stores](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-21.html) | [Session File Format](https://pi.dev/docs/latest/session-format); CAP-12–13, 18–20, 22, 24, 30, 37 | **Native:** sessions/settings/auth/catalog/custom state. **External/Unknown:** durable task/memory/agent databases and general store substitution contracts. |
| 22 | [Cross-cutting utility and support libraries](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-22.html) | [Terminal UI](https://pi.dev/docs/latest/tui); CAP-02, 08, 15, 30, 32, 41 | **Native public subsets:** UI/types/shell/resource support. **Unknown:** all private utilities/build paths; no forced package per utility category. |
| 23 | [Testing, fixtures, and developer verification harnesses](https://ruhan-wang.github.io/Harness-Handbook/codex-handbook/en/stage-23.html) | [Custom Providers](https://pi.dev/docs/latest/custom-provider), [Containerization](https://pi.dev/docs/latest/containerization); CAP-38–40, 42 | **External:** chosen suite inside chosen image. **Extension:** proposed runner. Neither documentation nor existing fixtures prove execution/operational delivery. |

## 5. Image-starting test package: documentary feasibility, not adoption

### What the documents support

A Pi package can ship an executable extension, and an extension/command can call an external process. The isolation guide documents launching Pi inside images/sandboxes and tool delegation to an isolated backend. **Inference:** those public means make an image-starting test-runner package plausible without patching Pi core. They do not prove that a particular runner exists, covers every path, or is safe. [Pi Packages](https://pi.dev/docs/latest/packages), [Extensions](https://pi.dev/docs/latest/extensions), [Containerization](https://pi.dev/docs/latest/containerization)

The proposed behavior is precisely: **start the agreed image → execute the selected Pi test suite/entrypoint inside it → collect actual output and independent verdict evidence → report it to Pi/operator → clean only the runner-owned disposable resources**. The exact Pi suite/entrypoint remains unselected. Building an image, listing tests, running tests on the host, or substituting A4S/runner tests is not the proposed result.

### Real boundary choice, not a selected design

| Boundary | What it could establish | Tradeoff to resolve before implementation |
|---|---|---|
| Whole Pi process inside the image | Pi, extensions, user shell operations, and tests share the external boundary. | More runtime/credential/session setup inside the image; permitted mounts/network still reach outward. |
| Host Pi package launches a separate test image | Only the requested test process and its inputs are confined. Pi keeps its host UI/configuration. | The package/engine launcher still has host privileges; other tools/extensions are not confined by this runner. |

These are meaningful containment alternatives, not instructions to add both. An engine socket or privileged launcher would need explicit assessment because it can expose host-level control; it is not made safe by calling the child a container. This is security analysis, not a Pi-native Docker permission contract.

### Inputs, results, ownership, and error contract to specify

These are **unresolved proposal questions**, not existing Pi/A4S configuration:

- Exact image digest, Pi/package/dependency versions, CPU/platform, and test entrypoint; floating `latest` cannot support an exact-version result.
- Exact fixture/source revision and data made available inside the image; copy versus read-only input versus narrowly scoped writable output.
- Who authorizes image pulls/builds, engine access, network destinations, credentials, and write-through mounts. Do not expose the host Pi agent directory or credentials by default.
- How the runner proves image/container identity, internal working directory/process, input revision, exit status/signal, timeout/abort, and complete log/report location.
- Return shape separating `launch_failed`, `tests_failed`, `tests_passed`, `aborted`, and `inconclusive`; `agent_settled` is not that verdict. A nonzero shell/MCP result must not become success merely because a promise resolved.
- Exact owned cleanup set: container/run ID, disposable fixture/output directory, and any temporary image only if authorized. Failure cleanup must not target unrelated containers/images or retained evidence.

### Minimal proposed checks — every row NOT RUN

| Check | Observation required for a later verdict | Status |
|---|---|---|
| Image and execution identity | Pinned digest/version, internal process/cwd, fixture revision; independent host observation agrees that tests executed in the image. | **NOT RUN** |
| Positive test path | A tiny fixture suite actually passes inside the image and returns exact exit/verdict/report evidence. | **NOT RUN** |
| Negative test path | Intentionally failing fixture produces `tests_failed`, not launch success or an assistant assertion. | **NOT RUN** |
| Launch/dependency failure | Missing engine/image/entrypoint or unavailable dependency is reported distinctly; no silent host fallback. | **NOT RUN** |
| Timeout, abort, and queue lifecycle | Stop reaches the test process/container; no leaked owned child; queued Pi prompts are handled according to their own contract. | **NOT RUN** |
| Filesystem/credential/network boundary | Unexposed host fixture path and secret unavailable; only authorized writes/network succeed; engine exposure assessed. | **NOT RUN** |
| Evidence and redaction | Logs/reports preserved or linked within output limits; secrets absent; truncated output cannot conceal failure. | **NOT RUN** |
| Cleanup and repetition | Only identified disposable resources removed; retained artifacts survive; second run has no stale state/collision. | **NOT RUN** |
| Pi package loading contract | Manifest/host peers, current mode, tool errors, reload/disposal, and permission hooks behave as documented. | **NOT RUN** |

### Separate test subjects

The proposal preserves Pi's tests as its subject. Runner integration and A4S behavior tests below are distinct possible additional controls, not selected replacements; neither the exact Pi suite nor those additional controls has been selected or run here.

| Subject | What would be tested | What a pass would not prove |
|---|---|---|
| Pi-core regression suite | Pi's upstream runtime/provider/session/tool contracts in its appropriate source/build/test environment. | A4S's selected workflow/result is useful, delivered, or accepted. |
| Pi package integration | The proposed runner's entrypoint, image execution, result semantics, limits, cleanup, and supported Pi modes. | All Pi internals or unrelated A4S components are correct. |
| A4S behavior/acceptance tests | Operator-chosen A4S result and preserved invariants, using the actual consuming Pi path where relevant. | Normative adoption, remote delivery, or human acceptance without those separate records. |

No suite, container, fixture experiment, or package was run during this documentary research.

## 6. Explicit gap, unsupported, and unknown ledger

| ID | Responsibility/question | Evidence boundary and classification | Consequence for correspondence |
|---|---|---|---|
| GAP-01 | Blanket approvals/sandbox | **Absent native blanket guarantee** in [Security](https://pi.dev/docs/latest/security); hooks and external boundaries are separate means. | Do not import Codex approval/sandbox behavior by naming a Pi tool. |
| GAP-02 | Complete startup trust boundary | **Unsupported assumption:** context discovery and pre-trust session location remain separate from project-resource trust. [Configuration](https://pi.dev/docs/latest/configuration) | Tests must inspect effective inputs, not only a trust flag. |
| GAP-03 | Native agent team/job controller | **Absent in studied contracts; Extension/External feasible; Durable unknown.** [SDK](https://pi.dev/docs/latest/sdk) | No need for a fork/controller/registry is inferred. |
| GAP-04 | Durable scheduling/goals/budgets | **Unknown/absent contract** in scoped CLI/RPC references. [CLI Integration](https://pi.dev/docs/latest/cli-integration) | Require a separately documented concrete service/package if an actual intention needs it. |
| GAP-05 | General semantic memory/authority | **Unknown native service; external retrieval possible.** [Session File Format](https://pi.dev/docs/latest/session-format) | Retained history or compaction is not policy or automatic intent activation. |
| GAP-06 | Model quota fallback/hard spending cap | **No blanket guarantee established.** Retry settings and programmable virtual routing are distinct. [Virtual Models](https://pi.dev/docs/latest/virtual-models) | Selection/availability/cost cannot substitute for entitlement/billing evidence. |
| GAP-07 | Account limits/invoices | **Unknown general public contract.** Session statistics are session-local accounting. [Message Types](https://pi.dev/docs/latest/message-types) | Report missing quota/remaining balance as unknown, not zero or unlimited. |
| GAP-08 | Exactly-once actions/rollback | **Not guaranteed:** script failure does not undo prior tool effects. [Codemode](https://pi.dev/docs/latest/codemode) | Runner/retry/result design needs explicit side-effect semantics. |
| GAP-09 | Universal internal extension contracts | **Unknown** for pre-main hardening, SQLite recovery, cryptographic substrate, general remote relay/IPC, complete utility/build and schema-generator families. Public docs expose only selected boundaries. | Mark partial/no public API; do not invent plug-ins or copied components. |
| GAP-10 | MCP transport/apps parity | **Unsupported:** legacy SSE and MCP Apps rendering. [MCP Servers](https://pi.dev/docs/latest/mcp) | Preserve incompatibility; do not force another client's integration assumptions. |
| GAP-11 | TUI capability in all modes | **Unsupported:** custom terminal UI is not available in RPC/print/JSON merely because an extension loads. [RPC Extension UI](https://pi.dev/docs/latest/rpc-extension-ui) | Interaction/error policy must specify headless and client behavior. |
| GAP-12 | Tool-only isolation covers host | **Unsupported:** host Pi and non-delegating extensions remain outside. [Containerization](https://pi.dev/docs/latest/containerization) | Specify containment scope rather than saying “sandboxed.” |
| GAP-13 | Image test-runner already delivered | **Unknown/not implemented in this task.** Documentary means establish feasibility only. | Require inside-image observations; do not treat the proposal as adopted. |
| GAP-14 | Listed packages/native setup examples validated | **Not established:** package gallery presence and documented external integration do not attest package safety/current compatibility. [Pi Packages](https://pi.dev/docs/latest/packages) | Independently inspect a selected dependency and its exact version before adoption. |
| GAP-15 | Installed runtime equals moving docs | **Unknown exact correspondence.** Local metadata/docs and online references align at selected contracts, not binary/source identity. | Pin versions and verify consuming behavior in any later experiment. |
| GAP-16 | Existing A4S candidate/fixture equals accepted delivery | **Not established by this independent catalogue.** No current operational A4S execution was inspected. | Keep inventory status and consumer-result evidence separate; a settings-only candidate is not acceptance. |
| GAP-17 | Runtime finish equals human acceptance | **Invalid inference:** accepted RPC input and settled runs are lifecycle signals. [RPC Mode](https://pi.dev/docs/latest/rpc) | Record runtime, test, delivery, and operator outcomes independently. |

## 7. Synthesis for use beside the independent intentions inventory

Pi documents native sessions/branching, configuration/context resources, tools, model/provider interfaces, structured streaming, SDK/RPC control, and bundled CLI MCP/Codemode integration. It documents extension boundaries for selected behaviors and external means for isolation. **These are available documentary means, not a replacement-component list.**

The strongest mismatch is safety/ownership, not vocabulary: project trust is resource-loading control; a container boundary depends on actual exposures; native session state is not a durable work ledger; programmable routing is not guaranteed quota fallback; runtime settlement is not accepted value.

The proposed package that runs Pi's tests inside an image is documentarily feasible as extension-plus-external execution, but the exact Pi suite/entrypoint, containment scope, dependencies, and verdict contract remain unresolved. A4S behavior and runner integration tests are different possible additional controls, not selected substitutes. The proposal does not require a new harness, scheduler, fork, registry, or controller.

When compared with the independent inventory, retain each intention's original status/authority and examine only the public means relevant to that behavior. An unsupported or conflicting intention can remain incompatible; an unnecessary one can be excluded. No adoption/retirement verdict or implementation roadmap is issued here.

## 8. Document validation and work boundary

The effective parent `/Users/Shared/harness/a4s/.workspace/worktrees/intentions-pi-research/.workspace/docs/.stem` declares only `version: 2` and `root: true`; it has no document schema. `rootline new ... --dry-run` reported **“no .stem schema found”** and did not create the document. The requested source was therefore written with explicit metadata without modifying any `.stem`.

| Check performed on 2026-10-02 | Actual result and scope |
|---|---|
| Rootline query of the requested file | One Markdown record returned; explicit frontmatter parsed. A compact `--select path,frontmatter` query also returned one record (its selected output contained the path only). |
| `rootline validate` on the requested file | `valid: true`; 1 valid, 0 invalid; no errors/warnings, structural errors, stem-health errors, or drift warnings. This inherited scope has no document schema. |
| Mechanical catalogue/coverage check | 42 unique sequential CAP identifiers; all 23 Handbook matrix rows in order; 17 gap rows; 9 image-feasibility checks explicitly NOT RUN; balanced code fences and bounded frontmatter. |
| Primary-link coverage | 40 distinct Pi guide/reference links opened with the public documentation reader; 23 distinct English Handbook stage-introduction links read. Source links establish documentation provenance, not operational truth. |
| Untracked-file whitespace check | `git diff --no-index --check /dev/null` against this file produced no whitespace errors. Ordinary `git diff --check` was also clean, but alone would not cover an untracked file. |
| Mutation boundary | Track-owned output is this single new Markdown file. No `.stem` or executable/configuration file was changed. The sibling inventory is independently owned, not validated as this track's output. |

A Rootline pass in this schema-less scope cannot certify required fields, Handbook truth, runtime compatibility, execution, or human acceptance. This is a research artifact, so no executable end-to-end result is claimed.

Only this requested Markdown file belongs to this research track. No commits, branches, pushes, task mutations, implementation, container/model runs, installations, policy changes, or cleanup of shared resources were performed.

## Key Learnings:

1. Documented Pi means and A4S intentions are independent evidence sets; neither implies adoption of the other.
2. `agent_settled`, a test verdict, and operator acceptance are different outcomes; RPC abort also differs from clearing queued input.
3. A package can plausibly launch tests inside an image, but package loading, containment, inside-image execution, and accepted results require separate evidence.
