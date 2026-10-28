# HITL escalation budgets (#695)

**Decision: skill.**

## Why this shape

HumanLayer's public repository is a control plane: a host daemon runs coding-agent
sessions, and a desktop app plus a web app sync tasks, sessions, plans, and
reviews. Installing that stack would add a second session owner beside OMP and
Dagu `human-task`. The useful public pattern is older and smaller. The
12-factor agents note escalates after three consecutive tool errors and breaks
the loop for a high-stakes action, while ordinary tool work continues.

a4s already has that pause, as adopted lifecycle policy, and does not have a
session-level procedure that applies it before a new human contact. This skill
is that procedure. It does not retune the budgets and it does not open a new
channel.

`AGENTS.md` does not name BLUF. This checkout also has no Firstmate profile.
The comparison baseline is one contact per event, which is what an unbudgeted
approval ping does. Escalation norms used here are the lifecycle budgets,
deduplicated CI causes, `blockerReporting` `ask`, and the explicit-authority
rule in `AGENTS.md`.

`power-automate-lab` is not in this repository. Its multi-stage approval flow
stays outside a4s. Feature and PoC waits already park on named human-task
steps.

## Adopted budgets

Read from `.workspace/dagu/answers.json` `escalation`, and rendered as
`ESCALATION_PUSHBACKS=3`, `ESCALATION_FINDINGS=2`, `ESCALATION_SECONDS=3600`,
`ESCALATION_CI_BLOCKED=2`, and `ESCALATION_POC_INCONCLUSIVE=2` in
`packages/issue-lifecycle/skills/issue-execution/SKILL.md`.
`docs/operations/deployment.md` fixes those values at admission. A run parameter
cannot override them. This skill reads the same object and refuses to invent a
sixth counter.

| Proposed contact | Disposition | Source |
| --- | --- | --- |
| Reversible edit, in-scope clarification, or `blocker-report` while policy is `ask` | continue | `packages/issue-lifecycle/skills/issue-execution/SKILL.md` — opts out of automatic publication. `AGENTS.md` — actions require explicit assignment authority; a local gate grants none. |
| `code-fail` inside the elapsed window | continue | `packages/issue-lifecycle/skills/issue-execution/SKILL.md` — not an owner escalation |
| First finding or push-back inside the count, first access/scope INCONCLUSIVE | continue | same skill — repeated fingerprint or the second INCONCLUSIVE is the park |
| First identical CI BLOCKED | notify | same skill — deduplicated cause. Duplicate delivery of a tick does not increment the streak |
| Repeated finding, push-back count, second CI BLOCKED, second access/scope INCONCLUSIVE, or elapsed window | decide | same skill — `ESCALATION_*` defaults above |
| Publish, merge, station install, pin change, or a target outside the authorized route | decide | `AGENTS.md` explicit authority. same skill — `poc_scope_decision` once |
| Unknown kind | decide | Fail closed. A missing row is a decision, not a silent continue |

`continue` sends nothing. `notify` is one deduplicated notice and does not open
a second wait. `decide` is one owner decision on the human-task the lifecycle
already declared, or one explicit operator go when no run is waiting. Do not
also page Slack, email, or a HumanLayer contact channel.

## Fixture

`fixtures/stream.json` replays a mixed run. The checker compares each row with
`classify.mjs` and requires fewer skill contacts than the per-event baseline.
The four `decide` rows that are not the elapsed window are contacts the
adopted policy already requires. The `continue` rows are the interruptions the
hypothesis treats as unnecessary.

## Provenance

Re-read the cited files when the checker fails. HumanLayer was read from its
public README and from the 12-factor agents article (factor 7, contact humans
with tool calls; factor 8, three consecutive errors). No HumanLayer commit is
vendored. The wording here is a4s's.

## Out of scope

No HumanLayer daemon, desktop app, cloud sync, or Pi plugin. No edit to the
Dagu pin, `.workspace/dagu/answers.json`, station install, or #685. No new
agent profile. Classification does not complete a human-task.
