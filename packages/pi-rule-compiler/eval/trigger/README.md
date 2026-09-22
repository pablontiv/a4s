# Trigger local evaluation

Keep local, ignored fixtures in `fixtures/`; they must contain no real session
text, credentials, or chunks. Each fixture supplies only gate booleans, context-token counts, and a synthetic Jev `compact|wait`
answer.

Report gate coverage, hint precision, auto precision, and false auto actions.
The repository does not ship an upstream compact-adviser eval fixture because
the audited `pi/` and `eval/` trees at the pinned commit were empty.
