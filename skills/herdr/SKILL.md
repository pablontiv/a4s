---
name: herdr
description: "Control Herdr, the terminal multiplexer for coding agents, over the `herdr` CLI: inspect/control workspaces (spaces), tabs, panes, and agents. Use only when the user mentions Herdr or asks to use it to lay out or run sessions/agents on repos. Requires HERDR_ENV=1. Core method: one space per repo; each unit of work is its own tab running its own agent; you dispatch the task to that agent — creating an empty space/tab is NOT the deliverable; never use panes to separate repos or sessions."
metadata:
  author: pablontiv
---

# Herdr

Herdr organizes terminals into **workspaces (spaces)**, **tabs**, and **panes**, and recognizes coding agents running inside panes. This session drives the current server through the `herdr` binary in `PATH`.

Before any control command, verify you are inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If it fails, say you are not running inside Herdr and stop. Do not control a Herdr session from outside Herdr.

## Working method — MANDATORY end-to-end flow

When the user asks you to run, delegate, or lay out work on a repo, follow **all** of the steps below. Creating the space/tab is setup, not the deliverable: **you are done only when an agent is running in the tab and has been given the task.** A created space or tab with no running, prompted agent is an incomplete task — do not stop there and do not report success.

Vocabulary: **space = `workspace`** (1:1 per repo, labeled by repo). **tab = one unit of work / one session (one agent per tab).** **pane = a split *within* one session's view** — never a way to separate repos or sessions.

1. **Resolve the space by repo:** `herdr workspace list` — is there a space whose `label` is this repo's basename?
2. **No space for this repo → create it:**
   ```bash
   herdr workspace create --cwd <repo-root> --label <repo-basename> --no-focus
   ```
   Read `.result.workspace` (space id) and `.result.root_pane` (the session location). The new space already has a root tab + root pane.
3. **New unit of work (space is new or already exists) → give it its own tab:**
   ```bash
   herdr tab create --workspace <space-id> --cwd <repo-root> --label <session-name> --no-focus
   ```
   Read `.result.tab` and `.result.root_pane`. One agent per tab; do not pile multiple jobs into one tab.
4. **Start the agent in that tab's root pane** (the root pane is an available shell at its prompt):
   ```bash
   herdr agent start <name> --kind claude|pi --pane <root-pane-id>
   ```
   **Authorized CLIs are Claude and Pi only** (owner policy). Never start `--kind devin` (Devin is a model provider, not a CLI) or any other kind. Name matches `[a-z][a-z0-9_-]{0,31}` and is unique among live agents. Pass native agent args after `--`. If a task seems to need another CLI, report the block instead of substituting one.
5. **Dispatch the work** — send the task to that agent and confirm it started:
   ```bash
   herdr agent prompt <name> "<the full task for this session>" --wait --timeout 120000
   herdr agent read <name> --source recent-unwrapped --lines 120
   ```
   `--wait` waits for the first settled `idle`/`done`/`blocked`. Only now is the setup complete; report the tab/space ids and the agent's state.
6. **Never** use `pane split` or `pane move` to place a repo or a new session, and **never** leave a created space/tab empty.

Create panes only when the user explicitly asks for a split view inside one session. Pass `--no-focus` for background setup so you do not steal the user's focus.

## Discover the live CLI

The installed binary is authoritative for syntax. A group alone lists its subcommands; a leaf `--help` lists that command's flags:

```bash
herdr --help
herdr workspace           # tab / pane / agent — lists subcommands
herdr tab create --help   # leaf --help shows flags (e.g. --workspace, --cwd, --label)
```

Do not run bare `herdr` (it launches/attaches the TUI). Most commands return JSON — read ids from `.result`, never predict them.

## IDs and caller context

Opaque stable ids: workspace `w1`, tab `w1:t1`, pane `w1:p1`. Herdr injects the caller's context:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` to target the calling pane. Creation responses expose the next ids: `workspace create` → `.result.workspace` / `.result.tab` / `.result.root_pane`; `tab create` → `.result.tab` / `.result.root_pane`; `pane split` → `.result.pane`. Discover live state with `herdr workspace list`, `herdr tab list --workspace <id>`, `herdr pane list --workspace <id>`, `herdr agent list`.

## Drive the agent after dispatch

```bash
herdr agent get <name>                                    # lifecycle state
herdr agent read <name> --source recent-unwrapped --lines 120
herdr agent send-keys <name> esc                          # ctrl+c, enter, ...
herdr agent wait <name> --until blocked --timeout 120000  # state-specific waits
```

`blocked` means Herdr saw an approval/question UI — inspect with `agent get`/`agent read` and ask the user before answering. A timeout does not prove the prompt was never delivered; do not blindly resend.

Read sources: `visible`, `recent`, `recent-unwrapped` (prefer for logs/transcripts), `detection`. Use `--format ansi` when color is evidence. If a completed agent response will not grow with more `--lines`, it is on the terminal's alternate screen: ask the agent to write its full answer to a temp file and read that file directly.

## Run a plain command in a tab (no agent)

When the unit of work is a process rather than an agent, use the tab's root pane directly:

```bash
herdr pane run <root-pane-id> "just test"
herdr pane wait-output <root-pane-id> --match "test result" --timeout 120000
herdr pane read <root-pane-id> --source recent-unwrapped --lines 120
```

## Panes (only inside one session, when explicitly requested)

```bash
herdr pane split [<pane-id>|--current] --direction right|down [--ratio FLOAT] --cwd "$PWD" --no-focus
```

Build a precise layout by splitting a specific returned pane id with an explicit `--ratio` (default 0.5); avoid repeated same-direction splits that create unusable columns. `pane resize`, `pane swap`, and `pane move --target-pane <id> --ratio <f>` adjust existing geometry. Read the new pane from `.result.pane.pane_id`.

## Safety

- **Authorized CLIs are Claude and Pi only** (owner policy). Never launch or use the Devin CLI — Devin is a model provider only. Every model enabled or used in Claude must also be enabled and used in Pi; do not create Claude-only routes. If provider/config prevents compliance, report the block; do not substitute another CLI.
- `--no-focus` for background work; do not steal the user's focus.
- Target with `--current`, an explicit id, or a unique agent name — never another client's focused pane.
- Parse ids from JSON, not from sidebar order.
- Do not close workspaces, tabs, or panes you did not create unless the user asks.
- Never run `herdr server stop` or kill the main Herdr process from an active session.
- CLI server errors are JSON on stderr with exit 1; syntax errors exit 2.
