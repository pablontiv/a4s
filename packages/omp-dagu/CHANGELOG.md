# Changelog

## 0.3.102

- Limit scheduled reconciliation to waiting feature discovery and PR/CI checkpoint transitions through `tick` and `reconcile-run`, preserving transition safety and lifecycle cleanup contracts.
- Remove the unowned human-task and leftover-resource detectors and their monitoring documentation.

## 0.3.101

- Read effective native `crossFamilyReview.policies` for the independent quality preflight and bound implementer dispatch instead of maintaining a second fixed fallback list; preserve transcript provenance, family admission and publication guards (#359).
- Document repository-owned adoption for code, QA, security, triage and planning review with cross-family 0.3.0.

## 0.3.100

- Add `dagu-feature-prioritize <feature|poc> <run-id>` to move a queued lifecycle run to the front of its concurrency-one repository queue while preserving all other relative order, original IDs, parameters and retained native definitions (#334).
- Persist private recovery snapshots and exact native enqueue arguments before dequeue; resolve existing receipts from retained adopted policy, verify snapshot/parameter consistency including JSON-schema defaults, and report partial queue effects and recoverable `LOST` entries on operation failure (#334).

## 0.3.99

- Report abandoned waiting feature, PoC and discovery human tasks through an independent read-only `UNOWNED` reconcile branch, using process-held OMP session locks and visible fail-closed liveness diagnostics (#301).

## 0.3.98

- Persist the optional consumer `A4S_BLOCKER_REPORTING=ask|auto` choice in adopted feature policy, preserving the installed choice on blank bootstrap upgrades and requiring explicit opt-in for automatic reports (#454).
- Define the same-host native A4S owner handoff with scoped authorization, private evidence payloads, verified blocking issue receipts and consumer readback, preserving consumer ownership and unrelated lifecycle state (#454).
- Render and verify digit-bearing placeholders such as `__A4S_BLOCKER_REPORTING__` in admission fixtures and installed DAG source provenance (#454).

## 0.3.97

- Admit consistent native fallback `session_init` refreshes in planning review and feature triage: require one expected-parent session and one or more identical agent/task initializations, retain first-init freshness, and preserve generation and final structured-yield validation (#466).
- Exercise refreshed planning review through native Dagu push-back, approval and materialization, with consumer-boundary regressions for transcript identity and verdict checks (#466).

## 0.3.96

- Align station-install skill and operating documentation with the existing queue-name merge contract: template-owned fields replace matching queue values (including `a4s.max_concurrency=8` to bundled `2`), while extra metadata and foreign queues retain their values. Classify the original report as source evidence, not an observed production overwrite (#449).

## 0.3.95

- Share the canonical planning unit schema and complete deterministic JSONL diagnostics between upstream preparation and native `check_plan` through `dagu-feature-bundle validate-planning-units`, preserving exact validated input bytes and independent semantic review (#443).
- Materialize explicitly approved existing-issue revisions and native blocked-by/sub-issue relationships in the existing planning backend. Preserve undeclared fields and existing edges; retain durable partial-progress mappings and grouped complete remote-state verification so retries converge without search-index freshness (#444).

## 0.3.94

- Validate implement completion against the current checkpoint cutoff and coordinator allocation using the same transcript and effective-model provenance required by quality review, including feature-last commands with spaced quoted inputs and reordered flags; stale deliveries retain Waiting implement with a fresh-task remedy.
- Bind literal implement completion to Bash word-boundary comments and preserve quoted, escaped and embedded hashes; recognize one literal simple command and diagnose compound boundaries, expansion, redirection and incomplete quoting before provenance lookup.
- Apply the same implementer provenance checks to native attached `-r<run-id>` completion arguments without consuming the following step flag.
- Discover static JavaScript string and template command literals separately from shell parsing, including tagged templates and wrappers containing `#` comments; apply the same freshness/provenance check to the decoded shell command. Require one inspectable static call and reject ambiguous, dynamic or unsupported visible implement-completion intent before lookup, preserving Waiting implement against fresh decoys and stale actual commands.
- Allow native quality-review push-back to implement in the same run and iteration history.
- Run the native implement-guard and quality-review rewind regression in the canonical pinned-runtime live test suite.
- Preserve the combined candidate's original merge-base during capture and handoff so all intended source changes reach the integration candidate (#375).
- Materialize typed GitHub relationships separately from unit completeness, retaining independent completeness evidence (#442).
- Bound planning preparation, record effort, and require independent plan review before operator approval (#445).
- Clarify recovery delivery versus feature publication: recovery preserves retained evidence while feature publication follows its own candidate and quality boundaries (#450).
- Read Dagu's structured native push-back counter in all three planning consumers, preserving the observed iteration across review and approval rewinds (#452).

## 0.3.93

- Restore the official Dagu 2.20.1 runtime requirement and upstream release downloads, preserving manifest-derived fixtures, checksum verification and exact runtime/admission enforcement (#440).
- Replace current custom-distribution and rebuild guidance with official-release installation guidance; station activation remains operator-owned. This restores distribution policy without repairing the upstream state-repair race.

## 0.3.92

- Pin Dagu 2.20.1+a4s419.2 for native lifecycle state transitions and distribute checksummed prebuilt runtimes from the A4S prerelease (#419).
- Preserve exact runtime identity checks and document native source provenance, reproducible builds and separately authorized station deployment.

## 0.3.91

- Complete the parent feature run successfully after triage delegates to PoC, skipping implementation quality preparation on that route.
- Remove a dirty PoC worktree only when its current full patch exactly matches published evidence and a publication marker exists; retain the worktree and branch with an issue #398 diagnostic when that proof is missing or stale.

## 0.3.90

- Consolidate issue creation in backlog breakdown: import staged units, validate and independently review them, then materialize the operator-approved subset.
- Route refined needs and discovery findings through the same breakdown backend; run PoCs against existing issues and retain feature/PoC continuations.
- Separate Sprint Planning, Sprint Review and Sprint Retrospective, with completion checks in planning and evidence-bearing reports refined into backlog units.
- Admit the planning backend through the distributed bundle CLI.

## 0.3.89

- Admission accepts lifecycle renders sealed at any patch release of the package's major/minor, so package patch merges no longer require re-sealing adopted DAGs; a different minor is still rejected.
- Admission also accepts a render that matches the installed checkout's template, since versioned renders are updated with their templates in the same PR.

## 0.3.88

- Resolve quality guard and resource ownership PRIMARY through the adopted run snapshot, with historical parameter compatibility (#387).
- Accept repeated session initialization for an identical agent/task identity after plugin reloads, preserving the first invocation timestamp for freshness checks (#387).

## 0.3.87

- Keep `npm test` in-process with an explicit shared opt-in gate for real Dagu commands; run isolated Dagu integrations through `npm run test:live` and the pinned-runtime CI job.

## 0.3.86

- Repair isolated lifecycle integration fixtures to use canonical admission paths, adopted policy environments and each Dagu service's API port, preserving retained-worktree adoption, PoC routing and ownership-checked cleanup.

## 0.3.85

- Bind gate, required check, rebase resolver and canonical primary at adoption, derive feature branches, reject policy run overrides before repository writes, and resolve runtime consumers from the enqueued policy snapshot (#274).

## 0.3.84

- Classify required CI for the current PR head as PENDING, PASS, CODE_FAIL, TRANSIENT, BLOCKED or STALE_SHA, retaining SHA/check/log diagnostics and bounded deterministic infrastructure retries (#226).
- Keep paired root checkpoints for CODE_FAIL → implement and BEHIND/DIRTY → rebase in the same run/worktree/PR, guard transitions by the observed iteration and reauthorize CI after asynchronous completion (#226).
- Deliver candidate-failure and diagnosed-wait evidence to the owning coordinator session and document the two return paths (#226).
- Parse both root waiting-step tree connectors independently of the service locale, with bytewise-locale coverage for the complete CI reconciliation scenarios (#226).

## 0.3.83

- Add an adoption-fixed optional repository validation checkpoint between gate and push, with tested-SHA approval, reason-bearing iterative push-back, visible operator notices and isolated smoke guidance (#276).

## 0.3.82

- Add the new planning DAG: independently reviewed, operator-approved plans become idempotent issues and feature/PoC runs, with durable validation feedback, bootstrap adoption, and planning status notices (#292).

## 0.3.81

- Share ownership-checked, integration-proven, idempotent feature cleanup across close and exit; retain dirty or uncertain resources with durable evidence and report interrupted cleanup phases in the reconciler (#281).

## 0.3.80

- Reload the status and triage extension generations through `/reload-plugins`, preserving the builtin resource refresh with idle deferral, bounded lifecycle cleanup and rollback on import or factory failure (#297).

## 0.3.79

- Report `main=n/a` for consumer repositories without the omp-dagu manifest and accept bundle/extension patch drift as `ok`; reserve `stale` for loaded-extension drift from applicable main or an unreadable/invalid main manifest (#380).
- Raise a `warning` notification for stale notices while the coordinator continues its turn, preserving exact-version admission (#380).

## 0.3.78

- Install the manifest-pinned official Dagu release for the omp-dagu CI matrix entry, verify and log its SHA-256 digest, and require the effective version before running live integrations (#337).
- Document the CI runtime preflight and local integration prerequisites (#337).
- Isolate DAGU_HOME for in-process calls in live admission tests so they pass on runners without ~/.dagu (#337).

## 0.3.77

- Supply QA/reviewer assignments with literal raw-JSON verdict bindings and the standalone candidate-SHA command, and document fresh names for every attempted invocation (#379).
- Seal the inspected transcript prefix and evaluate runtime provenance on those same bytes so appended rows remain admissible while changed or truncated evidence fails; stop quality preparation before writing a request when the worktree is missing (#379).
- Require a newly allocated `Implement<ISSUE>v<N>` subagent for each quality push-back correction, preserving a single `session_init` and unambiguous session identity like QA/reviewer retries (#379).

## 0.3.76

- Enforce compatible, determinate deployment identities before enqueue, including internal feature/PoC/discovery promotions; capture canonical SHA-256 fingerprints, immutable admission snapshots and append-only categorized run observations (#277).
- Verify rendered templates through ordered literal matching so large lifecycle DAGs remain admissible without exceeding the JavaScript regular-expression size limit (#277).
- Run admission CLI integration coverage when Dagu 2.20.1 is available, with explicit skips on runners without that binary (#277).
- Create admission receipts exclusively and read optional configuration directly, handling filesystem errors atomically; inspect receipt permissions through an open descriptor in integration coverage (#277).

## 0.3.70

- Allow operators to decline a PoC at run_poc with a reason, recording one issue comment and cleaning up without a verdict or feature promotion (#263).

## 0.3.68

- Require independent effective cross-family QA and review on each local candidate before PR-branch publication. Correlate raw OMP transcripts with parent task invocations, SHA/run/iteration/role and canonical model families, preserve observed fallbacks, validate both verdicts, and push FAIL findings back to implementation in the same run. Bind publication and auto-merge to the admitted SHA; document the advisory Dagu-store boundary (#280).

## 0.3.60

- Diagnose PoC result scope failures and rewind the same run to run_poc with the first diagnostic in its owner notice (#266).

## 0.3.58

- Apply station defaults through coordinated admission, running/queued drain, TERM restart and next-enqueue concurrency verification; preserve admission closure and recovery barriers on failure (#255).
- Reconcile managed queue capacity by name while preserving foreign queues, LaunchAgent installation and drift checks (#255).

## 0.3.49

- Preserve candidates in leased checkpoint refs and publish the exact gated SHA only while the candidate remains clean and fresh (#275).

## 0.3.42

- Require the primary checkout and package version to match origin before feature/PoC admission, with cause, SHA and version diagnostics (#347).
- Compare loaded extension, stamped bundle and primary main versions in notices; abort stale turns with restart/re-seal instructions (#347).
- Enqueue the versioned bootstrap automatically after merging skill or changelog changes so adoption re-seals the rendered DAGs (#347).

## 0.3.40

- Reconcile concurrent a4s bundle releases during rebase through an explicit repository adoption resolver; preserve functional conflicts and renew candidate/gate evidence before publication (#339).

## 0.3.26

- Version the station LaunchAgent, base defaults and owned server configuration; install or check them idempotently with Dagu 2.20.1 validation while preserving other repositories' queues and configuration (#251).
- Run live station installer coverage when Dagu 2.20.1 is available, and skip it on hosts without the required binary (#251).

## 0.3.21

- Finish PoC-routed feature parents with implementation skipped so promoted runs can acquire the issue after terminal ownership handoff (#344).

## 0.3.20

- Sign captured candidate commits according to repository Git signing configuration while retaining deterministic dates and identical-candidate reuse (#343).

## 0.3.19

- Give each live recovery fixture a UUID-suffixed run identity and exercise concurrent, isolated Dagu services through their own checkpoints, iterations, candidate SHAs and teardown (#340).
- Document Dagu 2.20.1's host-global control socket identity and the per-fixture recovery ID pattern (#340).

## 0.3.18

- Preserve the terminal resource owner's provenance between admission and worktree adoption, with identity diagnostics and real-Dagu reenqueue coverage (#338).

## 0.3.17

- Run the live index-lock retry test with real Dagu and safely await running service shutdown so startup failures retain their captured diagnostics (#336).

## 0.3.16

- Keep start, gate and push failures in the same feature run with recovery checkpoints, iteration-protected push-back and coordinator notices (#260).

## 0.3.15

- Protect active feature/PoC resources and the primary checkout in OMP bash calls; fail closed with ownership diagnostics when history is unavailable (#215).
- Serialize feature admission, retry and terminal handoff by canonical primary/issue; preserve existing candidate commits/files and make authorized feature/PoC cleanup identity-checked and locally idempotent (#215).
- Give real Dagu integration fixtures random-suffixed run IDs to isolate Dagu 2.20.1's global run sockets across concurrent worktree gates (#215).

## 0.3.14

- Poll the PR head every five seconds for up to sixty seconds before requesting guarded auto-merge; on expiry report the expected and last observed SHAs (#257).

## 0.3.13

- Distinguish active rebase conflicts from other Git failures and retry a held worktree index lock up to three times at five-second intervals in both feature DAGs (#214).
- Document bounded index-lock retries and cover lock preservation and real conflict rewind behavior with an isolated, readiness-checked Dagu run (#214).

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
