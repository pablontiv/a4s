# v1 source catalog

This catalog describes the `integration/v1` source tree at the #431 baseline
`05237b13461001cf2a2bc28b8b8e78380320bd2b`. Package names identify private npm
workspaces, not public npm releases. Source delivery, isolated candidate proof,
installed links, adopted DAGs and observed live behavior are separate facts.
See [private installation](../operations/private-install.md),
[deployment and recovery](../operations/deployment.md) and the
[dated walkthrough](../operations/v1-walkthrough.md).

## Components and ownership

| Delivered owner | Public surface and responsibility | Existing checks |
| --- | --- | --- |
| [`@a4s/issue-lifecycle`](../../packages/issue-lifecycle/README.md) | `packages/issue-lifecycle`; OMP status and triage/resource-guard extensions, package agents, seven skills, bootstrap and Dagu CLIs | `test/*.test.ts`, opt-in `test/live/*.test.ts`; [architecture](issue-lifecycle.md) |
| [`@a4s/review-routing`](../../packages/review-routing/README.md) | `packages/review-routing`; strict cross-family candidate selection, native `crossFamilyReview.policies` keyed by exact dispatch name; root hook/ordering APIs and `./settings` reader | `test/order.test.ts` under pinned Bun; workspace test/typecheck |
| [`@a4s/hot-reload`](../../packages/hot-reload/README.md) | `packages/hot-reload`; shared `hotReload` generation/lifecycle helper for retained reloadable shims | Workspace tests/typecheck; bounded native #421 evidence in its README |
| [`@a4s/orca-integration`](../../packages/orca-integration/README.md) | `packages/orca-integration`; reclaimable-worker lifecycle guard and explicit concrete model routing for a bound Orca coordinator; exported guard/router factories | `test/lifecycle-guard.test.ts`, `test/model-router.test.ts`, `test/orca-cli.test.ts` |
| [`@a4s/context-management`](../../packages/context-management/README.md) | `packages/context-management`; host-neutral core library, detailed below | `tsx --test test/*.test.ts` and `tsc --noEmit -p tsconfig.json` |
| [`@a4s/agent-messaging`](../../packages/agent-messaging/README.md) | `packages/agent-messaging`; protocol, MQTT transport, reloadable OMP adapter, shared delivery/recovery/arbitration, observer and diagnostics | Workspace tests/typecheck; explicit `verify:omp` requires authorized model authentication |
| [`@a4s/message-bus`](../../apps/message-bus/README.md) | `apps/message-bus`; independently started loopback MQTT broker with durable LevelDB; `message-bus` bin | `node --test --test-concurrency=1 test/*.test.cjs`; syntax typecheck |
| [`@a4s/pi-tool-row-presentation`](../../packages/pi-tool-row-presentation/README.md) | `packages/pi-tool-row-presentation`; retained Pi/Pion-specific tool-row presentation, with host-version limitations | Transpiled workspace behavioral tests; renderer types supplied by the optional consumer host |

The MQTT adapter connects to a separately owned broker. It does not start the
broker. The technical `synagent/v2/<to>` topic and persisted `synagent-*` entries
are wire/storage contracts, not package installation names. The broker is
unauthenticated loopback transport; local publishers can impersonate senders.

## Lifecycle skills

Whole-package OMP loading discovers these canonical directories under
[`packages/issue-lifecycle/skills/`](../../packages/issue-lifecycle/skills/).
Use `read skill://<name>` in an OMP session with that package loaded; read the
skill before authorizing its actions.

| Skill | Bounded responsibility |
| --- | --- |
| [`issue-execution`](../../packages/issue-lifecycle/skills/issue-execution/SKILL.md) | Execute an authorized issue as feature or PoC; keep one durable run and its owner |
| [`repository-discovery`](../../packages/issue-lifecycle/skills/repository-discovery/SKILL.md) | Investigate evidence through lenses; retain findings and prepare units |
| [`backlog-breakdown`](../../packages/issue-lifecycle/skills/backlog-breakdown/SKILL.md) | Import prepared units, validate, obtain independent plan review and operator approval, materialize issues |
| [`refine`](../../packages/issue-lifecycle/skills/refine/SKILL.md) | Investigate an authorized need and stage accepted units outside the repository |
| [`sprint-planning`](../../packages/issue-lifecycle/skills/sprint-planning/SKILL.md) | Agree goal checks and Definition of Done; rank and enqueue new work after confirmation |
| [`sprint-review`](../../packages/issue-lifecycle/skills/sprint-review/SKILL.md) | Evaluate sprint goal checks using issue delivery evidence |
| [`sprint-retrospective`](../../packages/issue-lifecycle/skills/sprint-retrospective/SKILL.md) | Inspect the process and route operator-selected incidents through refinement |

The #400 ceremony/backend boundary is substantive: Sprint Planning alone selects,
ranks and enqueues new work. Discovery and refine supply `UNITS_FROM` to the
single `planning.yaml` breakdown backend. That backend creates issues after
review and approval; it does not schedule the sprint. Definition of Done and
yes/no goal checks are ceremony content. Sprint Review evaluates a goal rather
than adding a feature checkpoint. An FYI is not authorization.

Package agents are [`plan-reviewer`](../../packages/issue-lifecycle/agents/plan-reviewer.md)
and [`triage-reviewer`](../../packages/issue-lifecycle/agents/triage-reviewer.md).
The six independent generic native roles and their installation are in
[the agent catalog](agents.md). Each role has one canonical `.omp/agents/<role>.md`
definition; the catalog is explanatory, not another runtime provider.

## Independent repository skills

These skills retain root ownership and carry their relative scripts/assets with
them. Install complete skill directories in a private consumer's supported
native skill root, or configure `skills.customDirectories`; see
[the installation recipe](../operations/private-install.md#independent-skills).

| Delivered root source | Purpose and qualifiers |
| --- | --- |
| [`skills/model-routing-audit/`](../../skills/model-routing-audit/SKILL.md) | OMP catalog/quota/routing snapshots, per-role/model scorecards, evidence-backed proposals and operator-approved fresh-agent verification; default collection performs no inference or assignment |
| [`skills/gpt-quota-audit/`](../../skills/gpt-quota-audit/SKILL.md) | OMP provider quota investigation; independent advisor and canonical reviewer must resolve outside the audited provider |
| [`skills/cost-analyzer/`](../../skills/cost-analyzer/SKILL.md) | Cross-harness session ledger, token/cost attribution and outcomes; retained design/ADR material is architecture, not an additional runtime port |
| [`skills/agent-throughput/`](../../skills/agent-throughput/SKILL.md) | Agent throughput, active time and tokens per PR |

### Conditional #311 ingestion

The #428 inventory inspected main `2e6ba63ae2ff1ae3f30beb24024d5c5157ce6e22`
and integration `c85c140`. The same four intended deliveries remain pending in
this catalog's baseline. The paths below are destinations, not available links
or invocations; there is no candidate PASS for them.

| Intended input in #311 | Canonical v1 destination when delivered |
| --- | --- |
| `skills/dagu-reconcile-operations/` | `packages/issue-lifecycle/skills/reconcile-operations/` (`reconcile-operations`) |
| `skills/omp-session-token-accounting/` | `skills/session-token-accounting/` (`session-token-accounting`) |
| `skills/omp-structured-subagent-output/` | `skills/structured-subagent-output/` (`structured-subagent-output`) |
| `skills/ios-device-xcuitest-free-team/` | `skills/ios-device-xcuitest-free-team/` (physical iPhone/free-team XCUITest) |

[#311](https://github.com/pablontiv/a4s/issues/311) owns ingestion, fact correction,
live evidence and separately authorized managed-local cleanup. Its whole scope
is not a v1 blocker. Final main-forward integration must inspect actual delivery
and migrate any newly delivered assets with their tests, assets and callers.

## Context Management: direct core contract

The public entrypoint [`core/index.ts`](../../packages/context-management/core/index.ts)
exports `types`, `request`, `client`, `state`, `compact`, `messages`, `binding` and
`trigger`. Consumers supply neutral `Message[]` values, tool-call/result IDs,
explicit `JevAsker` scoring and compaction options. `compact` returns rebuilt
messages, decisions and character accounting; `reductionRatio` summarizes the
reduction. Decisions keep a pair verbatim, truncate its result with the call
retained, or drop the pair. First/recent messages are pinned and untouched
messages preserve object identity.

`HostBinding` plus `runCompaction` maps a consumer transcript into neutral
messages and assembles its own output type. `JevClient`, request builders/parsers,
`compactMessages` and `JevRequestError` provide optional HTTP scoring with explicit
`apiKey` or `TYPESAFE_API_KEY`. Core scoring through an explicit asker runs offline
with zero runtime dependencies. Trigger state, recent-conversation bounds,
judgment parsing and adaptive evaluation return decisions; the consumer owns
invocation and application. This is a reusable core library, not an installed
OMP compaction integration. The package README contains a direct consumer
example, observed external-consumer result and behavioral test commands.

## Preserved architecture and attribution

Context Management's [`NOTICE`](../../packages/context-management/NOTICE) retains
fast-jev-compaction and compact-adviser MIT provenance and derived paths.
[`cost-analyzer/references/canonical-dataset-design.md`](../../skills/cost-analyzer/references/canonical-dataset-design.md)
and its retained `docs/adr` and `docs/superpowers` artifacts describe independent
ledger design. Their historical directory names do not establish current host
support. The retained messaging identity design is
[`docs/superpowers/plans/2026-10-12-synagent-workspace-identity.md`](../superpowers/plans/2026-10-12-synagent-workspace-identity.md).
Native agent attribution is recorded in [agents](agents.md#source-preservation-and-ownership).
Removed-host source remains in the `legacy` archive from #420; active installation
instructions live with delivered owners and in the operating runbooks.
