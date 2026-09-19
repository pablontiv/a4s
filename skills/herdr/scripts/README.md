# a4s-reconcile

Deterministic reconciler for the Herdr/Beads loop: **only `bd` + `herdr`, zero LLM, no messages**. It replaces the soft heartbeat-as-prompt. Executor is launchd/cron, never an agent. `skills/herdr/SKILL.md` defines the worker-link (`metadata.worker|pane|tab`) it reads.

## Tick (idempotent)

| # | Source of truth | Action |
|---|---|---|
| 0 | Mission Control ownership (see below) | gate: absent/duplicated/stale/ambiguous → AttentionTicket, **no mutation this tick**; re-checked before every dispatch/close/reap |
| 1 | `bd ready` (opt-in label, work-type Beads) | claim → `herdr tab create` → stamp worker → `agent start` → `agent prompt` with the Bead's content |
| 2 | `bd in_progress` + `herdr agent get <metadata.worker>` | `working` leave · `done` harvest tail + `bd close` · `NOT_FOUND` re-dispatch (max 2) · `blocked` AttentionTicket · `idle`/unknown/pane mismatch AttentionTicket |
| 2b | `bd in_progress` **without** `metadata.worker` | see "Unlinked in_progress rule" |
| 3 | `bd closed` with `metadata.tab` + live tab | `herdr tab close` (skipped if <120s old, agent still working, foreign agent, shared/multi-pane tab, or own tab) |
| 4 | status `blocked` or label `needs-decision` | AttentionTicket file under `$XDG_STATE_HOME/a4s/reconcile/attention/` — evidence only, no lifecycle mutation |
| 5 | re-run over unchanged state | plans nothing (tickets are keyed by bead+kind+facts digest) |

Guards: Herdr server not running → no-op. Unknown status, name/pane mismatch, missing workspace/callback, `kind` other than `claude|pi` → fail closed. A snapshot error aborts the tick (exit 3) before any mutation.

## Mission Control safety gate (fail closed)

Before any dispatch/recovery/close/reap the canonical MC is discovered by **owner + lease + session identity, never by label alone**:

- Ownership record = exactly one `in_progress` Bead labelled `mission-control` (the label is only the lookup index) with a live lease (`lease_expires_at` + `--mc-grace`, default 60s) and identity metadata `pane`, `tab`, `workspace` plus `terminal_id` and/or `session` (the pi/claude session file). The live herdr pane must exist, host an agent, and match every recorded field.
- Anything labelled `mc` / `mission-control` (tab or workspace) that is not that owner is a *claimant*, not an owner.
- Verdicts: `ABSENT` (no owner Bead) · `DUPLICATED` (>1 owner Bead, or a second label-only claimant) · `STALE` (lease expired / no lease / owner pane gone) · `AMBIGUOUS` (identity metadata missing or mismatching the live pane). Any verdict but `OK` → one `MC_GATE_<verdict>` AttentionTicket, **zero bd/herdr mutations**, no auto-resolution. Exit 0 (the ticket is the signal).
- Never-mutate guard: the reconciler's herdr vocabulary is an allowlist (`tab create|close`, `agent start|prompt`); `pane *`, `workspace *`, tab rename/move are refused. Targets that are mc-labelled or MC-owned (pane, tab, agent, the whole `mission-control` workspace, an `mc`-labelled new tab) are refused in `mutate()` — in dry-run too — and ticketed `MC_PROTECTED`. It never creates, moves or relabels an mc pane; relocation/promotion is an Operator + incumbent-MC handshake with a handover artifact.
- MC ownership Bead is untouchable: the current owner Bead, any Bead labelled `mission-control`, and any Bead whose `worker`/`pane`/`tab`/`workspace` metadata points at an MC-owned target are filtered out of harvest-close, re-dispatch (`NOT_FOUND` and unlinked), claim/dispatch and the reaper, and `mutate()` refuses every bd write aimed at them (`GuardViolation`, dry-run too). Only MC/the Operator changes that Bead.
- Registering MC (Operator/MC, not the reconciler): `bd create "Mission Control ownership" --type task --label mission-control`, claim it, `bd update <id> --set-metadata pane=… --set-metadata tab=… --set-metadata workspace=… --set-metadata terminal_id=… --set-metadata session=…`, and `bd heartbeat <id>` inside the lease TTL. Until that exists the reconciler is a ticket-only observer.

## Unlinked in_progress rule (no `metadata.worker`)

Deterministic, evaluated in order: (1) an agent tied to the Bead without the link — name or tab label contains the Bead id, `metadata.pane`/`tab`, or cwd == the Bead's own `metadata.worktree|cwd` — `working` → leave, `blocked` → `WORKER_BLOCKED` ticket, other → leave unless stale, then `UNLINKED_WORKER_IDLE` ticket; (2) live lease → leave; (3) last activity (max of lease expiry, heartbeat, updated, started) newer than `--stale-after` (1800s) → leave; (4) stale, no live agent → **re-dispatch in a new tab** (no re-claim, `redispatch` counter, reuses `metadata.worktree` as cwd) iff opt-in label, `assignee == actor`, work-type Bead, `--callback` set and `redispatch < --max-redispatch`; otherwise a `STALE_UNLINKED` ticket with the blockers. Parent ids also match children's names/labels — conservative: that can only suppress action. Re-dispatch and ready dispatch share one `--max-dispatch` budget per tick.

## Closing actor (bd assignee guard)

`bd` refuses writes by an actor other than the assignee, and `--actor` overrides `$BEADS_ACTOR`. Reconciler and Workers therefore run `BEADS_ACTOR=<assignee> bd close|update …` and never pass `--actor` or `--force`. Tradeoff: `bd`'s audit trail shows the assignee as the closer; the real actor is kept in the close `--reason` (`closed_by=a4s-reconcile worker=<name>`) and in `$XDG_STATE_HOME/a4s/reconcile/audit.jsonl` (one JSON line per applied mutation). Operator/Jev decision; revisit if `bd` grows a delegated-actor field.

## Usage

```bash
# Default is DRY-RUN: prints planned actions, mutates nothing (bd runs with --readonly).
skills/herdr/scripts/a4s-reconcile --callback <orchestrator-pane>

# Dry-run planning as if the MC gate were open (read-only; refused with --apply)
skills/herdr/scripts/a4s-reconcile --callback <orchestrator-pane> --plan-ignoring-mc-gate

# Mutating tick (what launchd runs)
skills/herdr/scripts/a4s-reconcile --apply --callback <orchestrator-pane>
```

Dispatch is **opt-in**: only ready Beads labelled `auto-dispatch` (`--dispatch-label ''` widens it to every ready task/bug/feature/chore/spike; epics never). Optional per-Bead `metadata`: `kind` (`claude`|`pi`, default `claude -- --model sonnet`), `model`, `cwd` (absolute dir; give concurrent mutating Beads their own worktree). The reconciler stamps `worker`, `pane`, `tab`, `dispatched_at`, `redispatch` (and `prev_tabs`/`prev_workers` on re-dispatch) before starting the agent, so a crash mid-dispatch self-heals through `NOT_FOUND`.

## launchd (documented, not installed)

`dev.a4s.reconcile.plist` is a template (StartInterval 45s). To adopt:

```bash
sed -e "s#__REPO__#[REDACTED:shared-root]/harness/a4s#g" -e "s#__HOME__#$HOME#g" -e "s#__CALLBACK__#<orchestrator-pane>#g" \
  skills/herdr/scripts/dev.a4s.reconcile.plist > ~/Library/LaunchAgents/dev.a4s.reconcile.plist
mkdir -p ~/.local/state/a4s/reconcile
plutil -lint ~/Library/LaunchAgents/dev.a4s.reconcile.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.a4s.reconcile.plist   # enable
launchctl bootout gui/$(id -u)/dev.a4s.reconcile                                  # disable
```

Run a dry-run by hand first. Cron alternative: `* * * * * /usr/bin/python3 <repo>/skills/herdr/scripts/a4s-reconcile --apply --repo <repo> --callback <pane>`.

## Tests

`python3 -m unittest discover -s skills/herdr/tests -t skills/herdr` — offline, fake `bd`/`herdr` via `A4S_BD`/`A4S_HERDR` (MC gate verdicts, unlinked rule, mc-pane-never-mutated, idempotency).
