# Forensic multi-session diagnosis

Use this reference only for two or more sessions, cross-project comparison,
multiple harnesses, or Beads ownership analysis.

## 1. Select and measure

List sessions by **last activity**, not start date:

```sh
backscroll list --all-projects --order timestamp:desc --limit 10 --json
```

State that criterion in the result. Measure every selected transcript before
reading it. Treat an old-started automation with recent activity as recent by
this definition; do not call it a newly started session.

## 2. Normalize evidence

Create this event shape per harness:

```text
session_id, project, harness, timestamp, line,
human_instruction, assistant_response, promise, tool_call,
tool_result, phase_change, next_human_turn
```

Pi usually stores `message.role`; Codex commonly stores `payload.role` inside
`response_item`. Verify each format from its records before extracting. Never
compare missing fields as behavioral absence.

Label every claim:

- **PRIMARY**: exact transcript/configuration/tool-result citation.
- **CORROBORATIVE**: independently repeated PRIMARY pattern.
- **INCOMPLETE**: unavailable transcript, provenance, or outcome.

A promise/action gap requires: exact promise, matching action call or its
absence, and the next human turn. A pattern is recurrent only with two or more
separately cited sessions.

## 3. Beads ownership

Inspect canonical Beads separately from conversation intent:

```sh
bd ready --json
bd show <id> --json
```

If `bd` is unavailable, classify ownership as `unknown`; do not assume a
repository-specific wrapper exists.

Classify each candidate:

| State | Meaning |
|---|---|
| `claimable` | Ready and unassigned or assigned to the current claim pool. |
| `assigned` | Ready but held by another active assignee. |
| `stale-lease` | Claim exists but the canonical lease is expired; inspect before `reclaim`. |
| `graph-blocked` | A declared predecessor is incomplete. |
| `status-blocked` | Manual/deferred status prevents readiness without a declared predecessor. |
| `unknown` | No canonical record proves ownership or dependency. |

Never attempt `--claim` for `assigned`; do not infer claimability from `ready`.

## 4. Runtime controls

Inspect only controls that can explain a cited event: active instructions,
loaded skills, persistent memory injected before the response, auto-answer
provenance, real compaction/resume events, and tool validation failures. A
compaction hint is not a reset. An assistant summary is not a human directive.

## 5. Return in chat

```text
Verdict: <one sentence>
Verified factors: [PRIMARY/CORROBORATIVE] <citation + fact>
Recurring problems: <sessions + confidence>
Beads ownership: <classification + canonical evidence>
Not established: <missing evidence>
```

Do not create a report, todo, memory, or subagent unless the user explicitly
asks for that artifact.
