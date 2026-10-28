---
name: hitl-escalation
description: Classify a proposed human contact as continue, notify, or decide using the adopted a4s escalation budgets. Use before pinging an owner or opening another approval channel. Does not install HumanLayer.
---

# HITL escalation budgets

**Decision: skill** (#695).

HumanLayer's current product is a daemon, desktop app, and cloud sync for
steering coding agents. a4s already pauses owners through Dagu `human-task`
and adopted escalation budgets. This skill applies those budgets before a new
contact so routine failures and reversible edits do not each become a ping.
The HumanLayer product stays out.

## When to run

Run when the operator asks whether to interrupt a person, when a session is
about to send a status ping, or when a change is framed as adopting
HumanLayer or another approval product. Read this file first. The report is
advice. It does not complete a human-task, publish, merge, or change a pin.

## Evidence check

From the repository root:

```sh
node skills/hitl-escalation/check.mjs
```

Exit 0 means every phrase in `citations.json` is still present, the declared
budgets still match `.workspace/dagu/answers.json` `escalation`, and
`fixtures/stream.json` still contacts fewer events than one ping per event.
Exit 1 means the standing model is stale. Re-read the failing file and update
the model with the citations. Do not classify from the old row. The checker
only reads files. It is not a merge gate.

`node skills/hitl-escalation/classify.mjs` prints the same fixture line.

## Report

Write the report outside the repository unless the operator asked to change
the standing model. Include:

1. The revision read (`git rev-parse HEAD`) and the checker result.
2. The line `Decision: skill`.
3. The contact table from `references/budgets.md` and the disposition for the
   contact under review.
4. The fixture line: baseline contacts, skill contacts, and how many continued.
5. The non-claims: no HumanLayer install, no second budget, no Dagu pin or
   `answers.json` edit.

`continue` sends nothing. `notify` is one deduplicated notice on a wait the
lifecycle already owns. `decide` is one owner decision. An unknown kind decides.
Do not raise a contact above the class its source states, and do not add a
Slack, email, or HumanLayer channel beside that decision.

## Standing model

`references/budgets.md` is the model. The counts are the adopted
`escalation` object, not a HumanLayer quota. `AGENTS.md` has no BLUF section;
do not invent one. There is no Firstmate profile in this repository.

## Boundaries

- No HumanLayer daemon, desktop app, cloud sync, CLI, or Pi plugin.
- No change to the Dagu pin, `answers.json`, station install, or #685.
- No new agent profile and no Captain or Firstmate bot.
- `power-automate-lab` is not in this repository and is not vendored.
- Station dogfood is blocked by the Dagu pin hold. Landing this skill and
  replaying its fixture is the authorized substitute. The fixture is not a
  live human-task.
