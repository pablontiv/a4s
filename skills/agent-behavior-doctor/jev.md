# Jev support

Use Jev only when the user explicitly requests it. Jev classifies evidence; it
does not authorize, route, or modify anything.

## Input boundary

Send a sanitized event summary, never raw transcripts, system/developer
prompts, tool-result bodies, credentials, tokens, absolute paths, session IDs,
or personally identifying content. Preserve only:

```json
{
  "harness": "pi|codex",
  "project_class": "named-or-redacted",
  "event_counts": {"human": 0, "assistant": 0, "tool": 0},
  "facts": ["primary evidence summaries"],
  "unknowns": ["missing provenance or records"]
}
```

Use `jev-latest` through the TypeSafe System One API. Keep known selection and
threshold policy in code, not in Jev.

## Questions

Ask independent questions in one request:

| Question | Primitive | Allowed answers |
|---|---|---|
| Recurs across sessions? | `noul` | yes/no |
| Dominant friction | `choice` | directive-to-question, promise-without-action, instruction-conflict, process-overhead, insufficient-evidence |
| Highest-leverage layer | `choice` | global-intent-memory, skill-routing, auto-answer, project-contract, insufficient-evidence |

## Evidence rule

Report Jev as **JEV SUPPORT**, never PRIMARY evidence. Use it only when it
agrees with cited PRIMARY facts. Interpret confidence:

- `>= 0.70`: high support, still not a verdict by itself.
- `0.40–0.69`: medium support; name competing options.
- `< 0.40`: low support; do not prioritize remediation from it.

If the API, key, model, or sanitized state is unavailable, state
`JEV SUPPORT: not established` and continue with primary evidence.
