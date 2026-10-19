# herdr-reap — fail-closed reaper for orphaned Herdr tabs

Bead: **a4s-1to.2** (child of epic **a4s-1to**, "Gestionar teardown de tabs y
huérfanos Herdr"). Companion to the event-driven teardown a4s-1to.1.

## Problem

If a Project Orchestrator dies before running teardown, Herdr accumulates
finished (`agent_status=done`) tabs. Herdr has no native TTL/reaper — the server
is a persistent multiplexer, not a loop host. This is a **safety net**, invoked
by an OS scheduler, not by an agent loop or a Pi package.

## What it does

Enumerates every Herdr tab, joins it to its agent (`herdr agent list`) and its
governing bead (canonical `bd` note binding), and classifies each into:

| Decision   | Meaning                                                            |
|------------|-------------------------------------------------------------------|
| `REAP`     | Every guard passed — eligible to close.                           |
| `KEEP`     | Still live / focused / fresh / bound to an open bead / protected. |
| `ATTENTION`| Done+idle but unreconcilable (no bead binding, or dirty worktree). Reported, **never** auto-closed. |

### Reap guards (conjunctive — ALL required)

1. Tab has an agent and `agent_status == "done"`.
2. Neither tab nor agent is `focused`.
3. Not protected: mission-control / `mc` pane, the reaper's own tab
   (`$HERDR_TAB_ID`), or a workspace's sole/active tab.
4. Idle age (now − mtime of the agent's session `.jsonl` transcript) exceeds
   `--idle-threshold`. Unknown idle age ⇒ KEEP.
5. **Callback harvested**: tab/pane is bound via the canonical note
   `worker=<name> pane=<pane-id> tab=<tab-id> kind=<kind> model=<route>` to a
   bead whose status is `closed`. Open bead ⇒ KEEP; no binding ⇒ ATTENTION.
6. Worktree clean **and** merged into `--main-branch` (or a clean checkout
   already on main). Dirty/unknown ⇒ ATTENTION.

Fail-closed: any read failure, missing data, or ambiguity resolves to KEEP or
ATTENTION — never REAP. If the `herdr` liveness probe fails the run is a no-op
(exit 2).

### Scope boundary

Closes **Herdr tabs only**. It never deletes worktrees, branches or PRs — that
stays with `sweep` (see epic a4s-1to constraints).

## Usage

```bash
# Dry-run (DEFAULT — reports, closes nothing):
./skills/herdr/scripts/herdr-reap

# Restrict to a workspace, custom idle threshold, JSON, saved report:
./skills/herdr/scripts/herdr-reap --workspace w4J --idle-threshold 7200 --json --report /tmp/reap.json

# Authorize real closing (explicit, separate from dry-run):
./skills/herdr/scripts/herdr-reap --close
```

Flags: `--workspace <id>` (repeatable), `--idle-threshold <s>` (default 3600),
`--main-branch <name>` (default `main`), `--close`, `--json`, `--report <path>`.

## Scheduling

**macOS (launchd)** — `com.a4s.herdr-reap.plist` in this directory runs the
reaper every 30 min in dry-run. Edit the absolute repo path inside it, then:

```bash
cp skills/herdr/scripts/com.a4s.herdr-reap.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.a4s.herdr-reap.plist
```

To authorize real closing, add `--close` as its own `<string>` in the plist's
`ProgramArguments`, then re-bootstrap.

**Other environments (cron)** — dry-run every 30 min, report to a file:

```cron
*/30 * * * * HERDR_ENV=1 PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  /usr/bin/python3 /Users/Shared/harness/a4s/skills/herdr/scripts/herdr-reap \
  --idle-threshold 3600 --report /tmp/herdr-reap.report >> /tmp/herdr-reap.log 2>&1
```

Add `--close` to the command only when real closing is authorized.

## Non-goals (bead a4s-1to.2)

No daemon / self-hosted package, no new Pi integration, no agent loop, no
subagents. `pi-tick` is reconsidered only if A4S later standardizes several
scheduled Pi tasks (see bead notes and epic a4s-ya4).

## Tests

```bash
python3 skills/herdr/tests/test_herdr_reap.py
```

Pure-core guard tests over representative tab states; zero third-party deps.
```
