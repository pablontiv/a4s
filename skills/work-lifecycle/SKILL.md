---
name: work-lifecycle
description: "Trigger: driving a unit of work through the A4S lifecycle — intake, choose/define/prepare/do/accept/deliver/close work, elegir trabajo, qué hacemos, admitir trabajo, avanzar una tarea, entregar, cerrar. One skill for the whole workflow; reads every rule from workspace config and adds none of its own."
metadata:
  author: pablontiv
  updated: "2026-10-05"
---

# Work lifecycle

One skill for the whole A4S work pipeline (ADR 0069 proposed). It carries the
*technique* of moving a unit of work from a need to a closed result. It carries
**no rule**: every gate below verifies against a key of `.workspace/config.yaml`,
which is the only authority.

The point of this skill is to stop spreading the workflow across config prose
and many sibling skills (which multiplied ceremony). One lean skill, seven
stages, gates that check config.

## Authority

This skill is technique only. The applicable integrated `.workspace/config.yaml`
is the only authority for the rules these gates enforce; this skill adds no rule
or gate of its own and grants no authorization. Every `<condition ref="...">`
names the config key that governs it (`authority.mechanism`): the gate verifies,
it does not define. If `.workspace/config.yaml` is absent, fail closed and stop.

## How it works

- **No declared sequence (model C2).** Order is not written down as a sequence.
  Each stage has an entry gate that checks the evidence the previous stage's exit
  gate produced, so order *emerges* from the gates, not from narration.
- **One hard barrier** is the only precedence config asserts: `integration →
  cleanup` — never clean up before integration is verified
  (`deliver_work.close`, `improve_work.cleanup`). Every other ordering emerges
  from the gates (C2), not from a declared sequence.
- **Resolve, don't perform ceremony.** A gate is a short check against config,
  not a ritual. If a condition is met, pass and continue; if not, say which and
  stop. Do not invent checks config does not require.
- **Emit a `<gate_check>`** at each stage boundary (format at the end).

## Stages

<stage id="1" name="intake">
  <gate_entry>
    <condition ref="choose_work">operator_need_presented</condition>
    <condition ref="do_work.modes">entry_mode_authorized</condition>
  </gate_entry>
  <activity>Investigate repo/records/history read-only (`do_work.history`,
    `do_work.safety`); present results, acceptance criteria, fit with
    `purpose.outcome`, dependencies/value/risks (`choose_work`). Present Beads
    with Description/ID/Result/Scope, no inference or backfill
    (`choose_work.backlog_decisions`). Operator chooses (`roles.operator`).</activity>
  <gate_exit>
    <condition ref="choose_work">result_chosen_by_operator</condition>
    <condition ref="choose_work">acceptance_criteria_presented</condition>
  </gate_exit>
</stage>

<stage id="2" name="refinement">
  <gate_entry><condition ref="choose_work">result_chosen</condition></gate_entry>
  <activity>Classify the kind and bound one unit with one result
    (`define_work.classification`, `define_work.kinds`). One label
    `kind-*` per task (`define_work.beads`).</activity>
  <gate_exit><condition ref="define_work.units">unit_with_one_kind</condition></gate_exit>
</stage>

<stage id="3" name="planning">
  <gate_entry><condition ref="define_work.units">unit_defined</condition></gate_entry>
  <activity>Agree result, acceptance criteria, scope/exclusions, applicable
    invariants, and evidence required (`prepare_work.shared_readiness`,
    `prepare_work.shared_readiness`). Design shared interfaces before dependent work
    (`prepare_work.design`).</activity>
  <gate_exit><condition ref="prepare_work.shared_readiness">readiness_agreed</condition></gate_exit>
</stage>

<stage id="4" name="implementation">
  <gate_entry>
    <condition ref="prepare_work.shared_readiness">readiness_agreed</condition>
    <condition ref="do_work.starting_point">main_clean_synced_and_dedicated_worktree</condition>
  </gate_entry>
  <activity>Implement the agreed result. Inspection never mutates; ambiguity
    stops (`do_work.safety`). External effects only after payload authorization
    (`do_work.external_effects`, `reserved_authority`). Credentials via SOPS/Pi
    native (`do_work.credentials`).</activity>
  <gate_exit><condition ref="accept_work.evidence">candidate_with_evidence</condition></gate_exit>
</stage>

<stage id="5" name="verification">
  <gate_entry><condition ref="accept_work.evidence">candidate_exists</condition></gate_entry>
  <activity>Map each criterion to its evidence; E2E when executable behavior
    changed (`accept_work.end_to_end`); kind-appropriate checks
    (`accept_work.kind_checks`); independent review when risk warrants
    (`accept_work.review`).</activity>
  <gate_exit><condition ref="accept_work.evidence">accepted_or_returned</condition></gate_exit>
</stage>

<stage id="6" name="delivery">
  <gate_entry>
    <condition ref="accept_work.evidence">accepted</condition>
    <condition ref="deliver_work.merge">no_open_high_findings</condition>
  </gate_entry>
  <activity>PR with a `Bead:` trailer and applicable checks; merge under
    `deliver_work.merge` controls; never push to main
    (`deliver_work.mechanism`). Bot/external PRs pass the same controls
    (`deliver_work.external_prs`).</activity>
  <gate_exit><condition ref="deliver_work.merge">integrated_into_main</condition></gate_exit>
</stage>

<stage id="7" name="closure">
  <gate_entry><condition ref="deliver_work.close">integrated_and_verified</condition></gate_entry>
  <activity>Exact preauthorized cleanup only — task worktree, local branch,
    remote branch still naming the integrated head, reproducible-disposable
    outputs (`deliver_work.close`, `improve_work.cleanup`). Any other
    destructive cleanup needs explicit authorization (`reserved_authority`).</activity>
  <gate_exit><condition ref="deliver_work.close">unit_closed</condition></gate_exit>
</stage>

**Alongside every stage:** report progress and blockers (`track_work`); escalate
a way-of-working finding at any point (`improve_work.change`).

## Gate check output

At each stage boundary emit:

```
<gate_check stage="<name>" result="pass|block">
  <evidence condition="<condition>">…the fact, citing its config key…</evidence>
</gate_check>
```

`result="block"` when a condition is unmet: name the condition, say why, stop.
A blocked stage does not advance.
