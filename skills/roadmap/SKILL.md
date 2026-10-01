---
name: roadmap
description: Use when planning work into Beads, inspecting pending backlog topology, aligning existing Beads with the Roadmap contract, or implementing the repository backlog sequentially.
argument-hint: "[plan|doctor|loop] [requirements|id]"
user-invocable: true
metadata:
  author: pablontiv
  updated: "2026-09-30"
---

# Roadmap

Roadmap is a mechanism over the current repository's Beads backlog: plan it, show it, align it, and execute it one task at a time. How a repository works — method, review, readiness, failure handling, delivery — is not defined here; it is read from the effective `.workspace/config.yaml`.

Interpret `$ARGUMENTS` without changing the working directory and load one recipe. Read `references/contracts.md` first.

| Input | Recipe |
| --- | --- |
| empty | `references/tree.md` (read-only) |
| `plan <outcome>` | `references/plan.md` |
| `doctor [id]` | `references/doctor.md` |
| `loop [id]`, or a bare Bead ID | `references/loop.md` |

For other wording, pick the mode the operator clearly means ("go", "sigue", "loop autónomo" mean `loop`). Ask one question only when two modes remain plausible.

## Authority

1. The operator's latest instruction in this session.
2. The effective `.workspace/config.yaml` (workspace, group and repository layers).
3. This skill.

Roadmap adds no gate, review, or stop the config does not declare. Plan and Doctor derive their proposal-and-choice behavior from `choose_work.intake` and `choose_work.changed_decision`: they show the exact Beads payload and wait for the operator's choice before mutating Beads.

Roadmap specializes presentation and autonomous-loop mechanics without adding normative authority, permissions, readiness, lifecycle, acceptance, or external effects. Whenever it shows an existing Bead to the operator, it keeps the primary human Description together with Bead ID, observable Result, and Scope. Missing values are shown as missing or unknown without inference, readiness impact, mutation, or backfill. Prospective Plan nodes follow Plan's existing proposal contract until Beads creates them.

The config axes Roadmap reads are listed in `contracts.md`. A missing axis takes its profile default; a missing config lets Tree, Plan and Doctor run but Loop acquires nothing.

## Invariants

- Beads is the only durable backlog state; the Bead is the task's record.
- Types are `epic` (optional, non-executable aggregate) and `task` (one-session unit, at root or under one epic).
- `parent-child` is hierarchy only; only `blocks` orders execution.
- A controller executes one task at a time and changes lifecycle only through guarded transitions.
- Never invent requirements; unknown material values are asked, not guessed.
- Never edit the Roadmap skill during a Roadmap invocation.
