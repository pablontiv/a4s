# Changelog

## 0.2.0

- Version the complete bundle, stamp rendered DAGs with their package/source/bootstrap/Dagu identity, report compatibility in the extension, and add the `dagu-feature-bundle` inspection CLI.

- Add the repo-agnostic `discovery` DAG: read-only snapshots, lens findings and temporal history, fail-closed JSONL validation, independent verdicts, work-unit approval, idempotent issue materialization and policy-driven `feature` enqueueing.
- Wake the coordinating OMP session at the four `discovery` human checkpoints and document its operator flow.

- Bind every `triage-reviewer` in a batched `task` call to its own run generation across synchronous results, native spawn feedback, waits and asynchronous completions.
- Request SHA-guarded auto-merge immediately after PR creation, releasing the repository queue slot while GitHub waits for the required check and letting the reconciler return `DIRTY` PRs through rebase and conflict review.
- Report managed feature and PoC worktrees and local `dagu/*` branches that have no queued, running or waiting owner on every reconcile tick.
- Make lifecycle completion verify cleanup: `close_gate` now removes and asserts the feature worktree and local/remote branches, PoC cleanup asserts its worktree and branch are gone, and lifecycle changes are exercised by the first post-merge run.
- Skip missing historical `PRIMARY` directories with `SKIP_PRIMARY <path> missing`, preserve visible Git failures for existing directories, and reconcile waiting runs independently of leftover detection while retaining a `Failed` DAG verdict for leftovers or detection errors.
- Preserve PoC ownership when history omits optional params, matching `poc-<RUN>` worktrees and `poc/<RUN>` branches to their `dagRunId` and reporting terminal owners with their run ID and status.
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
