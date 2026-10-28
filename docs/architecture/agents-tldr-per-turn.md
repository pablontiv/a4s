# AGENTS.md TLDR per turn (#691)

**Decision: descartar.**

The hypothesis was that asking for a TLDR on each turn in `AGENTS.md` improves
readability of agent replies without meaningful cost. The source addition is a
trailing status on turns that report long-running or delegated work, not a
summary of every turn. The text in the post's screenshot is: end any such turn
with a short status: **Goal**, **Done**, **Next**, **Needs you** (or "nothing").

## Evidence

`AGENTS.md` is the operating contract: scope, setup, ownership, versioned
source, and pull-request descriptions. It is 5240 bytes and loads on every
turn. Reply shape for delegated work lives in the role prompts.

All six [`.omp/agents/`](agents.md) definitions require `status`, `summary`,
`result_or_artifacts`, `evidence_or_validation`, and `risks_or_uncertainty`.
All six name the next action on partial work and `question` when the status is
`input_required`.

| Source label | Field already required |
| --- | --- |
| Done | `summary` and `result_or_artifacts` |
| Next | partial work's next action |
| Needs you | `input_required` plus `question`, or no question |
| Goal | the caller's assignment, which the role prompt says to execute |

A second trailing block repeats those fields and can disagree with them. The
source line is 140 bytes. The cost that fails the hypothesis is that duplicate
status on every delegated turn, inside a file that also governs turns the
source leaves alone.

Pull-request bodies already have one fixed shape: `## Summary`,
`## Verification`, and `## Risk`
(`packages/issue-lifecycle/bin/dagu-pr-body.mjs`). A body that adds `## Goal`
is rejected with "Body requires exactly Summary, Verification and Risk
sections, in that order." A second heading set in the operating contract sits
on the path agents use for publication.

## Why there is no skill

A skill loads when someone selects it. The source rule is an ending on any
qualifying turn. The text that already runs for those turns is the role prompt,
and it already requires the fields. A skill would miss the turns it was meant
to close.

## Dogfood

Station admission is blocked by the Dagu pin hold. This CloudAgent change is
the decision record only. It leaves `AGENTS.md`, the role prompts, the Dagu
pin, `answers.json`, and #685 unchanged. `AGENTS.md` files outside this
repository stay as they are.
