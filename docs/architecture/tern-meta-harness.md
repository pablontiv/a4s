# Tern meta-harness (#690)

**Decision: descartar.**

The hypothesis was that Tern offers agent multiplexing OMP does not cover today.
The public sources describe a closed-beta terminal workspace that launches and
draws `omp`. Fan-out of agents already lives in native OMP `task`/`wait`,
lifecycle role subprocesses, and `@a4s/agent-messaging`.

## Evidence

The source post (9 Oct 2026) is the line "new awesome meta-harness just dropped"
plus the product URL. It names no protocol.

[stencil.so/tern](https://stencil.so/tern) is a Rust terminal workspace. Panes
survive closing the window and a reboot, including an omp conversation still in
progress. `tern remote serve` publishes that session over QUIC. Desktop, iPhone,
and browser clients attach to the same session and follow one another. The
built-in agent block is "omp, drawn natively." `tern split`, `run`, and
`capture` drive the daemon. [awesome-tern](https://github.com/theblazehen/awesome-tern)
records a waitlist closed beta and that Tern's source is not public.

The plugin SDK treats an agent as a pane:

- [Sessions and blocks](https://docs.stencil.so/tern/scripts/sessions.html):
  `block agent` opens a pane. `agent-command` sets the shell command future
  agent blocks run. The default command is `omp`.
- [Window API](https://docs.stencil.so/tern/reference/api-window.html):
  `cx.agents:start` opens that pane and submits one prompt. `wait` returns the
  last assistant text. `transcript` reads the omp surface-protocol chat.
  Agents that are not omp have no structured transcript. `interrupt` sends
  Ctrl-C. `stop` closes the pane.
- [Work kinds](https://docs.stencil.so/tern/elements/work.html): the `agent`
  row is a drawing. "omp sends one per subagent."

Community plugins listed on awesome-tern follow the same split. `omp-side`
adds `/side` to fork a conversation into a child session and open it in Tern,
cmux, tmux, WezTerm, Kitty, or Ghostty. `tern-periscope` and omp Tiles list
omp sessions and subagents that already exist. `tern-agents` starts other
CLIs in the same kind of pane.

a4s already multiplexes the agents those panes would display:

| Surface | What it multiplexes |
| --- | --- |
| [`.omp/agents/`](agents.md) | Native `task` plus `wait`. Six roles, parent and child sessions, `agentSource=project`. |
| [`packages/issue-lifecycle`](../../packages/issue-lifecycle/src/role-runtime.ts) | `runSubprocess` for triage and task roles, including `subagent:<id>` retry chains. Discovery runs one subagent per lens, at most eight at once. |
| [`packages/agent-messaging`](../../packages/agent-messaging/README.md) | Distinct OMP sessions as `project/session` addresses. Offer/claim among idle sessions over loopback MQTT. |
| [`packages/kiro-omp-provider`](../../packages/kiro-omp-provider/README.md) | A model provider (`registerProvider` / `streamSimple`). It does not open sessions. |

## Why there is no skill

A skill that called `block agent` or `cx.agents:start` would require the Tern
daemon, its Luau runtime, and a waitlisted binary. That is product adoption.
The Radar action for this spike is a comparison. In-process children stay on
`task`/`wait`. Cross-session work stays on agent-messaging. Neither path needs
a new pane host.

## Dogfood

Station admission is blocked by the Dagu pin hold. Tern's own install is a
signed-in closed beta, and this spike does not change station install, the
Dagu pin, `answers.json`, or #685. This CloudAgent change is the docs decision
only. No Tern binary was installed and no OMP session was started for it.
