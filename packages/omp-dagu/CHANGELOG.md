# Changelog

## 0.2.0

- Add an opt-in headless triage pre-pilot with bounded cgroup cleanup, fail-closed role output/schema/semantic checks, run+generation reviewer-binding negatives, and a reproducible Dagu-owned RPC steering probe; retain the operator's R28 and live-pilot gates (#920).
- Wake the targeted supervisor once per role escalation or feature/PoC decision task, including outstanding tasks at startup, and expose `dagu_session_id` to supervisors without requiring a coordinator (#920).
- Define `dagu-golden-vN` as the stable-version tag: both lifecycle paths accepted on the commit the station ran, without supervisor intervention, created only after operator approval.
- Require Dagu-native tests in CI and the local gate with checksum-pinned Dagu 2.26.0, portable isolated fixtures, and a real-server review-state/human-task transition contract (#976).
- Read widget and bundle-inspector station settings from repository/worktree `.workspace/config/dagu.json`, fetch the installed reconciler spec through that station's API, and stop guessing OMP profile/session paths (#982).
- Add explicit supervisor/coordinator/researcher launcher roles and activate `dagu_session_id` only for coordinators, stripping it for other or unknown roles even when pre-listed (#981).
- Require Dagu 2.26.0 for the bundle/bootstrap and align the a4s station templates, rendered DAG stamps and version fixtures without changing DAG behavior (#983).
- Version the complete bundle, stamp rendered DAGs with their package/source/bootstrap/Dagu identity, report compatibility in the extension, and add the `dagu-feature-bundle` inspection CLI.

- Bind every `triage-reviewer` in a batched `task` call to its own run generation across synchronous results, native spawn feedback, waits and asynchronous completions.
- Request SHA-guarded auto-merge immediately after PR creation, releasing the repository queue slot while GitHub waits for the required check and letting the reconciler return `DIRTY` PRs through rebase and conflict review.
- Report managed feature and PoC worktrees and local `dagu/*` branches that have no queued, running or waiting owner on every reconcile tick.
- Make lifecycle completion verify cleanup: `close_gate` now removes and asserts the feature worktree and local/remote branches, PoC cleanup asserts its worktree and branch are gone, and lifecycle changes are exercised by the first post-merge run.
- Clean up feature worktrees and local branches after squash merge when GitHub reports the PR merged with the exact local head SHA, while retaining work on lookup failure or SHA mismatch.
- Preserve unpublished feature branches and worktrees on terminal exit, and review dependency relationships when an existing dependency gains a new package consumer.
- Verify every `POC=no` triage-reviewer transcript in `triage_decision` before external effects, binding its parent OMP session, agent, feature run marker, current `triage.startedAt` generation and last `poc=no` yield.

- Show live current-step activity in the status widget: the latest Dagu log line for running commands and the newest tool call from deterministic `TriageReview<ISSUE>`, `Poc<ISSUE>` or `Implement<ISSUE>` transcripts for waiting agent tasks.
- Refresh activity every two seconds while its step remains active, with bounded transcript reads, retry selection, sanitization, truncation and lifecycle cancellation.

- Return Dagu feature rebase conflicts and `DIRTY` pull requests to `implement` through the iteration-protected conflict checkpoint.

- Unify the Dagu status widget, triage guard, reviewer agent and `dagu-feature` skill in `@a4s/omp-dagu`.
- Add the main-only `dagu_session_id` tool and wake the matching coordinating OMP session with an agent-attributed aside when its `feature` run enters `triage` or `implement`; REST and SSE now share transition state with startup-only baselining and REST recovery.

- Ship the native OMP `triage-reviewer` agent in the extension package's `agents/` directory, with structured output and the concrete triage decision schema.
- Bind triage markers, review requests and task/wait/async-result correlation to `triage-reviewer`, retaining the JSON parser and generation expiry contract.
- Preserve a requested triage review across executor-rejected task launches; consume it only on correlated reviewer results or native spawn feedback.
- Document package-directory discovery on OMP 18.11.0 without global settings changes and cross-family review integration.
