---
name: herdr
description: "Control Herdr, the terminal multiplexer for coding agents, over the `herdr` CLI: inspect/control workspaces (spaces), tabs, panes, and agents. Use only when the user mentions Herdr or asks to use it to lay out or run sessions/agents on repos. Requires HERDR_ENV=1. Core method: non-trivial work is subagent-first through a claimed-Bead-owned Worker in a peer tab; one space per repo; 1 Project Orchestrator = 1 repo; 1 Worker = 1 feature; each Worker is a non-recursive leaf that never launches native in-session subagents or delegates again; vendor PRs only against the pablontiv fork; self-check model before quota actions; creating an empty space/tab is NOT the deliverable; never use panes to separate repos or sessions."
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

**Subagent-first invariant: delegate all non-trivial work before execution to a claimed-Bead-owned Worker in its own peer tab.** That Worker is a non-recursive leaf: it executes exactly its bounded Bead and never opens native in-session subagents or delegates again. This applies identically to both authorized kinds, `--kind claude` and `--kind pi`; native Claude features and Pi provider/model routing do not create an exception. Delegation and parallelism from the Project Orchestrator create another peer tab. The native subagent extension remains decommissioned and native in-session subagent delegation remains prohibited inside a Worker peer. A workflow with N independent child-runs therefore fans out to N peer Workers in N tabs, not N native in-session subagents.

**Agent-agnostic native-subagent prohibition:** no agent at any tier may launch native in-session subagents. Native in-session subagents lack a claimed Bead, worktree, lifecycle callbacks, and external-action authority; all delegation therefore uses the claimed-Bead-owned peer Worker path above.

**Roles** (canonical; do not reintroduce *mensajero*, *supervisor*, *minion*, or *coordinador* as role labels): **Human Operator** — the owner. **Mission Control** — the relay session between the Human Operator and Project Orchestrators (e.g. `w4R:p1`). **Project Orchestrator** — the session that drives this skill for one repo; it dispatches and stays thin. **Worker** — the agent executing one work unit in one peer tab. **Verifier** — an independent review agent, itself run as its own peer tab, not a synchronous check inside the Worker's tab. **Mission** — the Bead that owns the durable work unit.

**Ownership iron: 1 Project Orchestrator = 1 repo; 1 Worker = 1 feature.** A Project Orchestrator coordinates only its own repo: it does not implement, review-as-worker, or land work in a foreign repo. Work for another repo goes to that repo's Project Orchestrator (via Mission Control), not to a tab opened here. A Worker owns one feature or single responsibility (one feat branch, one Verifier review, one PoC); more scope means more Workers, i.e. N Beads / N peer tabs. The Project Orchestrator never absorbs Worker work as its own hands-on implementation.

**Vendor iron: PRs only against the `pablontiv` fork, never upstream.** Every repo under `[REDACTED:shared-root]/vendor/` is a fork owned by `pablontiv`. No PR and no merge may target upstream; the PR base is always `pablontiv/<repo>` (its default branch). Before any `gh pr create` or merge, the Project Orchestrator or Worker verifies remotes and base, and passes them explicitly:

```bash
git remote -v
gh repo view pablontiv/<repo>
gh pr create --repo pablontiv/<repo> --base <fork-default-branch> ...
```

If the base or remote resolves to upstream, stop and raise `ATTENTION REQUIRED`; this is not a push authorization (see the YOLO guardrail).

**Model self-check iron: verify your own model/route before any quota or budget action.** An agent cannot assume its current model or provider. Before any model-conditional action (`BUDGET_EXCEEDED`, quota switch, provider failover), determine the actual route from live surfaces: `PI_MODEL` / `PI_PROVIDER` in the environment, Pi session metadata, and `herdr agent get <self-pane-or-name>` (own pane: `$HERDR_PANE_ID`). Gate the action on that result. A fleet or Mission Control quota broadcast is conditional ("if you are on a `<provider>` route..."): if your verified route does not match, do nothing and do not report `BUDGET_EXCEEDED`. If the route cannot be determined, report that as evidence in a blocker; never invent a budget verdict.

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
   herdr tab create --workspace <space-id> --cwd <repo-root-or-worktree-path> --label <bead-id> --no-focus
   ```

   Read `.result.tab` and `.result.root_pane`. Label the tab with its `bead-id`: the H2 reconciler binds a Bead to its Worker pane only by that label (or a cwd containing it). One agent per tab and one claimed Bead per tab; do not pile multiple jobs into one tab. For fan-out, repeat steps 3, 5, and 6 once per independent Bead from step 2 and dispatch all peer tabs without serial waits.
7. **Start the agent in that tab's root pane** (the root pane is an available shell at its prompt). Every start includes the native trust/YOLO flag so the Worker is not blocked on an interactive permission prompt, and routes by task altitude instead of defaulting to a premium model:

   ```bash
   # Bounded mechanical work through Pi's configured economical preset/provider route
   herdr agent start <name> --kind pi --pane <root-pane-id> -- --approve

   # Or use Claude's economical tier explicitly
   herdr agent start <name> --kind claude --pane <root-pane-id> -- --model sonnet --dangerously-skip-permissions

   # High-altitude reasoning may use Claude's premium tier when justified
   herdr agent start <name> --kind claude --pane <root-pane-id> -- --model opus --dangerously-skip-permissions
   ```

   The only authorized Herdr kinds are `claude` and `pi`. Mechanical review, validation, extraction, and other bounded work use `--kind pi` with a verified economical provider/model route configured inside Pi (for example Kimi or MiniMax), or `--kind claude -- --model sonnet`. Orchestration, ambiguous synthesis, and high-impact reasoning use Claude Opus or a strong route inside Pi only when justified. Claude tiers are native arguments after `--`; Pi providers and models are selected by Pi's existing preset/router, never by adding Herdr kinds. Name matches `[a-z][a-z0-9_-]{0,31}` and is unique among live agents.

   **Trust/YOLO flags are mandatory on every `agent start`; verify them live before relying on this doc** (`claude --help`, `pi --help` — CLI flag names can change between versions, so re-verify rather than assume). As of this writing: Claude's native bypass is `--dangerously-skip-permissions`, which skips all tool-approval prompts for that session. Pi's native bypass is `--approve` (short `-a`), which trusts project-local resources for the run so Pi does not block on its project-trust prompt when started headless in a fresh worktree. Both are native CLI args and belong after the `--` separator alongside `--model` or other native flags.

   **Guardrail — YOLO covers non-destructive in-worktree scope only.** These flags remove interactive confirmation for ordinary read/edit/build/test/review work inside the dispatched worktree; they do not authorize `git push`, merge, branch or file deletion, secrets access, or any action that reaches outside the worktree or the local system. Those stay explicit gates exactly as if the flag were absent: the Worker escalates through its `orchestrator_target` (see “Worker escalation”) and stops; it never asks the Human Operator or Mission Control (or anyone else) itself. A flag bypassing tool prompts is never grounds to treat push/merge/delete/secrets/external actions as pre-authorized.
8. **Link the worker to the Bead** — right after the agent starts and before dispatch, stamp who executes the unit so liveness can be resolved from the Bead alone:

   ```bash
   bd update "$bead_id" --metadata '{"worker":"<name>","pane":"<pane-id>","tab":"<tab-id>","correlation_id":"corr.<bead-id>.<epoch>.<redispatch-count>","orchestrator_target":"<po-pane-id-or-name>"}'
   ```

   `correlation_id` identifies this one dispatch: the dispatcher mints it here, before the prompt, and the Worker must echo it in every `TASK_ACK`/`TASK_STARTED` (see “Task acknowledgement” below). A re-dispatch mints a new one and clears the previous `receipt_id`/`start_id` record.

   `orchestrator_target` is where this Worker's blockers and questions go, and the only place they may go (see “Worker escalation” below): the Project Orchestrator's own pane id or unique agent name. The dispatcher stamps it in the same write, before `agent start` and `agent prompt`, and **fails closed without a valid one**: no claim, no tab, no agent, no prompt. Valid means a live agent that is not the Worker, not the Human Operator or an operator/user identity, and not `mc`/a Mission Control-owned pane or agent. It is never left for the Worker to choose.

   `assignee` ≠ `worker`. The assignee (set by `--claim` in step 3) is the accountable human/Project Orchestrator; the worker is the executing agent and lives only in `metadata`. `--metadata` replaces the object; use `--set-metadata worker=<name>` to merge a single key. `bd close` by the Worker stays the authoritative completion signal; `metadata.worker` only lets `herdr agent get <worker>` resolve liveness while the Bead is still open. Fan-out: each peer tab stamps its own worker on its own Bead — never one worker on several Beads.
9. **Dispatch the work** — include the full task, claimed `bead_id`, bounded report path, and the `orchestrator_target` (the Project Orchestrator callback target):

   ```bash
   herdr agent prompt <name> "<task; bead_id=<bead-id>; correlation_id=<correlation-id>; orchestrator_target=<target>; ack + escalation instructions; final report path>"
   ```

   The accepted prompt response is dispatch evidence (transport acceptance), never an acknowledgement: the Worker's `TASK_ACK RECEIVED` Bead write is. Do not add `--wait`, a timeout, or completion polling. The Project Orchestrator returns to its own work or becomes idle until the callback arrives. Only now is setup complete; report the Bead, tab, space, and agent identifiers.
10. **Never** use `pane split` or `pane move` to place a repo or a new session, and **never** leave a created space/tab empty.

## Task acknowledgement — TASK_ACK / TASK_STARTED

Between dispatch and completion the contract has two more Worker-owned events. **Herdr accepting a prompt is transport acceptance, not acknowledgement**: only a Bead write by the Worker proves the task was received, and only a second one proves work began. Both are correlated to the dispatch by the `correlation_id` stamped on the Bead in step 8, and both are recorded by `helper/task_ack.py` — the single writer — so no one parses free text and no one hand-writes these keys.

| Event | Envelope (fixed grammar, `key=value` tokens, closed key set) | Bead metadata persisted |
| --- | --- | --- |
| Receipt | `TASK_ACK RECEIVED receipt_id=<id> correlation_id=<id> bead_id=<id> acknowledged_by=<agent>` | `receipt_id`, `received_at`, `acknowledged_at`, `acknowledged_by` |
| Start | `TASK_STARTED start_id=<id> correlation_id=<id> bead_id=<id> worker=<agent> pane=<pane-id> tab=<tab-id>` | `start_id`, `started_at`, `worker`, `pane`, `tab` |

```bash
python3 skills/herdr/helper/task_ack.py --repo <repo-root> ack   --bead-id <bead-id> --correlation-id <corr> --receipt-id rcpt.<corr> --acknowledged-by <agent>
python3 skills/herdr/helper/task_ack.py --repo <repo-root> start --bead-id <bead-id> --correlation-id <corr> --start-id start.<corr> --worker <agent> --pane "$HERDR_PANE_ID" --tab "$HERDR_TAB_ID"
```

The Worker's first action is `ack`, its second (once it begins real work) is `start`. Each command validates, writes one `bd update` as the assignee, and prints one JSON object. On exit 0 the Worker pushes the printed `envelope` verbatim to the Project Orchestrator with `herdr agent prompt` (no `--wait`); the Bead write, not that push, is the acknowledgement. `a4s-reconcile` bakes these exact commands, with literal ids (`rcpt.<corr>`, `start.<corr>`), into every prompt it dispatches.

Invariants (each is enforced by the helper and covered by an offline test; failures are exit 3):

- **Idempotent:** repeating the same `receipt_id` / `start_id` is `DUPLICATE` — no write, original timestamps and logical state preserved. A *different* id for an already-recorded ack/start is `ACK_CONFLICT` / `START_CONFLICT`, never an overwrite.
- **Correlated or nothing:** an envelope with no `correlation_id` (`MISSING_CORRELATION`), a different one (`CORRELATION_MISMATCH`), or a Bead that was never stamped with one (`BEAD_UNCORRELATED`) writes nothing and infers nothing.
- **No start without ack:** `TASK_STARTED` before a recorded receipt is `START_WITHOUT_ACK`; the ack is never fabricated to make it valid. `worker`/`pane`/`tab` must equal any dispatcher-stamped value (`IDENTITY_MISMATCH`).
- **Fail closed with evidence:** every rejection (also malformed envelopes, unreadable or non-`in_progress` Beads, failed writes) writes an evidence-only ticket under `$XDG_STATE_HOME/a4s/reconcile/attention/` and prints `ATTENTION REQUIRED verdict=blocked artifact_path=<ticket> bead_id=<bead-id>`. The Worker pushes that line to the Project Orchestrator and stops: it does no work, does not close the Bead, and does not guess or hand-write receipt/start metadata.

`a4s-reconcile` only audits this record, read-only: no `receipt_id` within `--ack-after` seconds (default 300) of `dispatched_at` → `ACK_MISSING`; `start_id` without `receipt_id` → `START_WITHOUT_ACK`; ack/start metadata without `correlation_id` → `ACK_UNCORRELATED`; a partial record → `ACK_INCOMPLETE`. All are evidence-only AttentionTickets; the last three also suppress any lifecycle action on that Bead this tick. A missing ack never proves the prompt was lost (do not resend blindly) and never proves the Worker is dead (liveness stays `herdr agent get`). Beads with no protocol keys (dispatched before this contract) are not judged. `WORK_RESULT`/`ATTENTION` completion, and `bd close` as the authoritative completion signal, are unchanged.

## Task result — TASK_RESULT (the harvest gate)

**A Worker finishing (`herdr agent get` → `done`) proves a process stopped, not that the work has a verdict.** The result is a third Worker-owned Bead write, recorded by `helper/task_result.py` (the single writer, same fixed grammar and fail-closed rules as `task_ack.py`) *before* the Worker closes its Bead or sends its final callback:

| Event | Envelope | Bead metadata persisted |
| --- | --- | --- |
| Result | `TASK_RESULT RECORDED result_id=<id> correlation_id=<id> bead_id=<id> result_by=<agent> verdict=<pass\|fail> artifact_path=<abs path>` | `result_id`, `result_at`, `result_by`, `result_verdict`, `result_artifact_path`, `result_correlation_id` |

```bash
python3 skills/herdr/helper/task_result.py --repo <repo-root> --bead-id <bead-id> --correlation-id <corr> --result-id res.<corr> --result-by <agent> --verdict <pass|fail> --artifact-path <report>
```

One `bd update` as the assignee; one JSON object printed. On exit 0 the printed `callback_envelope` (`WORK_RESULT SUBMITTED verdict=… artifact_path=… bead_id=… result_id=… correlation_id=…`) is the Worker's final callback to `orchestrator_target`, pushed verbatim. On exit 3 the Worker pushes the printed `ATTENTION REQUIRED …` envelope to `orchestrator_target` only and **stops**: no `bd close`, no `WORK_RESULT`, no hand-written result metadata. `result_correlation_id` is the correlation the Worker echoed; it lives apart from the dispatcher's `correlation_id` so a record that outlived its dispatch is detectable.

Invariants (helper- and reconciler-enforced, each covered by an offline test):

- **Closed verdict set:** `pass|fail` only (`INVALID_VERDICT`). Any grammar deviation is `MALFORMED`; nothing is parsed from free text.
- **Correlated:** the envelope echoes the Bead's current `correlation_id` (`MISSING_CORRELATION`, `CORRELATION_MISMATCH`, `BEAD_UNCORRELATED`). A re-dispatch mints a new correlation and `--unset-metadata`s the whole previous record (ack, start and result), so an old worker can neither record nor keep a result for the new dispatch.
- **Safe artifact:** `artifact_path` is absolute, normalised, within `[A-Za-z0-9_.:@/+=-]`, and an existing regular file that is not a symlink (`UNSAFE_ARTIFACT`, `ARTIFACT_MISSING`).
- **Identity:** `result_by` equals the dispatcher-stamped `worker` and the agent that acked (`IDENTITY_MISMATCH`, `IDENTITY_UNVERIFIABLE`).
- **After an ack:** a result without a recorded `TASK_ACK` is `RESULT_WITHOUT_ACK`; the ack is never fabricated. A recorded start is neither required nor touched.
- **Idempotent, never overwritten:** the identical record again is `DUPLICATE` (no write, original `result_at` kept); a different `result_id`, verdict, artifact or author for an already-recorded result is `RESULT_CONFLICT`.

**Harvest gate.** For a worker with status `done`, `a4s-reconcile` reads the record back from the Bead and re-applies the same rules (`task_result.verify_record`); it closes **only** when the record is valid, with `reconciler-harvest closed_by=a4s-reconcile worker=<w> herdr_status=done result_id=<id> verdict=<recorded verdict> artifact_path=<recorded path> correlation_id=<corr>`. With no record it writes an evidence-only `WORK_RESULT_MISSING` ticket, with a bad one `WORK_RESULT_INVALID` (the code is in the ticket), and the Bead stays `in_progress`. It never reads or parses a terminal transcript and never infers a verdict from liveness — `done` alone, an `idle` agent or a finished tail is not a result, and a recorded result does not turn a non-`done` worker into a harvest. TASK_ACK/TASK_STARTED anomalies still take precedence (they suppress lifecycle action on that Bead first). Beads dispatched before this contract carry no record, so a `done` worker on one is ticketed `WORK_RESULT_MISSING`, not closed.

## Worker escalation — orchestrator_target only

A Worker never asks the Human Operator or Mission Control anything, by any channel: no interactive/ask-user question, no prompt to an `mc` or human-facing pane, no side message. The Human Operator sits behind Mission Control, and Mission Control behind the Project Orchestrator; a blocker climbs that chain one link at a time, and the Worker owns only the first. Every blocker, question, approval request or decision need is one correlated `ATTENTION REQUIRED`, sent to the exact `metadata.orchestrator_target` stamped on its Bead and to nothing else:

```bash
# write the report first, then:
python3 skills/herdr/helper/escalation.py --repo <repo-root> --bead-id <bead-id> --correlation-id <corr> --type <BLOCKER|QUESTION> --artifact-path <report>
```

The helper reads the target from the Bead (there is no `--target` flag, so the Worker cannot pick one), checks that the Bead is `in_progress` and the `correlation_id` matches, and delivers with `herdr agent prompt <orchestrator_target> "ATTENTION REQUIRED verdict=blocked type=<BLOCKER|QUESTION> artifact_path=<report> bead_id=<id> correlation_id=<corr>"` (no `--wait`). It refuses, sending nothing to anyone, when the target is missing (`TARGET_MISSING`), malformed (`TARGET_INVALID`), the Worker itself (`TARGET_IS_WORKER`), an `mc`/`mission-control`/`human`/`operator`/`user` identity or a pane/agent recorded on a `mission-control` Bead (`TARGET_FORBIDDEN`), or cannot be ruled out because that Bead is unreadable (`TARGET_UNVERIFIABLE`).

If delivery fails or is rejected (target blocked or unavailable), the helper persists the evidence on the Bead (`escalation_delivery`, `escalation_failed_at`, `escalation_target`, `escalation_correlation_id`, `escalation_artifact_path`, `escalation_error`), writes an evidence-only ticket, then sends one `ATTENTION DELIVERY_FAILED verdict=blocked artifact_path=<ticket> bead_id=<id> correlation_id=<corr> target=<target>` to the same target if that is possible (`escalation_notice=delivered|undelivered`). A refusal persists the same evidence (`escalation_delivery=refused`) but has no valid target to notify. Either way the exit is 3 and the Worker **stops**: no work, no `bd close`, no resend, no other target. Never falls back to the Human Operator or Mission Control. `a4s-reconcile` surfaces the evidence read-only as an `ESCALATION_DELIVERY_FAILED` ticket, and a dispatched Bead with a missing or Human/MC `orchestrator_target` as `ESCALATION_TARGET_MISSING` / `ESCALATION_TARGET_FORBIDDEN`. The same rule covers the `ATTENTION REQUIRED` a Worker pushes for a `task_ack.py` rejection: it goes to `orchestrator_target` only.

## Completion handoff — artifact + callback

A peer tab finishes by writing a bounded report containing its verdict, evidence, and `bead_id`. After collecting the authorized terminal evidence, the Worker closes its own Bead, then pushes one completion notification whose payload is only the WorkResult state, verdict, artifact path, and Bead reference:

```bash
python3 skills/herdr/helper/task_result.py --repo <repo-root> --bead-id <bead-id> --correlation-id <corr> --result-id res.<corr> --result-by <agent-name> --verdict pass --artifact-path /tmp/review-report.md   # first; see "Task result"
BEADS_ACTOR="<assignee>" bd close <bead-id> --reason "worker=<agent-name> verdict=pass artifact_path=/tmp/review-report.md"
herdr agent prompt <project-orchestrator-pane|name> "WORK_RESULT SUBMITTED verdict=pass artifact_path=/tmp/review-report.md bead_id=<bead-id> result_id=res.<corr> correlation_id=<corr>"   # the helper's callback_envelope, verbatim
```

Target either the Project Orchestrator's explicit pane id or unique agent name. Do not add `--wait` or a timeout: the Worker pushes once as its final action and exits its flow. The Project Orchestrator stays idle until this callback arrives, then reads the artifact directly. It never re-ingests the Worker's transcript or a full result inside the callback.

`bd`'s assignee guard refuses a close (or any write) by an actor other than the Bead's assignee, and `--actor <agent-name>` overrides `BEADS_ACTOR`, so a Worker that is not the claimant closes as the assignee via `BEADS_ACTOR="<assignee>"` (read it from `bd show`) and never uses `--force`. Audit tradeoff: `bd` records the assignee as the closer; the real closer is recorded in the `--reason` (`worker=<agent-name>`) and, for the reconciler, in its local `audit.jsonl`. This is an Operator/Jev decision, revisit if `bd` gains a delegated-actor field.

A blocked or attention path is evidence-only: write the blocker report and escalate it with `helper/escalation.py` (a correlated `ATTENTION REQUIRED` to `orchestrator_target` only, see “Worker escalation”) without closing the Bead, WorkResult, Mission, or any other lifecycle. If prompt delivery is rejected because the target is blocked or unavailable, the helper preserves that failure on the Bead and emits `ATTENTION DELIVERY_FAILED` to the same target; do not resend blindly and never reroute to Human/MC. Bead closure records completion of the delegated work unit only; it never auto-closes the authoritative A4S lifecycle.

The Project Orchestrator remains thin: dispatch units, track state by Bead, verdict, and artifact pointer, integrate only bounded evidence, and compact its own context aggressively. Never accumulate child transcripts or duplicate their working context. Reconciliation across a fanned-out DAG is not this session's job and not a prompt: a deterministic reconciler (`skills/herdr/scripts/a4s-reconcile`, run by launchd/cron, no LLM) reads durable state from Beads and liveness from Herdr via `metadata.worker` — `bd ready` → dispatch, `in_progress` → `herdr agent get <worker>` (working: leave; done: close only on a valid `TASK_RESULT` record, else `WORK_RESULT_MISSING`/`WORK_RESULT_INVALID` evidence and the Bead stays open; not found: re-dispatch; blocked: evidence-only AttentionTicket; a Bead dispatched with a `correlation_id` also gets the read-only TASK_ACK/TASK_STARTED audit above), `in_progress` with no `metadata.worker` → leave while the lease is live, a live agent is tied to it, or activity is recent; stale lease + no live agent + opt-in label + assignee == actor → re-dispatch in a new tab; anything else → AttentionTicket, closed Bead with a live tab → close the tab. Before any of it the reconciler runs the **Mission Control safety gate**: the canonical MC is the one `in_progress` Bead labelled `mission-control` whose lease is live and whose recorded session identity (`terminal_id`/`session`, `pane`, `tab`, `workspace`) matches the live herdr pane — a label alone never counts. If MC ownership is absent, duplicated, stale or ambiguous it emits an AttentionTicket and performs no mutation; it never creates, moves, relabels, closes or prompts an mc pane, and never harvest-closes, re-dispatches, re-stamps, claims or reaps the MC ownership Bead or any Bead wired to an MC-owned target (allowlist: `tab create|close`, `agent start|prompt`, never aimed at an mc/MC-owned target). The Worker's `bd close` and WORK_RESULT/ATTENTION callback remain the authoritative completion signals; liveness proves a process exists, not semantic progress, and never grows into a scheduler or control plane inside the session. `herdr agent prompt` to a running agent is an optional nudge, never the mechanism that keeps the loop alive.

### Heartbeat H2 — a wake only counts with evidence

A launchd wake that exits 0 proves only that Herdr accepted the prompt (H1): in the recorded w4J session 73 of 73 wakes got an assistant turn, yet 57 issued no `bd` write or `herdr` dispatch command. `helper/heartbeat_h2.py` runs once per tick (launchd stays the transport), diffs Beads/Herdr against the previous tick, and classifies it from observable state instead of the model's willingness to speak:

| Verdict | Evidence |
| --- | --- |
| `PASS_HARVEST` | a `WORK_RESULT`/`ATTENTION` callback reached the PO session record and an assistant turn followed |
| `PASS_PROGRESS` | a non-epic Bead was claimed or closed since the previous tick |
| `PASS_STALE` | concrete `STALE_WORK` / `ATTENTION type=QUESTION` with `pane_id` + `bead_id` was emitted — the helper's own observation (stall made visible), not proof the PO responded; a stale Bead repeats it every tick |
| `NOOP`, `WORKING`, `BASELINE` | nothing to do, live workers in flight, or first tick — reported, never counted as PASS |
| `FAIL` | none of the above, an undelivered wake, or unobservable state (Beads/Herdr unreadable, or a malformed `state.json` — inspect or delete it) — exit 2, visible notification |

```bash
python skills/herdr/helper/heartbeat_h2.py --po-pane <po-pane> --repo <repo-root>          # read-only, prints one verdict
python skills/herdr/helper/heartbeat_h2.py --po-pane <po-pane> --repo <repo-root> --live   # + one wake prompt, one notification, state + ticks.jsonl
```

`--live` prompts the PO once per tick with the H1 text plus `H2 verdict=… ; STALE_WORK pane_id=… bead_id=…` pointers and notifies through `herdr notification show`, so a stalled PO cannot hide its own stall. The measurement crosses ticks (tick N+1 judges the wake sent at tick N): there is no wait, timeout, retry, or poll loop, and it never claims, closes, or mutates a Bead. `helper/com.pablontiv.a4s.orchestrator-heartbeat-h2.plist.example` is the reversible LaunchAgent template; retire it when the A4S tick lands. Run the tests with `python -m unittest discover -s skills/herdr/tests -t skills/herdr -p "test_*.py"`.

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

Normal completion is callback-driven, and stalled or ghost workers are the reconciler's job. Do not poll with repeated `agent get` or `agent read`, and do not call `agent wait` or add completion timeouts; a single `agent get <worker>` (resolved from `metadata.worker`) is a one-shot inspection, not a loop. `blocked` means Herdr saw an approval/question UI — inspect once with `agent get`/`agent read`, preserve the evidence against the Bead, and do not hand-answer it: a blocked Worker is a dispatch defect to fix, and anything that needs the Human Operator goes upward through Mission Control, never from the Worker. A missing callback does not prove the prompt was never delivered; do not blindly resend.

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
- 1 Project Orchestrator = 1 repo; 1 Worker = 1 feature. Never work or land changes in a foreign repo from this session.
- Vendor repos are `pablontiv` forks: PRs and merges target `pablontiv/<repo>` only, never upstream; verify remotes and base before `gh pr create`/merge.
- Self-check model/route (`PI_MODEL`/`PI_PROVIDER`, Pi metadata, `herdr agent get`) before any quota/budget action; never emit `BUDGET_EXCEEDED` for a route you are not on.
- Non-trivial work is subagent-first: before execution, dispatch it through a claimed Bead to one Worker in its own peer tab; the Project Orchestrator never absorbs it as hands-on work.
- Each Worker is a non-recursive leaf that executes exactly its bounded Bead; neither Claude nor Pi Workers may launch native in-session subagents or delegate again. One agent and one distinct Bead per tab.
- Never create, move, relabel or close an mc pane/tab/workspace from a Worker or the reconciler; MC creation/promotion needs an incumbent-MC handshake, and any relocation carries a handover artifact and preserves the incumbent MC.
- Worker escalation has one route: `metadata.orchestrator_target`, stamped with `correlation_id` before start/prompt (dispatch fails closed without a valid PO target). A Worker never asks the Human Operator or Mission Control; every blocker/question is a correlated `ATTENTION REQUIRED` through `helper/escalation.py`; a failed delivery leaves evidence on the Bead, emits `ATTENTION DELIVERY_FAILED` to the same target if possible, and stops, with no fallback to Human/MC.
- Herdr accepting a prompt is not an acknowledgement: stamp `metadata.correlation_id` before dispatch, and the Worker records `TASK_ACK RECEIVED` then `TASK_STARTED` through `helper/task_ack.py` only; a start never precedes an ack, ids are idempotent, and a missing or mismatched correlation fails closed with an `ATTENTION REQUIRED` ticket, never inferred state.
- A `done` worker is not a result: the Worker records `TASK_RESULT` through `helper/task_result.py` before its close and final callback, and `a4s-reconcile` harvest-closes only a valid, correlated record (never a terminal transcript or liveness); otherwise `WORK_RESULT_MISSING`/`WORK_RESULT_INVALID` evidence and the Bead stays open.
- Stamp `metadata.worker`/`pane`/`tab` on the Bead before dispatch; `assignee` is the accountable human/orchestrator, never the worker. Fan-out: one worker per Bead, stamped by its own tab.
- Fan-out follows `bd ready`'s dependency graph, never list order; only a real dependency edge serializes two Beads, and only mutating Beads sharing a repo need their own `herdr worktree`.
- The only authorized kinds/CLIs are `claude` and `pi`; all other providers/models route inside Pi or through Claude's native model tier, never through another Herdr kind or native in-session subagent topology.
- Preserve altitude routing: use Pi's economical internal route or Claude Sonnet for bounded work; justify Claude Opus or a strong Pi route for high-altitude reasoning.
- Every `agent start` passes the native trust/YOLO flag (`--dangerously-skip-permissions` for claude, `--approve`/`-a` for pi) so the Worker is not blocked on an interactive prompt; this only covers non-destructive in-worktree scope. Push, merge, delete, secrets access, and external actions remain explicit gates regardless of the flag — the Worker still raises a correlated `ATTENTION REQUIRED` to its `orchestrator_target` before those, and never asks anyone else. A Worker sitting `blocked` on a permission/trust prompt is a dispatch defect — the start flag was omitted or wrong; fix the `agent start` invocation, do not hand-answer the prompt as a workaround.
- `--no-focus` for background work; do not steal the user's focus.
- Target with `--current`, an explicit id, or a unique agent name — never another client's focused pane.
- Parse ids from JSON, not from sidebar order.
- Do not close workspaces, tabs, or panes you did not create unless the user asks.
- Never run `herdr server stop` or kill the main Herdr process from an active session.
- CLI server errors are JSON on stderr with exit 1; syntax errors exit 2.
