# Changelog

## 0.3.12

- Version the global Dagu base configuration with seven-day history retention and document the history/retry consequences for older runs (#252).

## 0.3.11

- Capture implementer-delivered files in Dagu with canonical run/worktree ownership, confined paths, a binary patch, deterministic single-commit candidates and SHA-bound gate evidence. Preserve conflict deliveries in the same run/branch, archive replaced evidence, and publish only the currently verified candidate (#278).

## 0.3.10

- Allow 15 seconds for workflow discovery, run details and SSE headers under load, retaining the 30-second refresh cadence (#249).
- Distinguish slow REST/SSE timeouts from unavailable Dagu connections, retaining known workflow rows during timeouts and restoring the normal widget after recovery (#248).
- Require a version bump and matching release heading for every recursively discovered skill addition, modification or deletion, including local changes (#267).
- Make feature auto-merge idempotent for the verified head, merging CLEAN PRs immediately with the tested body and preserving guarded auto-merge for pending checks in the template and installed render (#242).

## 0.3.9

- Recover terminal notifications and owner-session wake messages for runs missing after a discovery outage, retrying unavailable or non-terminal details until completion or HTTP 404 (#247).
- Report the worktree path, porcelain status and diff summary on stderr when GATE leaves tracked or untracked changes, in both the feature template and rendered DAG (#216).

## 0.3.8

- Compare canonical directory identities in feature start and PoC base gates so symlinked primary and worktree paths are accepted, while mismatches report both paths (#265).
- Adopt the four staged a4s renders from bundle 0.3.8, source `pablontiv/a4s@fe5d444e9c9133d5bac3d2aeef054fee56d01fdb`, bootstrap `bootstrap-a4s-v0-3-8`, and Dagu 2.20.1 (#271; 2026-10-16).

## 0.3.7

- Wake the owning session for every feature, PoC and discovery human-task opening and final success, deduplicated by DAG/run/step/approval iteration (#262).
- Recover fast openings and eventual success from paginated DEFAULT event logs, including stale-cursor replay, while SSE continues rendering snapshots (#262).
- Serialize idle-session notice bursts through an owner-session FIFO and deliver active-session notices as ordered hidden asides (#262).

## 0.3.6

- Require the completed merge checkpoint as well as primary availability before `close_gate`: feature runs that enqueue a PoC finish successfully with closing skipped, while implementation runs retain their primary-availability checkpoint and cleanup sequence (#264).

## 0.3.5

- Fold the status widget like OMP's `TODO` and `Subagents` HUDs: `Workflows` title, tree rows sorted by completion, three runs collapsed and up to eight expanded; `/workflows` toggles the fold and accepts `expand`, `collapse`, `show` and `hide` (#227).
- Keep workflow rows focused on progress and tool intention (`i`, then `title`, then the principal argument); report bundle compatibility in `[DAGU STATE]` notices (#227).

## 0.3.4

- Pin Dagu 2.20.1 after live compatibility verification, retaining compatibility with installed 0.3.x DAGs and documenting the observed SSE limit of 20 topics per connection; 21 returns HTTP 503 `unable to open SSE stream` (#284).

## 0.3.3

- Consolidate issue coordination in `dagu-feature`: checkpoint-only coordination, Dagu-owned worktrees, session ownership, implementation-subagent boundaries, terminal PR recovery, monitoring and operator-language reports (#244).
- Document a4s template/render pairs and operator-owned relinking after OMP package moves (#244).

## 0.3.1

- Accept `POC=no` triage completions from the per-primary transcript bucket that omp's `SessionManager.getSessionDir()` returns (`~/.omp/agent/sessions/<encoded primary>`), or a directory below it, and keep rejecting other repositories, other buckets and named-profile session roots, naming the expected default-profile directory in the message (#268).

## 0.3.0

- Preserve the tested commit body and terminal `Dagu-Feature-*` trailers in automatic squash merges by passing an explicit body prefixed with the issue closing reference, including repositories configured with `PR_BODY` (#235).
- Pause feature start/close and PoC base gates at conditional primary-availability checkpoints, with concrete dirty/branch causes, owner-session notices and same-run push-back rechecks (#228).
- Require a greater bundle version and matching release heading whenever a distributed DAG template or `SKILL.md` changes, checked against the PR merge base with isolated Git fixtures and shallow-CI coverage (#234).
- Add the repo-agnostic `discovery` DAG: read-only snapshots, lens findings and temporal history, fail-closed JSONL validation, independent verdicts, work-unit approval, idempotent issue materialization and policy-driven `feature` enqueueing (#222).
- Wake the coordinating OMP session at the four `discovery` human checkpoints and document its operator flow (#222).
- Make lifecycle completion verify cleanup: `close_gate` now removes and asserts the feature worktree and local/remote branches, PoC cleanup asserts its worktree and branch are gone, and lifecycle changes are exercised by the first post-merge run (#209).
- Skip missing historical `PRIMARY` directories with `SKIP_PRIMARY <path> missing`, preserve visible Git failures for existing directories, and reconcile waiting runs independently of leftover detection while retaining a `Failed` DAG verdict for leftovers or detection errors (#225).
- Preserve PoC ownership when history omits optional params, matching `poc-<RUN>` worktrees and `poc/<RUN>` branches to their `dagRunId` and reporting terminal owners with their run ID and status (#225).
- Reject `POC=no` triage completions from sessions outside the run's canonical primary repository or transcript namespace, with an actionable coordinator command before the run advances (#236).
- Allow a fresh explicit triage review request to bind a replacement reviewer within the same generation; the latest valid bound review supplies the required `REVIEW`, including when it replaces `poc=yes` with `poc=no` (#237).

## 0.2.0

- Version the complete bundle, stamp rendered DAGs with their package/source/bootstrap/Dagu identity, report compatibility in the extension, and add the `dagu-feature-bundle` inspection CLI.

- Bind every `triage-reviewer` in a batched `task` call to its own run generation across synchronous results, native spawn feedback, waits and asynchronous completions.
- Request SHA-guarded auto-merge immediately after PR creation, releasing the repository queue slot while GitHub waits for the required check and letting the reconciler return `DIRTY` PRs through rebase and conflict review.
- Report managed feature and PoC worktrees and local `dagu/*` branches that have no queued, running or waiting owner on every reconcile tick.
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
