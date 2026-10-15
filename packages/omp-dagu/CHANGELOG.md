# Changelog

## Unreleased

- Return Dagu feature rebase conflicts and `DIRTY` pull requests to `implement` through the iteration-protected conflict checkpoint.

- Unify the Dagu status widget, triage guard, reviewer agent and `dagu-feature` skill in `@a4s/omp-dagu`.
- Add the main-only `dagu_session_id` tool and wake the matching coordinating OMP session with an agent-attributed aside when its `feature` run enters `triage` or `implement`; REST and SSE now share transition state with startup-only baselining and REST recovery.

- Ship the native OMP `triage-reviewer` agent in the extension package's `agents/` directory, with structured output and the concrete triage decision schema.
- Bind triage markers, review requests and task/wait/async-result correlation to `triage-reviewer`, retaining the JSON parser and generation expiry contract.
- Preserve a requested triage review across executor-rejected task launches; consume it only on correlated reviewer results or native spawn feedback.
- Document package-directory discovery on OMP 18.11.0 without global settings changes and cross-family review integration.
