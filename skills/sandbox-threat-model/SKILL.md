---
name: sandbox-threat-model
description: Classify a4s execution controls as prompt, advisory, or enforced isolation before calling one a sandbox. Use for sandbox hygiene, resource-guard limits, broker identity, or agent-tool boundaries. Does not install google/mantis or add a CI gate.
---

# Sandbox threat model

**Decision: skill** (#689).

google/mantis contributes a threat-model shape and a sandbox ladder. a4s uses
that shape to classify controls it already documents. The mantis product, its
reference harness, and `action/` stay out. Upstream says that action is not a
merge gate. This skill does not add one.

## When to run

Run when the operator asks for a sandbox threat model or a hygiene review of a
change that touches agent tools, the resource guard, Dagu or Git authority, the
message bus, or a claim that something is isolated. Read this file first. The
report is advice. It does not authorize a merge, a station install, or a pin
change.

## Evidence check

From the repository root:

```sh
node skills/sandbox-threat-model/check.mjs
```

Exit 0 means every phrase in `citations.json` is still present in the named
source, and `references/boundaries.md` still names those paths and records
`Decision: skill`. Exit 1 means the standing model is stale. Re-read the
failing file, update the standing model and `citations.json` together, and do
not classify from the old row. The checker only reads files. It does not
execute generated code, and it is not a merge gate.

## Report

Write the report outside the repository unless the operator asked to change
the standing model. Include:

1. The revision read (`git rev-parse HEAD`) and the checker result.
2. The line `Decision: skill`.
3. The control table from `references/boundaries.md`, plus a class for the
   change under review.
4. Any new boundary the diff introduces. Fail closed to `advisory` when the
   diff does not show a process or OS boundary.
5. The non-claims: no mantis CI workflow, no Dagu pin or `answers.json` edit,
   no reproducer execution.

Do not raise a control above the class its source states. `enforced` requires
a process or OS boundary the agent cannot disable from the same user session.
A missing statement is `advisory`, not `enforced`.

## Standing model

`references/boundaries.md` is the model. Re-read its cited sources when the
checker fails or the diff touches a cited file. The actors, boundaries,
fail-closed intent, and provenance stamp follow `skills/mantis-threat-model`
in google/mantis. The class names follow that repository's sandbox ladder
(`static-only`, networkless gVisor, microVM, hardened VM) only as labels for
environments a4s has not deployed. Do not copy mantis skill text into a
report, and do not run `npx skills add google/mantis`.

## Boundaries

- No GitHub workflow, no `action/`, no ADK harness, and no gVisor, microVM, or
  GCE setup.
- No change to the Dagu pin, `answers.json` pin fields, or station install.
- No crash reproducer, patch, or untrusted payload execution.
- Classification does not create isolation. A `prompt` or `advisory` row stays
  in that class until a separate change adds an enforced boundary and names it.
- Station dogfood is blocked by the Dagu pin hold. Landing this skill in the
  repository is the authorized substitute.
