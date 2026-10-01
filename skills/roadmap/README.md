# Roadmap

Roadmap is a Markdown mechanism over a repository's Beads backlog: plan, tree, Doctor and a sequential autonomous loop. Each repository's way of working (method, checks, readiness, failure handling, delivery, controller identity) lives in its `.workspace/config.yaml`, not in the skill (ADR 0059). When Roadmap presents an existing Bead, it keeps the primary human Description together with Bead ID, observable Result, and Scope; missing values remain missing or unknown without inference, readiness impact, mutation, or backfill.

## Commands

```text
/roadmap                    render the pending decision tree (read-only)
/roadmap plan <outcome>     propose a graph, ask approval, create it
/roadmap doctor [id]        find backlog problems and fix them in one approved pass
/roadmap loop [id]          execute ready tasks one at a time until nothing executable remains
/roadmap <bead-id>          same as loop <bead-id>
```

## Dependencies

- Beads 1.3.x `bd` for backlog state and graph operations;
- Git for candidate state;
- the effective `.workspace/config.yaml`; the axes Roadmap reads are listed in `references/contracts.md`.

## Verification

1. Real run first: after a change, run `loop` on a repository with executable work and record tasks closed, tasks skipped with reason, and the stop reason. A change that does not keep or improve that result is not accepted.
2. Fresh-agent scenarios (give the agent `SKILL.md`, `contracts.md` and the routed reference):
   - an incomplete higher-ranked task plus a complete task: with `skip`, the complete task runs;
   - a task whose review fails: it is blocked with `ROADMAP_RESULT v2 verdict=fail` and the loop continues;
   - two sessions start the same task: exactly one guarded start wins;
   - an interrupted task is resumed by takeover from its checkpoint;
   - `controller_identity` missing: Loop acquires nothing and names the value;
   - Doctor with several findings produces one proposal with all questions;
   - a status question during a task does not stop the loop.
3. Mechanical checks:

```bash
test -z "$(find skills/roadmap -type f ! -name '*.md' -print)"
! rg -n 'Superpowers|superpowers-|PI_SESSION_ID' skills/roadmap/SKILL.md skills/roadmap/references
test "$(cat skills/roadmap/SKILL.md skills/roadmap/references/*.md | wc -w)" -lt 4000
git diff --check
```

## Loading boundary

The repository copy under `skills/roadmap/` is the maintained source. A4S does not install Roadmap, Sweep, or Herdr into user-global skill directories. Harnesses that consume this repository select the repository skill explicitly and must not treat a user-global copy as authority. A Roadmap run never edits `skills/roadmap`; changes use a separate bounded change and the risk-based controls in `.workspace/config.yaml`.
