---
name: herdr
description: "Control Herdr, the terminal multiplexer for coding agents, over the `herdr` CLI: inspect/control workspaces (spaces), tabs, panes, and agents. Use only when the user mentions Herdr or asks to use it to lay out or drive sessions/agents. Requires HERDR_ENV=1. Core rule: one space per repo — a repo with no space gets a NEW space plus a tab running its session; never use panes to separate repos or sessions."
---

# Herdr

Herdr organizes terminals into **workspaces (spaces)**, **tabs**, and **panes**, and recognizes coding agents running inside panes. This session drives the current server through the `herdr` binary in `PATH`.

Before any control command, verify you are inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If it fails, say you are not running inside Herdr and stop. Do not control a Herdr session from outside Herdr.

## Layout rule — MANDATORY (one space per repo)

Vocabulary: **space = `workspace`** (mapped 1:1 to a repo). **tab = one session** for that repo. **pane = a split *within* one session's view** — never a way to separate repos or sessions.

When you start work on a repo (or must place a new session), resolve the space by repo, never by splitting a pane:

1. `herdr workspace list` — is there a space whose label is this repo? (spaces are labeled by repo basename.)
2. **No space for this repo →** create one:
   ```bash
   herdr workspace create --cwd <repo-root> --label <repo-basename> --no-focus
   ```
   Read `.result.workspace` (space id) and `.result.root_pane` (where the session runs). The new space already has a root tab + root pane.
3. **Space exists and you need another session for that repo →** add a tab in it:
   ```bash
   herdr tab create --workspace <space-id> --cwd <repo-root> --label <session-name> --no-focus
   ```
   Read `.result.tab` and `.result.root_pane`.
4. Start the session in the returned **root pane** (see below). Do **not** `pane split` or `pane move` to place a repo or a new session.

Create panes only when the user explicitly asks for a split view inside a single session. Keep the user's focus where it is: pass `--no-focus` for background setup.

## Discover the live CLI

The installed binary is authoritative for syntax. A group alone lists its subcommands; a leaf `--help` lists that command's flags:

```bash
herdr --help
herdr workspace      # tab / pane / agent — lists subcommands
herdr tab create --help    # leaf --help shows flags (e.g. --workspace, --cwd, --label)
```

Do not run bare `herdr` (it launches/attaches the TUI). Most commands return JSON — read ids from `.result`, never predict them.

## IDs and caller context

Opaque stable ids: workspace `w1`, tab `w1:t1`, pane `w1:p1`. Herdr injects the caller's context:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` to target the calling pane. Creation responses expose the next ids: `workspace create` → `.result.workspace` / `.result.tab` / `.result.root_pane`; `tab create` → `.result.tab` / `.result.root_pane`; `pane split` → `.result.pane`. Discover live state with `herdr workspace list`, `herdr tab list --workspace <id>`, `herdr pane list --workspace <id>`, `herdr agent list`.

## Run a session in a tab's root pane

Ordinary command:

```bash
herdr pane run <root-pane-id> "just test"
herdr pane wait-output <root-pane-id> --match "test result" --timeout 120000
herdr pane read <root-pane-id> --source recent-unwrapped --lines 120
```

Coding agent (requires an available shell pane at its prompt; name matches `[a-z][a-z0-9_-]{0,31}` and is unique among live agents):

```bash
herdr agent start reviewer --kind <kind> --pane <root-pane-id>   # run `herdr agent` for kinds
herdr agent prompt reviewer "Review the diff; report only actionable findings." --wait --timeout 120000
herdr agent read reviewer --source recent-unwrapped --lines 120
herdr agent send-keys reviewer esc        # ctrl+c, enter, ...
```

Pass native agent args after `--`. `--wait` waits for the first settled `idle`/`done`/`blocked`. `blocked` means Herdr saw an approval/question UI — inspect with `agent get`/`agent read` and ask the user before answering. A timeout does not prove the prompt was never delivered; do not blindly resend.

Read sources: `visible`, `recent`, `recent-unwrapped` (prefer for logs/transcripts), `detection`. Use `--format ansi` when color is evidence. If a completed agent response will not grow with more `--lines`, it is on the terminal's alternate screen: ask the agent to write its full answer to a temp file and read that file directly.

## Panes (only inside one session, when explicitly requested)

```bash
herdr pane split [<pane-id>|--current] --direction right|down [--ratio FLOAT] --cwd "$PWD" --no-focus
```

Build a precise layout by splitting a specific returned pane id with an explicit `--ratio` (default 0.5); avoid repeated same-direction splits that create unusable columns. `pane resize`, `pane swap`, and `pane move --target-pane <id> --ratio <f>` adjust existing geometry. Read the new pane from `.result.pane.pane_id`.

## Safety

- `--no-focus` for background work; do not steal the user's focus.
- Target with `--current`, an explicit id, or a unique agent name — never another client's focused pane.
- Parse ids from JSON, not from sidebar order.
- Do not close workspaces, tabs, or panes you did not create unless the user asks.
- Never run `herdr server stop` or kill the main Herdr process from an active session.
- CLI server errors are JSON on stderr with exit 1; syntax errors exit 2.
