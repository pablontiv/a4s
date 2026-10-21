# OMP Cross-family Review

OMP extension selecting review models through the canonical `ctx.models.family`
API. Every configured review agent requires an available candidate with a resolved
family outside its excluded families. Missing parent identity or family blocks
before child execution. Exhaustion reasons list the excluded families and every
evaluated candidate's spec, provider/model identity, family and eligibility cause.

| Agent | Excluded families | Additional candidates, in order |
| --- | --- | --- |
| `reviewer`, `qa`, `security-reviewer` | Parent and resolved `@task` | `@slow`, `@default` |
| `triage-reviewer`, `plan-reviewer` | Parent | `@task`, `@slow`, `@default` |

Eligible requested candidates precede eligible role fallbacks. Resolved
provider/id pairs are deduplicated, preserving the first spec, aliases and thinking
suffixes. The selection note is `strict cross-family eligibility; effective
transcript identity must pass the publication gate`. Agents outside this table
retain native selection behavior. Runtime quota fallback remains OMP-owned.

## Feature quality integration

At the `dagu-feature` publication gate, `@a4s/omp-dagu` reads the effective
implementer's JSONL identity and binds that reference to the allocated QA/reviewer
name before dispatch. That reference replaces the parent/task references, with
`@slow`, `@default`, `@task` as additional candidates. QA and reviewer may share
a family; each must differ from the effective implementer.

`orderReviewModels(patterns, fallbackRoles, models, excluded)` always returns
strict eligibility or a block result. A resolved alternative can qualify even
when the requested primary is unavailable. The Dagu guard separately validates
effective verdict provider/model, provenance, SHA and family, and records actual
fallbacks. An effective same-family fallback blocks publication even if the
initial selection qualified. Direct TUI access to the Dagu store makes this an
advisory control rather than a sandbox.

## Installation

From the primary a4s clone on `main` (issue worktrees are removed after delivery):

```sh
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-cross-family-review"
```

Load a directory for one process with `omp -e /path/to/omp-cross-family-review`
without changing global settings. The hook runs after initial agent selection.

## Verification

```sh
npm test --workspace @a4s/omp-cross-family-review
```

Issue #350 additionally exercised the maintained hook in a fresh OMP 18.12.5
session with process-local candidate/role configuration restricted to the parent
family. Both real `reviewer` and `triage-reviewer` tasks returned
`CROSS_FAMILY_EXHAUSTED` errors naming `openai`, candidate identities and the
missing eligibility condition before child execution. Unresolved-parent behavior
is covered by unit tests; it was not observed in that live session.
