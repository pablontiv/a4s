# Review Routing

An OMP extension that enforces strict eligibility using the canonical
`ctx.models.family` API. Every configured agent retains only candidates with a
resolved identity and a family outside its references. Exhaustion or an
indeterminate reference blocks the spawn with evaluated identities, families
and causes. Native quota fallback remains owned by OMP.

## Configuration

Host compatibility is pinned in `package.json` `peerDependencies`, the Bun
requirement in `engines.bun`, and the test runtime in `devDependencies.bun`.
Standalone consumers use the Node.js requirement in root `package.json` `engines.node`. The package registers the public
native setting `crossFamilyReview.policies`, a record keyed by **exact agent
name**, with default `{}`. Each entry has exactly two required fields:

- `fallbackRoles: string[]`: ordered model specs/roles appended after the native
  candidates; aliases and thinking suffixes are preserved.
- `excludeTaskFamily: boolean`: always exclude the parent family; additionally
  exclude the resolved `@task` family when true.

Declare adoption in the project's `.omp/config.yml`. a4s adopts:

```yaml
crossFamilyReview:
  policies:
    reviewer:
      fallbackRoles: ["@slow", "@default", "@task"]
      excludeTaskFamily: true
    security-reviewer:
      fallbackRoles: ["@slow", "@default"]
      excludeTaskFamily: true
    triage-reviewer:
      fallbackRoles: ["@task", "@slow", "@default"]
      excludeTaskFamily: false
    plan-reviewer:
      fallbackRoles: ["@task", "@slow", "@default"]
      excludeTaskFamily: false
```

Any custom agent can have its own entry. Unconfigured agents retain native OMP
input unchanged. The package distributes the schema and algorithm; the project
owns agent names and adoption. Native project/`--config` overlay precedence and
child-session scope inheritance apply to both `task` and eval `agent()`.
The active session is read through public `findScopedSettings(ctx.cwd)` and the
registered setting handle, rather than an assumed context settings field.
Late registration does not retroactively validate initial configuration, so
consumption explicitly calls native `assertWritable` on the effective raw value
and the handle value before model resolution or child dispatch. Invalid values
block with `CROSS_FAMILY_CONFIG`; an unavailable session scope also blocks.

## Parent-relative and task-relative selection

Native candidates precede the configured fallbacks. Eligible candidates retain
that order and are deduplicated by resolved provider/id, preserving the first
spec, alias or thinking suffix. Unresolved candidates cannot qualify; missing
parent/required `@task` identities or reference families fail closed. A resolved
alternative can qualify even when the original primary is unavailable. These
rules are uniform for every configured name.

Every configured agent excludes the resolved parent model family. When
`excludeTaskFamily` is true, it also excludes the resolved `@task` model family;
when false, selection is parent-relative only. The same configured fallback
ordering and strict eligibility rules apply in both cases.


## Installation and checks

From the permanent primary checkout:

```sh
omp plugin link "$(git rev-parse --show-toplevel)/packages/review-routing"
```

Alternatively load the package directory with `omp -e /path/to/review-routing`.
The `omp.extensions` manifest loads the maintained reloadable runtime entrypoint,
whose static public SDK imports share the host's active settings scope. The
package root exports the host-neutral hook and ordering APIs; the `./settings`
subpath supplies the native reader for OMP integrations.
Selection runs after native initial model selection. Project configuration is
inherited by rebound child extension graphs; global model settings stay unchanged.

```sh
npm test --workspace @a4s/review-routing
npm run typecheck --workspace @a4s/review-routing
```

Tests run on the pinned development Bun runtime against the real public native
settings registry/scopes, including malformed initial values loaded before
extension registration. `npm install`/`npm ci` installs that runtime locally.

Issue #350 exercised the maintained hook in a fresh session of the then-installed OMP with
process-local same-family candidates and roles. Real `reviewer` and
`triage-reviewer` tasks returned `CROSS_FAMILY_EXHAUSTED` diagnostics before child
execution. Unresolved-parent behavior is covered by unit tests.

## Rename verification (#422)

The candidate ran `npm test --workspace @a4s/review-routing` (40 pass,
0 fail on its manifest-pinned development Bun) and `npm run typecheck --workspace @a4s/review-routing`
(exit 0). Dagu consumer/CI-selection checks passed 171 tests, with two live-Dagu
skips and zero failures, followed by the lifecycle workspace's typecheck (exit 0).
The surviving template suite now lives at
`packages/issue-lifecycle/test/bundle-template.test.ts`; its typecheck command is
`npm run typecheck --workspace @a4s/issue-lifecycle`. CI continues to discover the
canonical manifest and declared consumers, including its existing typecheck script.

The original #422 print-mode smoke established extension loading but did not
complete a tool-bearing parent turn; its API snapshot alone did not prove native
review dispatch. The later [#431 isolated native walkthrough](../../docs/operations/v1-walkthrough.md)
completed a real `task(agent=reviewer)` and `wait`, selected the project definition,
and matched its canonical body in the child `session_init`. That bounded proof
does not establish every routing policy/fallback combination.

See [private installation](../../docs/operations/private-install.md) for loading the
whole package and canonical definitions, and the [source catalog](../../docs/architecture/catalog.md)
for ownership. This package routes reviewer models; definitions and lifecycle
admission remain separately owned.
