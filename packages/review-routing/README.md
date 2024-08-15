# Review Routing

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
      fallbackRoles: ["@slow", "@default", "@task"]
      excludeTaskFamily: true
    qa:
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

The private package `@a4s/review-routing` shares one process-global registry at
`Symbol.for("@a4s/review-routing/quality-implementers")`. Binding callers and
the reloadable hook consume the same one-shot binding across independently
loaded extension graphs. The current dispatch names remain `reviewer`, `qa`,
`triage-reviewer`, `plan-reviewer` and `security-reviewer`; the structured
quality role `qa` is a separate lifecycle contract.

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

Issue #350 exercised the maintained hook in a fresh OMP 18.12.5 session with
process-local same-family candidates and roles. Real `reviewer` and
`triage-reviewer` tasks returned `CROSS_FAMILY_EXHAUSTED` diagnostics before child
execution. Unresolved-parent behavior is covered by unit tests.

## Rename verification (#422)

The candidate ran `npm test --workspace @a4s/review-routing` (40 pass,
0 fail, Bun 1.4.2) and `npm run typecheck --workspace @a4s/review-routing`
(exit 0). Dagu consumer/CI-selection checks passed 171 tests, with two live-Dagu
skips and zero failures, followed by the lifecycle workspace's typecheck (exit 0).
The surviving template suite now lives at
`packages/issue-lifecycle/test/bundle-template.test.ts`; its typecheck command is
`npm run typecheck --workspace @a4s/issue-lifecycle`. CI continues to discover the
canonical manifest and declared consumers, including its existing typecheck script.

A fresh native OMP 18.12.6 SDK session loaded the candidate package roots with
explicit-only extension discovery and temporary agent/config/session directories.
All five named policies returned `CROSS_FAMILY_INDETERMINATE` when the parent
model was unavailable. A separately imported binding caller supplied
`Smoke422Quality`; the native reloadable hook consumed its canonical-registry
binding once, reported `CROSS_FAMILY_EXHAUSTED` with excluded family `openai`,
then returned the ordinary indeterminate-parent result on the next dispatch.
The session JSONL persists the observation as `review-routing-422-smoke`.

These are native hook observations, not successful child-task executions.
The retained evidence is
`.workspace/worktrees/smoke-422-HgRHaW/evidence.json` and the adjacent
`sessions/2026-10-23T04-44-10-964Z_01a16712-d954-73ea-a130-0b0154848c20.jsonl`.
The evidence JSON records the session's original temporary path; the adjacent
JSONL is the retained transcript in this worktree.

Native discovery selected the lifecycle package's then-present `agents/qa.md`,
`agents/triage-reviewer.md` and `agents/plan-reviewer.md` with `agentSource=user`
and canonical paths in the candidate checkout.
`reviewer` and `security-reviewer` resolved to `agentSource=bundled`,
`embedded:reviewer.md` and `embedded:security-reviewer.md`; these sources do
not satisfy the requested candidate-definition proof.

**Operational acceptance remains blocked.** The isolated catalog had zero
authenticated models. A separate native CLI attempt with
`omp --no-extensions -e <candidate>/packages/review-routing -e <candidate>/packages/issue-lifecycle --session-dir <temporary-sessions> --no-title --no-lsp --no-tools -p --model openai/gpt-5.2 "Reply only ROUTING422"` (package path migrated here)
and temporary `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` exited 1:
`No API key found for openai`. Effective authenticated child-model selection
and runtime response-family exclusions remain unproven. Resume with
operator-authorized credentials and candidate-native definitions for all
required roles, retaining persisted transcripts; production authentication and
profiles were left intact. This partial smoke is not an acceptance PASS.

The authorized implementation run `a4s-issue-422-s01a16671` repeated the four
targeted commands above successfully (40 routing tests; 171 consumer/CI tests,
2 live-Dagu skips; both typechecks exit 0). An environment-variable-name-only
inspection found no `API_KEY`, `AUTH_TOKEN` or `ACCESS_TOKEN` suffixes.
No authenticated retry was attempted without credentials. Resuming the smoke
requires operator-authorized authentication in the isolated native scope and a
decision on the candidate-native reviewer/security-reviewer definitions;
installing different role definitions is outside this package-identity rename.
