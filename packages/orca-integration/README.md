# A4S Orca Integration

Private workspace `@a4s/orca-integration`, loaded from `packages/orca-integration`.
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

The supported OMP host rewrites any CLI `--model` override into the child session's `default` role. Therefore provider retries inside the worker use `retry.fallbackChains.default`, not the originating role's runtime chain. This is an explicit compatibility choice: role-specific model selection is preserved; role-specific runtime retry identity is not. The router blocks `@role` values on fresh OMP starts so the coordinator cannot accidentally assume otherwise.

It also blocks fresh `worker-start` calls missing either `--agent` or `--model`, and concrete OMP model specs that do not resolve through the current OMP registry. `--terminal` reuse remains unchanged because reused terminals keep their existing model.

The extension does not infer task responsibility by parsing shell text. The coordinator selects a route from the injected policy. Pass `routing.routes` to `createOrcaOmpIntegration` to replace the responsibility-to-role mapping; concrete model selection still belongs to OMP.

## Install globally

Use the Node.js requirement in root `package.json` `engines.node`, including
standalone consumers. Add the package root to the user-level OMP `extensions` setting:

```yaml
extensions:
  - /absolute/path/to/a4s/packages/orca-integration
```

Every new OMP session discovers the reloadable shim automatically. The A4S wrapper intercepts `/reload-plugins` and imports a fresh wrapped implementation generation; native OMP separately refreshes its resource discovery. The wrapper implementation defers a busy-session request until idle after `agent_end`, shuts down the old generation before starting the new one (2000 ms per lifecycle handler), and retains the previous generation after import/factory failures. Issue #421 recorded real busy-turn deferral through `agent_end`, followed at idle by old-generation shutdown, new-generation start, and one new-generation callback; native idle reload and builtin skill rediscovery were separately observed. See the [helper verification record](../hot-reload/README.md#verification-recorded-for-issue-421) for the exact versioned, compositional, and source-selection evidence boundaries. Loading globally remains an operator action; both Orca modules are inert outside an Orca pane with a bound orchestration Run.

This applies to the a4s extensions that declare a reloadable shim, not third-party extensions. Restart OMP to reload the shim, package binding, or `@a4s/hot-reload` helper itself. Removed commands and tools remain registered: commands warn that a restart is needed, and removed tools throw on execution. Description/schema changes and autocomplete entries for new commands also require a restart. Local modules created after startup and imports using bare specifiers are not refreshed.

For a one-off smoke run instead:

```sh
omp --no-extensions -e /absolute/path/to/candidate/packages/orca-integration
```

The CLI resolves from `ORCA_CLI_COMMAND`, then `orca-dev` in a development checkout, `orca-ide` on Linux outside a managed pane, and finally `orca`. Pass `cliPath` to either module to override it. The package also exports `createOrcaLifecycleGuard` and `createOrcaModelRouter`; each module file has its own default extension export.

## Development

```sh
npm test --workspace @a4s/orca-integration
npm run typecheck --workspace @a4s/orca-integration
git diff --check
```

## Issue #423 verification

Runtime candidate: `dagu/issue-423` at
`1fcb05d2c15519c476a0f12cceba5ab5a1e0482e`, in run
`a4s-issue-423-s01a16671`. The extension entry, reloadable shim, lifecycle guard,
model router and relative imports are unchanged by the relocation. The Pi-named
host dependencies remain part of the package contract. CI discovers the canonical
workspace from its manifest; its integration fixture covers selection of
`@a4s/orca-integration`.

### Targeted checks

The implementation job reran these commands from the candidate root after
reading the retained quality findings:

| Command | Observed result |
| --- | --- |
| `npm test --workspace @a4s/orca-integration` | 21 passed, 0 failed |
| `npm run typecheck --workspace @a4s/orca-integration` | `tsc --noEmit`, exit 0 |
| Lifecycle CI/template tests (now `packages/issue-lifecycle/test/bundle-template.test.ts`), with `--test-name-pattern '^CI '` | 6 passed, 0 failed |

Dagu owns the full repository gate.

### Native OMP–Orca smoke: PASS

The [operator's issue evidence](https://github.com/pablontiv/a4s/issues/423#issuecomment-6357832625)
reports all five smoke steps passing on the runtime candidate above. The invocation
was `omp --no-extensions -e <worktree>/packages/orca-integration`, from an actual
Orca coordinator pane bound to a disposable orchestration Run.

| Acceptance observation | Operator-reported result |
| --- | --- |
| Resolve configured responsibility roles to concrete models | PASS: `@task` resolved to `cursor/composer-2.5`; `@slow` resolved to `anthropic/claude-opus-5` |
| Reject a fresh `worker-start` without `--agent` / `--model` | PASS: blocked with the resolved-model hint |
| Start a real disposable OMP worker with explicit agent and concrete model | PASS: `--agent omp --model cursor/composer-2.5`; Orca's `launch.requested.model` equaled `launch.effective.model` |
| Guard new work while a reclaimable worker exists and resolve the worker through Orca's exact projected action | PASS: the guard named `["orchestration","worker-release","--dispatch",…]`; the exact returned argv was executed, leaving reclaimable count 0 |
| Remain inert outside a bound Run | PASS: the router directive was absent; Orca fenced `worker-start` with `consumer_fenced` |

The operator also reported 21/21 workspace tests passing, released or closed the
disposable worker and probe terminals, and observed a clean candidate worktree.
Authentication used a temporary agent directory; the production profile was not
modified. The table records the operator's runtime evidence, rather than a smoke
rerun by the Dagu implementation job.

The earlier implementation attempts had been blocked by isolated authentication
(`No API key found for openai.`) and missing sender-pane context
(`no_active_sender_terminal`). The subsequent operator smoke supplies the
real-pane evidence requested by the retained reviewer finding; those earlier
attempts are not the current acceptance result.

