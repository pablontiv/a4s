# a4s sandbox boundaries (#689)

**Decision: skill.**

## Why this shape

google/mantis at `f3162c039ecd9c9d5d8bc404dd1373c7ca3152f7` is a skill pipeline
for vulnerability research. `skills/mantis-threat-model` names attackers and
trust boundaries, fails closed on deployment intent, and stamps the model with
the snapshot it came from. `README_AGENTS.md` separates execution environments:
static analysis only, gVisor with network none, a microVM with network none,
and a hardened ephemeral VM. That document treats an agent remembering
`--network none` as not enforcement, and it says unattended vulnerability
research needs a boundary the agent cannot cross. The same repository says not
to use `action/` to gate merges.

a4s does not need that pipeline. It needs the classification. Several current
controls are assignments or cooperative checks, and reviews can over-call them
a sandbox. This table records the class each cited control actually has.

## Actors

| Actor | Reaches |
| --- | --- |
| Operator at the TUI or local Dagu HTTP | Git, the Dagu store, and human-task decisions on the station |
| Agent process running as the station user | Tools the host grants, including paths the assignment text only asked it to avoid |
| Local publisher on the loopback broker | Any `synagent/v2/<to>` payload, including another sender's identity |
| Pull-request CI | The published candidate's tests and PR-body check, not the station process |

## Controls

A class is `prompt`, `advisory`, or `enforced`. `enforced` means a process or
OS boundary the agent cannot disable from inside the same user session. None
of the cited sources meet `enforced`. A silent source fails closed to
`advisory`.

| Control | Class | Source |
| --- | --- | --- |
| Reviewer assignment text while native `readOnly=false` | prompt | `docs/operations/v1-walkthrough.md` — the assignment, not an enforced sandbox, constrained behavior |
| Literal bash resource guard | advisory | `packages/issue-lifecycle/src/resources.ts` — tool-call guard, not a shell interpreter or an OS isolation boundary. `docs/architecture/issue-lifecycle.md` — does not sandbox shell expansion, external scripts, dynamic commands or other tools |
| Git candidate identity and Dagu run records while the TUI can rewrite them | advisory | `packages/issue-lifecycle/skills/issue-execution/SKILL.md` — access to Git and the Dagu store remains advisory, not a sandbox. `docs/operations/deployment.md` — not process or OS isolation |
| `dagu human-task` with no authentication | advisory | `packages/issue-lifecycle/skills/issue-execution/SKILL.md` — `dagu human-task` has no authentication |
| Message-bus log path checks | advisory | `apps/message-bus/README.md` — the checks are not a filesystem sandbox |
| Loopback MQTT sender identity | advisory | `docs/architecture/catalog.md` — local publishers can impersonate senders |
| Mantis static-only, gVisor, microVM, or hardened VM | not deployed | google/mantis sandbox ladder. This skill does not install those environments |

## Deployment intent

`Intent: DEVELOPMENT_STATION`. Source is a private monorepo. Station execution
is an operator-admitted Dagu lane, not an unattended vulnerability-research
loop. Do not copy the mantis hardened-VM rule into a4s CI. A separate Git
worktree is not an OS sandbox, so it does not raise the station to `enforced`.

## Provenance

Re-derive this table when a cited file changes. `citations.json` and
`check.mjs` compare the phrases above with those files. Stamp a fresh report
with the a4s revision that was read. The mantis revision in this file is the
default-branch commit read for the spike, not a vendored tree. The wording is
a4s's; it is not a copy of the mantis skill.

## Out of scope

No `action/` workflow, no ADK harness, no crash reproducer, no Dagu pin, no
`answers.json` pin edit, and no station install.
