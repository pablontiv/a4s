# A4S OMP–Orca Integration

OMP extension for two contracts at the OMP–Orca boundary:

- worker lifecycle must be resolved before new orchestration work;
- every fresh worker must have an explicit agent and model route.

The extension is inert outside an Orca pane and when `orca orchestration run-current --json` reports no Run bound to the terminal. Orca remains the source of truth.

## Lifecycle guard

For a bound coordinator, the lifecycle module:

- queries local and connected-server workers with `orca orchestration worker-list --terminal-state reclaimable --include-remote --json` before each agent turn;
- adds every exact `projection.nextAction.argv` to the system prompt;
- blocks `orca orchestration check --ack` and fresh `worker-start` calls while reclaimable workers exist;
- allows `worker-start --terminal <handle>` only for a reclaimable terminal in the current Run;
- triggers at most one cleanup continuation per Run until inventory becomes clear;
- fails closed for guarded operations when inventory cannot be verified.

It never releases, retains, or reuses a worker automatically and keeps no duplicate worker ledger.

## Model router

The routing module uses OMP model roles rather than maintaining a second model table:

| Worker responsibility | OMP model role |
| --- | --- |
| Implementation | `@task` |
| Planning | `@plan` |
| Review | `@slow` |
| Security | `@slow` |
| Light research | `@smol` |

Before every coordinator turn it resolves those aliases through OMP's `ctx.models.resolve()` API. That API expands the role's configured candidate list and returns the first currently available model. Fresh OMP workers receive that concrete `provider/id`, so Orca can record and verify the requested and effective launch model.

OMP 18.10.3 rewrites any CLI `--model` override into the child session's `default` role. Therefore provider retries inside the worker use `retry.fallbackChains.default`, not the originating role's runtime chain. This is an explicit compatibility choice: role-specific model selection is preserved; role-specific runtime retry identity is not. The router blocks `@role` values on fresh OMP starts so the coordinator cannot accidentally assume otherwise.

It also blocks fresh `worker-start` calls missing either `--agent` or `--model`, and concrete OMP model specs that do not resolve through the current OMP registry. `--terminal` reuse remains unchanged because reused terminals keep their existing model.

The extension does not infer task responsibility by parsing shell text. The coordinator selects a route from the injected policy. Pass `routing.routes` to `createOrcaOmpIntegration` to replace the responsibility-to-role mapping; concrete model selection still belongs to OMP.

## Install globally

Add the package root to the user-level OMP `extensions` setting:

```yaml
extensions:
  - /absolute/path/to/a4s/packages/orca-omp-integration
```

Every new OMP session discovers the reloadable shim automatically. The A4S wrapper intercepts `/reload-plugins` and imports a fresh wrapped implementation generation; native OMP separately refreshes its resource discovery. The wrapper implementation defers a busy-session request until idle after `agent_end`, shuts down the old generation before starting the new one (2000 ms per lifecycle handler), and retains the previous generation after import/factory failures. Issue #421 recorded real busy-turn deferral through `agent_end`, followed at idle by old-generation shutdown, new-generation start, and one new-generation callback; native idle reload and builtin skill rediscovery were separately observed. See the [helper verification record](../hot-reload/README.md#verification-recorded-for-issue-421) for the exact versioned, compositional, and source-selection evidence boundaries. Loading globally remains an operator action; both Orca modules are inert outside an Orca pane with a bound orchestration Run.

This applies to the a4s extensions that declare a reloadable shim, not third-party extensions. Restart OMP to reload the shim, package binding, or `@a4s/hot-reload` helper itself. Removed commands and tools remain registered: commands warn that a restart is needed, and removed tools throw on execution. Description/schema changes and autocomplete entries for new commands also require a restart. Local modules created after startup and imports using bare specifiers are not refreshed.

For a one-off smoke run instead:

```sh
omp --no-extensions -e /absolute/path/to/candidate/packages/orca-omp-integration
```

The CLI resolves from `ORCA_CLI_COMMAND`, then `orca-dev` in a development checkout, `orca-ide` on Linux outside a managed pane, and finally `orca`. Pass `cliPath` to either module to override it. The package also exports `createOrcaLifecycleGuard` and `createOrcaModelRouter`; each module file has its own default extension export.

## Development

```sh
npm test --workspace @a4s/orca-omp-integration
npm run typecheck --workspace @a4s/orca-omp-integration
git diff --check
```
