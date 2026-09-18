---
name: herdr
description: "Control Herdr, the terminal multiplexer for coding agents, over the `herdr` CLI: inspect/control workspaces (spaces), tabs, panes, and agents. Use only when the user mentions Herdr or asks to use it to lay out or run sessions/agents on repos. Requires HERDR_ENV=1. Core method: a claimed Bead precedes every work unit; one space per repo; each unit is one peer tab running one agent; in-session subagents are prohibited; creating an empty space/tab is NOT the deliverable; never use panes to separate repos or sessions."
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

Vocabulary: **space = `workspace`** (1:1 per repo, labeled by repo). **tab = one unit of work / one peer session (one agent per tab).** **pane = a split *within* one session's view** — never a way to separate repos or sessions.

**Invariant: “one agent per tab” means that the agent in a tab never opens in-session subagents.** This applies identically to both authorized kinds, `--kind claude` and `--kind pi`; native Claude features and Pi provider/model routing do not create an exception. Delegation and parallelism create another peer tab. The subagent extension is decommissioned and subagent delegation is prohibited. A workflow with N independent child-runs therefore fans out to N peer tabs, not N subagents.

**Roles** (canonical; do not reintroduce *mensajero*, *supervisor*, *minion*, or *coordinador* as role labels): **Human Operator** — the owner. **Mission Control** — the relay session between the Human Operator and Project Orchestrators (e.g. `w4R:p1`). **Project Orchestrator** — the session that drives this skill for one repo; it dispatches and stays thin. **Worker** — the agent executing one work unit in one peer tab. **Verifier** — an independent review agent, itself run as its own peer tab, not a synchronous check inside the Worker's tab. **Mission** — the Bead that owns the durable work unit.

1. **Resolve the space by repo:** `herdr workspace list` — is there a space whose `label` is this repo's basename?
2. **Discover ready work before claiming anything:** `bd ready` (and `bd list` for the full graph) identify which Beads are independent — no unresolved dependency edges — versus which are blocked behind another Bead. Fan-out follows this dependency graph, never list order: every Bead `bd ready` returns is dispatched to its own peer tab in the same pass; only an explicit dependency edge serializes two Beads.
3. **Create or claim the Bead before any workspace/tab creation or agent start.** No Bead means no dispatch, without exception:

   ```bash
   # New work unit
   bead_id="$(bd create "<unit title>" --type task --silent)"
   bd update "$bead_id" --claim

   # Or claim an existing authorized unit
   bead_id=<existing-bead-id>
   bd update "$bead_id" --claim
   ```

   `bd show "$bead_id"` must identify the exact claimed unit. If creation or claim fails, stop before any Herdr mutation. For fan-out, create and claim one distinct child Bead per peer tab, linked to its parent with `bd create ... --parent <parent-bead-id>`; never share one Bead across tabs.
4. **No space for this repo → create it:**

   ```bash
   herdr workspace create --cwd <repo-root> --label <repo-basename> --no-focus
   ```

   Read `.result.workspace` (space id) and `.result.root_pane` (the session location). The new space already has a root tab + root pane.
5. **Each Bead that mutates the repo gets its own worktree.** When fanning out more than one Bead against the same repo concurrently, do not point their tabs at the same checkout — collisions on working-tree state are not a dependency the graph tracks:

   ```bash
   herdr worktree create --workspace <space-id> --branch <bead-branch> --label <bead-id> --no-focus
   ```

   Read `.result.tab` / `.result.root_pane` from the worktree, same as a plain tab, and use its path as `--cwd` in the next step. A single read-only or non-mutating Bead may share the root checkout instead.
6. **New unit of work (space is new or already exists) → give it its own tab:**

   ```bash
   herdr tab create --workspace <space-id> --cwd <repo-root-or-worktree-path> --label <session-name> --no-focus
   ```

   Read `.result.tab` and `.result.root_pane`. One agent per tab and one claimed Bead per tab; do not pile multiple jobs into one tab. For fan-out, repeat steps 3, 5, and 6 once per independent Bead from step 2 and dispatch all peer tabs without serial waits.
7. **Start the agent in that tab's root pane** (the root pane is an available shell at its prompt). Route by task altitude instead of defaulting to a premium model:

   ```bash
   # Bounded mechanical work through Pi's configured economical preset/provider route
   herdr agent start <name> --kind pi --pane <root-pane-id>

   # Or use Claude's economical tier explicitly
   herdr agent start <name> --kind claude --pane <root-pane-id> -- --model sonnet

   # High-altitude reasoning may use Claude's premium tier when justified
   herdr agent start <name> --kind claude --pane <root-pane-id> -- --model opus
   ```

   The only authorized Herdr kinds are `claude` and `pi`. Mechanical review, validation, extraction, and other bounded work use `--kind pi` with a verified economical provider/model route configured inside Pi (for example Kimi or MiniMax), or `--kind claude -- --model sonnet`. Orchestration, ambiguous synthesis, and high-impact reasoning use Claude Opus or a strong route inside Pi only when justified. Claude tiers are native arguments after `--`; Pi providers and models are selected by Pi's existing preset/router, never by adding Herdr kinds. Name matches `[a-z][a-z0-9_-]{0,31}` and is unique among live agents.
8. **Dispatch the work** — include the full task, claimed `bead_id`, bounded report path, and Project Orchestrator callback target:

   ```bash
   herdr agent prompt <name> "<task; bead_id=<bead-id>; final report path; callback target>"
   ```

   The accepted prompt response is dispatch evidence. Do not add `--wait`, a timeout, or completion polling. The Project Orchestrator returns to its own work or becomes idle until the callback arrives. Only now is setup complete; report the Bead, tab, space, and agent identifiers.
9. **Never** use `pane split` or `pane move` to place a repo or a new session, and **never** leave a created space/tab empty.

## Completion handoff — artifact + callback

A peer tab finishes by writing a bounded report containing its verdict, evidence, and `bead_id`. After collecting the authorized terminal evidence, the Worker closes its own Bead, then pushes one completion notification whose payload is only the WorkResult state, verdict, artifact path, and Bead reference:

```bash
bd close <bead-id> --actor <agent-name> --reason "verdict=pass artifact_path=/tmp/review-report.md"
herdr agent prompt <project-orchestrator-pane|name> "WORK_RESULT SUBMITTED verdict=pass artifact_path=/tmp/review-report.md bead_id=<bead-id>"
```

Target either the Project Orchestrator's explicit pane id or unique agent name. Do not add `--wait` or a timeout: the Worker pushes once as its final action and exits its flow. The Project Orchestrator stays idle until this callback arrives, then reads the artifact directly. It never re-ingests the Worker's transcript or a full result inside the callback.

A blocked or attention path is evidence-only: write the blocker report and push `ATTENTION REQUIRED verdict=blocked artifact_path=<path> bead_id=<bead-id>` without closing the Bead, WorkResult, Mission, or any other lifecycle. If prompt delivery is rejected because the target is blocked or unavailable, preserve that failure in the report and do not resend blindly. Bead closure records completion of the delegated work unit only; it never auto-closes the authoritative A4S lifecycle.

The Project Orchestrator remains thin: dispatch units, track state by Bead, verdict, and artifact pointer, integrate only bounded evidence, and compact its own context aggressively. Never accumulate child transcripts or duplicate their working context. Reconciliation across a fanned-out DAG stays on the same two signals — each Worker's WORK_RESULT/ATTENTION callback for completion, and Herdr's per-agent liveness (`herdr agent get`/`agent list`, and the separate heartbeat effort tracked under the Herdr heartbeat/reconciliation epic) only to flag a tab that has gone silent. Heartbeat proves recent liveness, not semantic progress; it never triggers a retry, a poll loop, or a substitute completion signal, and it never grows into a scheduler or control plane of its own.

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

Workspace, tab, and pane ids are opaque stable handles; always use the placeholders `<workspace-id>`, `<tab-id>`, and `<pane-id>` in reusable examples. Herdr injects the caller's concrete context:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` to target the calling pane. Creation responses expose the next ids: `workspace create` → `.result.workspace` / `.result.tab` / `.result.root_pane`; `tab create` → `.result.tab` / `.result.root_pane`; `pane split` → `.result.pane`. Discover live state with `herdr workspace list`, `herdr tab list --workspace <id>`, `herdr pane list --workspace <id>`, `herdr agent list`.

## Drive the agent after dispatch

```bash
herdr agent get <name>                                    # one-shot lifecycle inspection
herdr agent read <name> --source recent-unwrapped --lines 120
herdr agent send-keys <name> esc                          # ctrl+c, enter, ...
```

Normal completion is callback-driven. Do not poll with repeated `agent get` or `agent read`, and do not call `agent wait` or add completion timeouts. `blocked` means Herdr saw an approval/question UI — inspect once with `agent get`/`agent read`, preserve the evidence against the Bead, and ask the user before answering. A missing callback does not prove the prompt was never delivered; do not blindly resend.

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

- No claimed Bead means no workspace/tab creation, agent start, or dispatch; there are no exceptions.
- One agent and one distinct Bead per tab; neither Claude nor Pi may launch or delegate to in-session subagents.
- Fan-out follows `bd ready`'s dependency graph, never list order; only a real dependency edge serializes two Beads, and only mutating Beads sharing a repo need their own `herdr worktree`.
- The only authorized kinds/CLIs are `claude` and `pi`; all other providers/models route inside Pi or through Claude's native model tier, never through another Herdr kind or subagent topology.
- Preserve altitude routing: use Pi's economical internal route or Claude Sonnet for bounded work; justify Claude Opus or a strong Pi route for high-altitude reasoning.
- `--no-focus` for background work; do not steal the user's focus.
- Target with `--current`, an explicit id, or a unique agent name — never another client's focused pane.
- Parse ids from JSON, not from sidebar order.
- Do not close workspaces, tabs, or panes you did not create unless the user asks.
- Never run `herdr server stop` or kill the main Herdr process from an active session.
- CLI server errors are JSON on stderr with exit 1; syntax errors exit 2.
