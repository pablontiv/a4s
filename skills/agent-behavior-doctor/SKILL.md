---
name: agent-behavior-doctor
metadata:
  author: pablontiv
  updated: "2026-09-29"
description: Use when an agent repeatedly promises work without acting, asks settled questions, becomes procedurally slow, follows stale memory, or appears affected by skills, auto-answer, compaction, or conflicting instructions. On invocation, scan proactively; do not ask for a symptom.
---

# Agent Behavior Doctor

Diagnose agent flow with evidence. Read-only unless asked to fix.

## Proactive default

Invocation is sufficient. Never ask for symptom, session, or scope. Scan the
current session plus ten recently active cross-project sessions. **REQUIRED
REFERENCE:** read `forensic.md`; read `jev.md` only when the user explicitly
requests Jev.

## Focused mode

When the user names a session or symptom, restrict the scan to it.

1. Bind human instruction, assistant promise, next tool call or absence, and
   next human turn.
2. Inspect decision-changing inputs only: instructions, skills, injected memory,
   auto-answer provenance, real compaction/resume, failures, and phase gates.
3. Return verified cause, contributors, evidence, and unknowns.

Never infer a historical user instruction from an assistant summary. A human
prompt outranks memory; current instruction files outrank old transcripts.

## Evidence

A promise/action gap needs the exact promise, matching action or absence, stop
cause, and next human turn. Recurrence needs multiple cited sessions. Mark
unavailable provenance `not established`; summarize private rule categories.

## Scope selection

| Situation | Response |
|---|---|
| No target supplied | Proactive default; read `forensic.md`. |
| One concrete target | Focused mode; no delegation. |
| Multi-session, cross-project/harness, or Beads | Read `forensic.md`. |
| Jev explicitly requested | After `forensic.md`, read `jev.md`. |
| Persistent forensic artifact requested | Use `diagnosing-superpowers` if available. |
| Direction conflicts with repo policy | Reconstruct which governed; do not resolve policy or create a live gate. |

## Red flags

Stop and correct the diagnosis if you:

- ask for symptom/session/scope after invocation;
- convert a direct correction into a question;
- rank auto-answer above user text;
- persist assistant inference as user preference;
- call a compaction hint a reset;
- promise change without its first action.

## Output contract

Use this shape:

```text
Verdict: <one sentence>
Verified factors: <bullets with evidence>
Not established: <bullets>
```

Do not propose a fix unless asked. If asked, separate the diagnosis from the
proposed change and state the exact file or configuration target first.
