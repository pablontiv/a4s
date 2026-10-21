# OMP Cross-family Review

An OMP extension that enforces strict eligibility using the canonical
`ctx.models.family` API. Every configured agent retains only candidates with a
resolved identity and a family outside its references. Exhaustion or an
indeterminate reference blocks the spawn with evaluated identities, families
and causes. Native quota fallback remains owned by OMP.

## Configuration

Requires OMP 18.12.5 or later and Bun >=1.3.14. The package registers the public
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
      fallbackRoles: ["@slow", "@default"]
      excludeTaskFamily: true
    qa:
      fallbackRoles: ["@slow", "@default"]
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

## Selection and quality-bound review

Native candidates precede the configured fallbacks. Eligible candidates retain
that order and are deduplicated by resolved provider/id, preserving the first
spec, alias or thinking suffix. Unresolved candidates cannot qualify; missing
parent/required `@task` identities or reference families fail closed. A resolved
alternative can qualify even when the original primary is unavailable. These
rules are uniform for every configured name.

For the Dagu feature quality gate, the guard binds the runtime-effective
implementer from its JSONL to the allocated task name. That reference is
authoritative in place of parent/`@task`; the agent's configured fallback list
still applies. A quality-bound spawn requires an explicit policy. Dagu retains
an independent strict preflight using the same effective configuration even
when this extension is absent, and independently admits only actual verdict
messages whose provider/model family differs from the implementer's. QA and
reviewer may share a family. A same-family effective runtime fallback blocks
publication even if initial selection qualified. TUI access to Dagu's store
makes this control advisory, not a sandbox.

## Installation and checks

From the permanent primary checkout:

```sh
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-cross-family-review"
```

Alternatively load the package directory with `omp -e /path/to/omp-cross-family-review`.
The `omp.extensions` manifest loads the maintained reloadable runtime entrypoint,
whose static public SDK imports share the host's active settings scope. The
package root exports the host-neutral hook, ordering and implementer-binding
APIs; the `./settings` subpath supplies the native reader for OMP integrations.
Selection runs after native initial model selection. Project configuration is
inherited by rebound child extension graphs; global model settings stay unchanged.

```sh
npm test -w @a4s/omp-cross-family-review
npm run typecheck -w @a4s/omp-cross-family-review
```

Tests run on the pinned development Bun runtime against the real public native
settings registry/scopes, including malformed initial values loaded before
extension registration. `npm install`/`npm ci` installs that runtime locally.

Issue #350 exercised the maintained hook in a fresh OMP 18.12.5 session with
process-local same-family candidates and roles. Real `reviewer` and
`triage-reviewer` tasks returned `CROSS_FAMILY_EXHAUSTED` diagnostics before child
execution. Unresolved-parent behavior is covered by unit tests.
