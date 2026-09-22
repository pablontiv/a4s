# Beads autonomous loop: deterministic adapter and global skill

**Status:** proposed
**Date:** 2026-09-22
**Bead:** `a4s-b32`
**ADR:** [0032](../adr/0032-beads-loop-adapter.md)

## Intent

Give a new agent session one portable command, `/beads-loop`, that works only from the current Git repository containing `.beads/`. It repeatedly executes the next canonical Bead until `bd ready` reports no ready work. Beads remains the sole backlog and lifecycle authority.

## Boundaries

- No `--repo`, root Bead ID, Rootline, Herdr, scheduler, daemon, queue, or state store.
- No `bd --global`, `bd remember`, or `bd memories`.
- The adapter never chooses a Bead itself. `bd ready --claim --json` selects and atomically claims the next one.
- The skill executes one claimed Bead per iteration; it never claims the next one through `bd close --claim-next` or `--continue`.
- Outside a Git checkout with `.beads/`, the adapter returns `not_beads_repo` and makes no write.

## Layout

```text
skills/beads-loop/
├── SKILL.md
├── scripts/beads_loop.py
├── tests/
└── fixtures/
```

The standard-library Python adapter is self-contained and runs `bd` as its provider. It emits versioned JSON and may only mutate through the documented `bd` commands.

## Adapter contract

### `prime`

`beads_loop.py prime` resolves the current Git root and `.beads/`, then:

1. runs `bd doctor --agent --json`;
2. if and only if it returns the documented `embedded_unsupported` result, runs `bd doctor --check conventions --agent --json`;
3. runs `bd prime --no-memories`, records only its command outcome, and discards all textual output;
4. runs `bd ready --sort priority --json`.

It returns `ready`, `no_ready`, `blocked`, `not_beads_repo`, or `doctor_failed`. `prime` is read-only. The `bd prime` text is never supplied to the agent because its stock template still mentions `remember` and `memories` even with `--no-memories`.

### `claim`

`beads_loop.py claim` repeats `prime` immediately before calling:

```sh
bd ready --sort priority --claim --json
```

It then reads the returned ID with `bd show <id> --json`, requiring `in_progress` and the current actor as assignee. It returns `claimed`, `no_ready`, or `claim_lost`; a post-claim mismatch never starts work. An epic returned by `bd ready` is valid: the adapter does not reinterpret the CLI's canonical priority/order.

### `finalize`

`beads_loop.py finalize --bead ID --verdict pass|fail --evidence PATH` requires an existing regular evidence file within the current repository.

- `pass`: `bd close ID --reason "evidence=PATH"`.
- `fail`: `bd update ID --status blocked --append-notes "FAIL evidence=PATH"`.

There is no synthetic `failed` Beads status. Both paths re-read the Bead and emit its final observed state. No automatic next claim is permitted.

## Skill flow

`/beads-loop` invokes `prime`. For `ready`, it invokes `claim`, reads the claimed description and acceptance criteria, performs exactly that work, writes a bounded evidence report under the current repository, runs applicable validation, and invokes `finalize`. It repeats only after the final state is read back. `blocked`, `doctor_failed`, `claim_lost`, or failed validation are reported with evidence; no guess, retry storm, or out-of-repo work occurs.

## Incremental verification

1. **Read-only guard:** fake `bd` tests and a real temporary `bd init` repository prove Git/.beads detection, embedded doctor fallback, `prime` output discard, and no writes.
2. **Selection and claim:** fake graph tests plus two concurrent real adapter processes prove that one and only one process claims the CLI-selected Bead.
3. **Finalize:** tests and manual temporary-repo checks prove `pass` closes only the claimed ID and `fail` blocks it with an evidence reference.
4. **Skill E2E:** a headless temporary Beads repository with ready, blocked, and closed Beads proves one-iteration execution, re-prime, terminal `no_ready`, and no provider/LLM/Rootline/Herdr usage.

Every increment includes a documented manual command sequence and a local headless E2E. Global installation is a later, explicitly authorized deployment: symlink the completed self-contained directory once into `~/.agents/skills/beads-loop` and `~/.claude/skills/beads-loop`, then verify no duplicate runtime skill shadows it.

## Acceptance criteria

- `/beads-loop` operates only in the current Beads Git repository and exits safely elsewhere.
- `bd` determines every selected Bead and performs atomic claim.
- The adapter is deterministic, self-contained, branch/repository-local, and uses no Beads memories.
- Success closes with evidence; failure blocks with evidence; neither advances implicitly.
- Headless, concurrency, real temporary-repo E2E, and manual validations cover every delivery.
