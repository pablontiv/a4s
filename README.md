# A4S

Private libraries, OMP extensions, native agents and independent skills maintained
in an npm workspace repository. Source is public; package names identify private
workspaces, not public npm publication.

## Documentation

- [v1 source catalog](docs/architecture/catalog.md): delivered components, seven
  lifecycle workflows, independent skills, pending #311 inventory and attribution.
- [Native agent catalog](docs/architecture/agents.md): six reusable roles, canonical
  `.omp/agents/<role>.md` sources, private installation and provenance evidence.
- [Issue lifecycle architecture](docs/architecture/issue-lifecycle.md): admission,
  candidate/receipt identity, semantic jobs, observation and advisory boundaries.
- [Private installation and development](docs/operations/private-install.md):
  whole-package OMP loading/linking, independent skill/role installation and prerequisites.
- [Lane deployment and recovery](docs/operations/deployment.md): independent
  PRIMARY clones, stable controller/candidate segregation, adoption, rollback,
  active-run ownership and temporary-lane retirement.
- [Dated v1 walkthrough](docs/operations/v1-walkthrough.md): exercised commands,
  native source selection and isolated bootstrap/admission evidence, not deployment.
- [Agent operating contract](AGENTS.md).

## Delivered components

| Source | Responsibility |
| --- | --- |
| [`packages/issue-lifecycle`](packages/issue-lifecycle/) | Dagu issue lifecycle, status, admission/resource guards, seven skills and specialized agents |
| [`packages/review-routing`](packages/review-routing/) | Strict native OMP cross-family model selection |
| [`packages/hot-reload`](packages/hot-reload/) | Shared reloadable-shim generation/lifecycle helper |
| [`packages/orca-integration`](packages/orca-integration/) | Bound Orca worker lifecycle and explicit model routes |
| [`packages/context-management`](packages/context-management/) | Host-neutral transcript transformation and adaptive trigger core library |
| [`packages/agent-messaging`](packages/agent-messaging/) | Native OMP messaging protocol, transport and delivery |
| [`apps/message-bus`](apps/message-bus/) | Independently started durable loopback MQTT broker |
| [`packages/pi-tool-row-presentation`](packages/pi-tool-row-presentation/) | Retained Pi/Pion-specific tool rows with documented host limitations |

Independent root skills are [model-routing-audit](skills/model-routing-audit/SKILL.md),
[gpt-quota-audit](skills/gpt-quota-audit/SKILL.md),
[cost-analyzer](skills/cost-analyzer/SKILL.md) and
[agent-throughput](skills/agent-throughput/SKILL.md). Their full directories stay
with their owning scripts/assets and can be installed in private consumers.
The [catalog](docs/architecture/catalog.md#conditional-311-ingestion) distinguishes
pending incoming skills from available functionality.

## Sprint and issue ownership

A coordinating session is a sprint. `refine` investigates needs;
`backlog-breakdown` owns issue-creation review/approval through `planning.yaml`;
`sprint-planning` alone selects, ranks and enqueues new work;
`sprint-review` evaluates the agreed goal from delivery evidence;
`sprint-retrospective` routes operator-authorized incidents through refinement.
`repository-discovery` supplies evidence and units; `issue-execution` executes
assigned feature/PoC work. Goal checks and Definition of Done are ceremony
content, not extra lifecycle checkpoints. Reports alone do not authorize action.

Main uses the independent `a4s` clone, branch `main`, queue `a4s`; v1 uses
`a4s-v1`, branch `integration/v1`, queue `a4s-v1`. They share GitHub origin and an
approved installed controller/reconciler, not candidate runtime identity. The
[operating runbook](docs/operations/deployment.md) owns commands and evidence
boundaries. Native links, scheduler configuration, GitHub settings and release
adoption remain separately authorized operator work.

## Development

```sh
npm ci
npm test
npm run typecheck
```

Status watcher unit tests own a temporary Git repository with an origin matching
their fake Dagu workspace. They run with the checkout's existing origin and path,
including local clones whose origin names differ from the fixture workspace.

Node.js >=22.19.0 and access to all pinned dependencies, including the private
Pion development release, are required for the full gate. See
[development prerequisites](docs/operations/private-install.md#prerequisites-and-development)
for CI's bounded alternative and explicit live-Dagu testing. CI's SHA-bound
`validate` aggregate targets `main` and `integration/v1`; deployment owns actual
branch protection. Historical removed-host source is preserved in `legacy`.
