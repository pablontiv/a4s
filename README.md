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
- [Lane deployment and recovery](docs/operations/deployment.md): the main PRIMARY,
  stable controller/candidate segregation, adoption, rollback, active-run ownership
  and the completed temporary-v1-lane retirement.
- [Dated v1 walkthrough](docs/operations/v1-walkthrough.md): exercised commands,
  native source selection and isolated bootstrap/admission evidence, not deployment.
- [Agent operating contract](AGENTS.md).
- [OMP session-log compressor](docs/architecture/omp-session-log-compressor.md):
  spike #688 decision, descartar.
- [Tern meta-harness](docs/architecture/tern-meta-harness.md):
  spike #690 decision, descartar.
- [AGENTS.md TLDR per turn](docs/architecture/agents-tldr-per-turn.md):
  spike #691 decision, descartar.
- [Harness² vs issue-lifecycle](docs/architecture/harness2-issue-lifecycle.md):
  spike #692 decision, descartar.
- [1Password Agents](docs/architecture/onepassword-agents.md):
  spike #693 decision, descartar.

## Delivered components

| Source | Responsibility |
| --- | --- |
| [`packages/issue-lifecycle`](packages/issue-lifecycle/) | Dagu issue lifecycle, status, admission/resource guards, seven skills and specialized agents |
| [`packages/launcher`](packages/launcher/) | Separate stable `a4s-launch` binary, argv-routed exact payload selection, leases/state and operator-installed `a4s tick` DAG |
| [`packages/loader`](packages/loader/) | Operator-linked stable OMP loader, combined transactional status/triage switch, registration/resource gate and process-lifetime artifact leases |
| [`packages/review-routing`](packages/review-routing/) | Strict native OMP cross-family model selection |
| [`packages/hot-reload`](packages/hot-reload/) | Shared reloadable-shim generation/lifecycle helper |
| [`packages/orca-integration`](packages/orca-integration/) | Bound Orca worker lifecycle and explicit model routes |
| [`packages/context-management`](packages/context-management/) | Host-neutral transcript transformation and adaptive trigger core library |
| [`packages/agent-messaging`](packages/agent-messaging/) | Native OMP messaging protocol, transport and delivery |
| [`apps/message-bus`](apps/message-bus/) | Independently started durable loopback MQTT broker |
| [`packages/pi-tool-row-presentation`](packages/pi-tool-row-presentation/) | Retained Pi/Pion-specific tool rows with documented host limitations |

Independent root skills are [model-routing-audit](skills/model-routing-audit/SKILL.md),
[gpt-quota-audit](skills/gpt-quota-audit/SKILL.md),
[cost-analyzer](skills/cost-analyzer/SKILL.md),
[agent-throughput](skills/agent-throughput/SKILL.md),
[workspace-hygiene](skills/workspace-hygiene/SKILL.md) and
[sandbox-threat-model](skills/sandbox-threat-model/SKILL.md). Their full directories stay
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

Main is the only active lane: independent `a4s` clone, branch `main`, queue `a4s`.
The temporary v1 lane was retired after release and proof (#435–#438).
The [operating runbook](docs/operations/deployment.md) separates historical
station evidence from the release cutover. New admission requires schema-2
consumer policy and selects `state.current`; the launcher verifies its immutable
release into `$DAGU_HOME/cache/a4s/<version>/` and hands off to the compiled
executable. Successors keep the parent's artifact tuple. a4s never writes station
config or restarts services. Initial launcher/plugin installation, runtime
environment, Dagu queue capacity and the unpinned tick DAG are operator work.

## Development

```sh
npm ci
npm test
npm run typecheck
```
`npm test` and CI run only each workspace's top-level `test/*.test.ts`
(`*.test.cjs` for message-bus), never `test/live/`. Every default test script
preloads `scripts/test-no-spawn.mjs`: tests execute logic in-process and may
spawn only direct `git`/`tar`, not CLIs, shells, Dagu, GitHub or compiled builds.
The guard names the offending test file. Default suites need neither the
station heavy slot nor forced serial test-file execution.

Release builds use `r<N>` (the validated source SHA's full-history first-parent
commit count). After CI `validate` succeeds for that exact pushed `main` SHA,
the release workflow publishes changed shipped inputs as immutable `a4s-r<N>`
releases; it creates tags itself and rejects ID/SHA or rerun-digest conflicts.
Historical SemVer tuples remain readable and restorable. Publication does not
switch the station or write station/service configuration.

Native CLI, YAML, OS-lock, compiled-artifact and timing scenarios are opt-in:

```sh
A4S_GATE_JOURNAL= npm run test:live --workspace @a4s/issue-lifecycle
npm run test:live --workspace @a4s/agent-messaging
npm run test:live --workspace @a4s/message-bus
```

Live scripts select only `test/live/` and omit the spawn guard. The lifecycle
script sets `A4S_LIVE_DAGU=1` and retains heavy-slot serialization; setting that
variable on `npm test` never changes its lane. Release-archive acceptance uses
the lifecycle's separate `test:compiled` command. The optional Bun-only Kiro
provider has no default `test` script and remains outside the root gate.
All lifecycle test lanes automatically isolate `HOME` and `DAGU_HOME` in a
temporary directory per test process. Keep the service's canonical `DAGU_HOME`
in the invoking shell: the native wrapper acquires the inherited station-wide
heavy-slot lock before isolation. That orchestration lock is the single explicit
exception; test processes, fixtures and subprocess artifact caches stay isolated.


Live status-watcher tests own a temporary Git repository with an origin matching
their fake Dagu workspace. They run with the checkout's existing origin and path,
including local clones whose origin names differ from the fixture workspace.

The Node.js requirement is pinned in root `package.json` `engines.node`; registry
access to the locked dependencies is required. Shared development tools are
declared once in root `devDependencies` and resolved by workspace scripts.
The lifecycle's `test/version-pins.test.ts` rejects copied Dagu, Node and shared
development-tool versions in tracked source; manifests own compatibility ranges,
and protected historical evidence remains unchanged.
Root and CI run all nine workspace test suites and eight declared typechecks;
the optional-host tool-row workspace is test-only because its renderer types
belong to the consumer's Pion host. See
[development prerequisites](docs/operations/private-install.md#prerequisites-and-development)
for explicit live-Dagu testing. CI's SHA-bound `validate` aggregate validates
pull requests to `main`; deployment owns actual branch protection.
Historical removed-host source is preserved in `legacy`.
