---
tipo: spec
---
# Beads-loop repair

## Purpose

Restore a healthy embedded Beads gate for A4S without weakening the adapter's fail-closed contract, and make every known execution path of `beads-loop` observable through deterministic tests plus bounded real-environment smoke checks.

## Success criteria

- `bd lint` reports no template warnings for the 23 affected A4S issues.
- `bd orphans` reports no orphaned issues.
- `bd doctor --check conventions --agent --json` returns `overall_ok: true` in A4S.
- The adapter's complete path matrix passes, including every terminal envelope and command boundary.
- A headed Pi probe loads `/skill:beads-loop`; a non-interactive Pi probe reaches a terminal adapter envelope.
- A novel or malformed provider response fails closed as one versioned envelope, with neither a traceback nor a provider mutation.

## Scope

This repair covers only A4S:

1. source-backed completion of Bead descriptions that `bd lint` identifies;
2. reconciliation of stale orphan `a4s-ya4.11`;
3. adapter path-matrix tests and documented non-mutating smoke checks.

It does not introduce a Dolt server, modify Homeserver, relax the embedded conventions gate, change Bead ownership rules, or rewrite unrelated historical documentation.

## Evidence policy

Every missing section must be derived from the issue description, its parent, linked records, accepted documents, or committed implementation artifacts. A repair must cite its source in the repair report. If those sources do not establish the missing fact, the section remains unchanged and is reported as an exception; passing lint is never a reason to invent requirements.

Description repair does not modify title, priority, dependencies, status, or assignee.

## Orphan reconciliation

`a4s-ya4.11` is a stale `in_progress` Bead assigned to `Pablo`. Commit `e344c3e` is reachable from `HEAD` and claims the intended `TASK_RESULT` harvest-close implementation.

Before any status change:

1. verify the committed implementation and focused tests;
2. write an in-repository evidence report containing the commit, changed artifacts, commands, exit results, and bounded output;
3. re-read the Bead.

Only a successful evidence review may close it, using the ADR 0033 preconditions: assignee remains `Pablo` and status remains `in_progress`. The update must be conditional, append the evidence path, and be re-read afterwards. A stale guard, ownership mismatch, or failed validation leaves the Bead unchanged.

## Execution-path matrix

The deterministic adapter suite must name and exercise the following paths:

| Boundary | Required cases |
| --- | --- |
| Repository guard | valid Beads repo; regular Git repo without `.beads`; unavailable Git executable; disappearing repository |
| Doctor | `{status:"ok"}`; generic `{diagnostics: [], overall_ok: true}`; malformed or ambiguous JSON; `overall_ok: false`; `embedded_unsupported` with conventions fallback both passing and failing |
| Prime | `bd prime` failure; ready command failure or malformed output; no ready issues; ready issues with valid IDs |
| Claim | atomic selection; empty race loser; malformed claim output; unresolved actor; post-claim owner/status mismatch |
| Finalize | invalid Bead ID/verdict; absent, outside-repository, or symlinked evidence; ownership/status mismatch; conditional guard loss; pass close; fail block; final read-back mismatch |
| CLI | each command serializes exactly one schema-versioned JSON envelope and does not leak provider stdout/stderr |

Fixtures encode provider responses and command sequences at the `run_bd` boundary. They must assert both the returned envelope and the commands issued, so a path cannot accidentally invoke `claim`, `update`, or a fallback it was not authorized to use.

## Real-environment smoke checks

These checks are read-only and never claim, finalize, or mutate a live Bead:

- a regular Git repository without `.beads` returns `not_beads_repo`;
- A4S exercises embedded detection and, after metadata repair, accepts the conventions fallback;
- Homeserver's generic doctor envelope is captured as a regression snapshot and accepted only when `overall_ok` is the boolean `true`;
- a PTY-headed Pi session loads `/skill:beads-loop`;
- a non-interactive Pi invocation reaches and preserves one terminal envelope.

The PTY check verifies command dispatch only. Adapter behavior remains validated by the deterministic matrix because model execution and terminal rendering are not a deterministic test oracle.

## Documentation governance

`.workspace/docs/specs/.stem` provides an isolated Rootline schema with optional `tipo: spec`. It does not invalidate or rewrite the seven historical specs. The repair spec and future records in this directory are created and validated through Rootline.

## Validation and reporting

The repair report must include the issue inventory, per-field evidence source, orphan evidence, changed files, path-matrix results, smoke-check results, and any unresolved evidence gaps.

Before completion run the narrowest applicable checks, followed by:

```sh
bd lint
bd orphans
bd doctor --check conventions --agent --json
python3 -m unittest skills/beads-loop/tests/test_beads_loop.py -v
rootline validate .workspace/docs/specs/2026-09-23-beads-loop-repair.md -o json
git diff --check
```

A failed evidence check or unproven content prevents closure; it must be reported rather than repaired speculatively.
