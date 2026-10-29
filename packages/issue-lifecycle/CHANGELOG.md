# Changelog

## 0.7.6

- Brace the PoC resource-lock run variable at the `.lock` boundary so Dagu does not interpret the shell filename as a dotted JSON reference; preserve per-run ownership, collision handling and cleanup (#483).
- Keep implementer and gate-recovery disposable evidence outside the worktree, under the run's `computations/` directory or `$TMP`. Reject untracked `.workspace/` paths and nested `.git` entries before capture staging, with the offending path and allowed scratch location (#758).

## 0.7.5

- Preflight native retry/resume/stop mutations against the caller's required toolchain before invoking Dagu, so a shell without `jq` fails before any step runs. Feature ownership cleanup distinguishes missing/unavailable `jq` from malformed history (#757).
- Classify GitHub CLI's exact exit-1/stdout no-required-check response as `PENDING` / `WAIT` only after independently confirming classic and effective ruleset policy on the PR's effective base and complete current-head publication evidence. Preserve app constraints, paginated statuses, changed PR/head/base binding rejection and actionable lookup failures; report pending publication accurately to the owner (#411).

## 0.7.4

- Redact known PoC worktree, primary, home and Dagu-home roots to public-safe placeholders before checking or publishing normal/failure comments (including chunked evidence and PASS follow-through), while preserving raw run evidence and rejecting unrelated host paths. Tell `run_poc` executors the placeholder rule (#679).
- Reuse an existing `poc-<RUN>` after repeated yes-triage instead of enqueueing a duplicate ID, and publish the yes-triage comment only after scope approval and successful PoC reuse/admission so failed enqueues leave no orphaned comment (#295).
- Normalize omitted PoC scope decision fields per action and re-ask rejected decisions through a recovery checkpoint with automatic push-back. Preserve run/request-bound rule/expected/observed diagnostics outside the worktree, guard PoC admission, and retain intentional cancellation/deferral terminal routes (#751).
- Accept native OMP's optional leading `Complete assignment thoroughly:` assignment prefix in planning review transcripts while preserving exact first-line generation binding after the prefix; document host behavior and cover misplaced, wrong-run and wrong-iteration markers (#747).
- Replace Sprint Planning/Review's effecting admission probe with installed `a4s admit --check`: validate committed config, resolve `uses` and reuse read-only queue/scheduler/service readiness before any cache, receipt, handoff or enqueue. Rejections explain why admission is unavailable without changing lifecycle state (#746).
- Tell implementation and conflict-resolution roles that summaries become PR bodies: use repository-relative paths or explicit placeholders, with raw host-specific commands/results retained only in run artifacts. Bound host-path checks to path starts and unquoted username tokens (allow spaces inside quoted paths), so nested sandbox paths and `/home/shared` prose no longer block feature PRs or PoC publication (#677).
- Register the TypeScript loader inside the station-home isolation test worker before importing source fixtures, preserving the regression check under Node's strip-only TypeScript support.

## 0.7.3

- Bootstrap rejects missing or incorrect `auth.mode: none` / `coordinator.enabled: true` station config before adoption and probes its existing run-spec API through unauthenticated loopback access, the same route used by feature admission. Failures identify the operator-owned config merge and service restart; readiness never modifies station files (#673).

## 0.7.2

- Make the default workspace test gate in-process and enforce its no-subprocess contract with a shared spawn guard (only direct `git`/`tar` allowed). Preserve real CLI, compiled-release, YAML, Dagu, OS-lock and timing assertions in explicit `test:live`/`test:compiled` lanes; remove the heavy-slot wrapper and forced serial execution from default suites (#683).
- Isolate default, live and compiled test processes, fixtures and subprocess artifact caches from inherited `HOME` and `DAGU_HOME` with a shared temporary-home preload and exit cleanup, including children that fall back to `~/.dagu`. Native wrappers retain the inherited station-wide orchestration lock as the single explicit exception outside the test process (#728).
- Hand current-SHA, latest completed failed local gate evidence to the implementation role after `recover_gate` push-back through `implement_budget`, including bounded, path-sanitized untrusted diagnostics and explicit repair obligations while preserving CI/conflict handling (#729).

## 0.7.1

- `capture` reads the implement summary and commit message from the verified role-job receipt instead of the single-line Dagu outputs, so candidates, commits and rendered PR bodies keep their line structure (#724).

## 0.7.0

- Breaking: the station reconciler is operator-pinned to an exact cached release and dispatches every per-run action through that run's own cached `a4s` (receipt tuple verified against the cache); the OMP plugin loads from an extracted release directory and dispatches run mutations through the run's artifact under declared receipt/protocol compatibility. Artifacts without the dispatch boundary (0.6.0) are reported unsupported and left untouched (#713).

## 0.6.0

- Breaking: the engine ships as one compiled `a4s` executable in versioned GitHub releases (`a4s-v<version>-<os>-<arch>.tar.gz` + `.sha256`, moving major tag `v0`). Consumers select it with committed `uses: a4s@v0` or an exact `a4s@v<x.y.z>` in `config.json`; root admission resolves once, verifies and caches the archive under `$DAGU_HOME/cache/a4s/<version>/`, and hands off to `a4s admit --artifact '<version>@<commit>#<digest>'`. Snapshots bind `A4S_BIN`; receipts record the artifact tuple and contract versions; successors bind to the parent's artifact. Station install/executor commands, checkout stamps and re-seal, legacy `dagu-*` bin registrations and the Python runtime helpers are removed (#712).

## 0.5.32

- Consumer policy comes only from committed `config.json`: admission rejects policy parameters (including `BASE_BRANCH`), templates bind policy as fixed environment, and successors stop forwarding `BASE_BRANCH`/`PRIMARY`. Owner-session validation runs before any admission side effect. `queueConcurrency`, queue repair and station config/service install modes are removed; `dagu-feature-bundle readiness` checks the station read-only (#708).

## 0.5.31

- Role jobs read the OMP runtime root only from an explicit absolute `DAGU_OMP_ROLE_RUNTIME` (Dagu forwards `DAGU_*` to steps); `OMP_ROLE_RUNTIME` and PATH discovery are removed. Bootstrap runs `dagu-role-jobs detect`, which resolves the runtime and the `triage-reviewer`/`task` agents the way role jobs do (#674).

## 0.5.30

- Protect an idle PRIMARY when it holds a committed `.workspace/dagu/config.json` and its canonical path equals the resolved host PRIMARY binding; render-based detection is removed (#707).

## 0.5.29

- Rename the committed lifecycle policy to `.workspace/dagu/config.json` without an old-path alias. New admission receipts use schema 2 and `configDigest`; readers retain schema 1 support for already-admitted runs and reject unsupported versions before effects (#706).

## 0.5.28

- Remove the exact Dagu runtime pin from bootstrap, admission, bundle inspection, prioritization and station installation. Record the observed runtime version in admission receipts; document Dagu 2.23.0 or newer and keep the minimum check only in live-test fixtures (#705).

## 0.5.27

- Consumers version `.workspace/dagu/answers.json` (schema 1, independent of the package version). Admission materializes feature, PoC, discovery and planning DAGs from the installed package templates, resolves PRIMARY, and records the answers digest with the per-run snapshot. A package or Dagu release that does not change answers no longer needs a consumer adoption commit (#684, #354, #678, #680).
- Run CI unit tests and typechecks without installing Dagu; gate all real-Dagu tests behind `A4S_LIVE_DAGU=1` and run live integration on the station with `A4S_LIVE_DAGU=1 npm test` before a package release (#683).

## 0.5.26

- Require the official Dagu release pinned in `daguFeature.dagu`, update current installation and checkpoint guidance, and derive runtime-version fixtures from that pin. Keep earlier station and drained-restart proofs bounded to the versions they exercised.
- Exercise the pinned runtime's stale-process error, SSE topic boundary, CLI run history/status and persisted run records in an isolated live compatibility test. Include native escalation/restart coverage in the live acceptance command.
- Keep Node and shared development-tool pins only in the root manifest, reference canonical fields in maintained documentation and fixtures, and guard tracked source against copied pins. Workspace-local dependencies use the workspace package identity rather than repeating its version.

## 0.5.25

- Write reconcile `classify` outputs `children`, `actions` and `failures` to `$DAGU_OUTPUT_FILE`. Dagu 2.20.1 reads declared outputs only from that file, so stdout lines such as `children=[]` failed every tick with `declared step output "children" was not emitted` and stopped `tick` and `act`. An empty discovery list now publishes `[]` and the tick continues with no fan-out.

## 0.5.24

- Serialize feature gate bodies and root/issue-lifecycle full-suite scripts across clones and agent sessions with one station-wide fcntl slot at `$DAGU_HOME/a4s/heavy-slot.lock` (default `~/.dagu`). Export `A4S_HEAVY_SLOT_HELD=1` for nested-script re-entry, retain holder diagnostics and inherited-descriptor release on exit, failure, cancellation and SIGKILL, and leave targeted tests and Dagu queue capacities unchanged (#606).
- Keep the slot regression fixtures compatible with the package's existing TypeScript library target instead of requiring `Promise.withResolvers` (#606).
- Read native gate-test logs through the same descriptor used to inspect their file type, avoiding a path-based check/read race (#606).
- Run the gate-exclusion fixture script via a file argv instead of `bash -c`, keeping behavior identical while clearing CodeQL `js/shell-command-injection-from-environment` on the test spawn (#606).

## 0.5.23

- Restore legacy feature human-task recovery targets and select Queued successors from the original attempt's node order, preserving completed decisions across bundle changes. Exercise automatic reconciliation on pinned Dagu 2.20.1, with per-attempt budget and non-stale failure coverage (#553).
- Require valid admin-event timestamps within five seconds for automatic stale-process recovery, so a delayed stale-process failure is not mistaken for the immediate Waiting/Queued scheduler overwrite (#553).

## 0.5.22

- Install station executors as independent exact-commit clones under `$DAGU_HOME/executors`, without development-clone worktree registrations or shared Git objects (#623).
- Route station role jobs through each run's immutable receipt; retain unsupported historical bundles without substituting the active pin.
- Inventory non-terminal references and record bundle-resolution/worktree evidence around explicit migration and reference-based retention. Preserve host-bound PRIMARY resolution when reading enqueued specs. Require operator-owned admission hooks for migration/removal and preserve active, referenced, dirty, foreign and development checkouts.
- Replace changed station launchers atomically without a separate existence check or writing through symlinks; byte-identical reinstalls preserve the launcher's mtime.

## 0.5.21

- Reuse successful gate test and typecheck results across linked worktrees from a station-local content-addressed cache. Git-state checks, including `bundle-version.test.ts`, run on every gate and are not stored. A failing task is never reused as a pass. The declared `GATE` command and `tested_sha` publication stay unchanged, and CI still runs the full uncached suite (#632).

## 0.5.20

- Build feature and cleanup test repositories from one immutable seed per fixture family. Each test gets a private copy with linked-worktree metadata and ownership paths rewritten (#633).
- Register waiting-cancellation scenarios once through the test glob. The live lane runs that file directly, so feature and PoC cancellation coverage stays in both modes.

## 0.5.19

- Bind feature and PoC `PRIMARY` to the host reference `"${A4S_PRIMARY}"` instead of a machine path. Enqueue, spec recovery and the resource guard resolve `$DAGU_HOME/primaries/<workspace>`, then `A4S_PRIMARY`, then `$DAGU_HOME/a4s-primary`. An admitted snapshot records that absolute main checkout (#659).

## 0.5.18

- Record an explicit operator integration protection for one candidate: its run, issue, changed paths, decision and provenance. Capture and a clean rebase refresh the protected paths (#559).
- Hold gate admission, push and auto-merge when another candidate's paths intersect that set, at a visible `integration_hold` checkpoint that names the protecting run. Disjoint candidates proceed. A run with no issue proceeds while nothing is protected. `close_gate`, terminal exit (including abort) and an explicit operator release let the held run continue with the same candidate, run id and iteration.
- Report the active protection and the runs it holds in the owning session's `[DAGU STATE]`. The record survives scheduler and OMP restarts.

## 0.5.17

- Observe non-PR waiting runs in the reconcile root. Keep `dag.run` children for `await_ci` and `await_merge`, read issue state once per repository with full pagination, and report closed `triage` or `implement` issues from that root observation (#636).

## 0.5.16

- Checkpoint long role-job and PoC computations by shard under the run evidence directory, resume from the last completed shard, and stall only after a configured multiple of the measured shard time with one owner notice and a continue, resize, or stop decision (#560).

## 0.5.15

- Admit a feature run when the loaded extension serves the render's triage, implement and publication protocols, including a render one minor version behind (#562).
- Reject an unserved checkpoint protocol before run creation, naming the missing protocol and the bundle version that serves it. The 0.3.102 `TRIAGE_REVIEW AGENT=` marker and the 0.3.108 human-task triage guard are not served.

## 0.5.14

- Keep about one day of reconcile history with `hist_retention_runs: 1440` on the reconcile root. Feature, PoC and planning still inherit `hist_retention_days: 30` from the installed base (#637).
- Adopt the count through the documented bootstrap. The first tick after adoption applies Dagu's count cleanup and leaves active and non-final roots in place.

## 0.5.13

- Classify a failed aggregate required check from the failed jobs of the same Actions run. A needed job's assertion failure returns `await_ci` to `implement`; runner, download, network and HTTP 5xx/429 failures stay transient; an aggregate failure with neither stays blocked (#546).

## 0.5.12

- Protect only lifecycle primaries in the OMP resource guard: the canonical PRIMARY of an active admitted run, including a primary resolved from its adopted snapshot, and a checkout whose adopted feature or PoC render names itself. Recursive removal of an independent clone that matches neither is allowed (#643).

## 0.5.11

- Bound each reconcile tick: page every Waiting feature run from the Unix epoch, observe independent runs concurrently, deadline external calls, and serialize conflicting transitions (#250).
- Record discover, observation and transition counts, skips and latencies. The 30-minute under-load station proof stays an operator acceptance run.

## 0.5.10

- Require the planning generation marker as the first line of the reviewer assignment `task` field, and name `session_init.task` plus the expected marker when `check_review` rejects a transcript (#647).
- Record the planning reviewer's effective agent, session, provider, model and ordered `model_change` fallbacks on `review-<iteration>.json` from the same transcript identity as native role evidence (#648).

## 0.5.9

- Carry a promoted PoC candidate into the feature worktree before implement by applying the published `full.patch` and verifying its recorded SHA-256. An empty later feature diff still records that the basis was applied. A PoC without promotion still disposes a clean base-only worktree and branch (#642).

## 0.5.8

- Exit every `dagu-role-jobs` terminal path so a native Python tool bridge listener cannot leave a BLOCKED or completed stage running (#639).
- Verify every package executable a rendered lifecycle DAG calls, including `dagu-gate`, during bootstrap `detect` before adoption (#644).
- Recover feature runs that Dagu failed with its stale-process signature from the scheduled reconciler, once per attempt, and keep the manual retry table as the fallback (#553).

## 0.5.7

- Adopt `CODE_SCANNING=required|off` per repository. Blank keeps the installed choice; `off` does not observe or wait for CodeQL, so auto-merge and final CI authorization depend only on the required check (#641).

## 0.5.6

- Bind PoC experiment prompts to the resolved question and result path, including issue-body question fallback (#352).
- Enforce local-only PoC branches with explicit remote SHA and unreachable-origin diagnostics; align cutover evidence and promotion instructions with their gates.

## 0.5.5

- Adopt a positive-integer `QUEUE_CONCURRENCY` bootstrap answer and stamp repository-owned capacity in feature, PoC and discovery renders (#383).
- Derive only that repository's named Dagu queue, retaining shared keys, comments, metadata and foreign queues. Restart the matching launchd scheduler only on changes; preserve waiting-task data and restore config atomically if restart fails.
- Report installed queue drift through bundle compatibility, preserve repository queues during station installation, and verify the stamped capacity with `--apply --repo-dag`.

## 0.5.4

- Record every feature gate attempt in `gate.json` schema version 1, retaining epoch-millisecond phase starts/ends, exit codes and durations for lock wait, install, workspace tests/typechecks, post-checks and overhead (#608).
- Observe npm lifecycle subprocesses around the unchanged declared `GATE`; preserve failed attempts and retries for structured reconciliation/report consumers.

## 0.5.3

- Make the persisted SQLite policy the role-job capacity authority per canonical `DAGU_HOME`; `A4S_ROLE_JOB_CAPACITY` seeds only the first policy and conflicting later values produce dispatch diagnostics (#609).
- Add `DAGU_HOME=<station-home> dagu-role-jobs capacity <positive-integer>` with transactional previous/new/time history and JSON output. Increases admit waiting claims immediately; decreases preserve active jobs until the count falls below the new limit.
- Document post-deployment operator change, conflicting-environment dispatch evidence and restoration through the same command; this does not claim station saturation.

## 0.5.2

- Acquire feature and PoC ownership directories through Python's atomic `os.mkdir` result, preserving exclusive ownership when a shell `mkdir` implementation reports success after a concurrent `EEXIST` (#626).
- Verify the durable winning owner after concurrent admission and same-owner candidate creation.

## 0.5.1

- Align station templates with the operator-approved a4s queue capacity of eight and thirty-day run history retention (#616).
- Keep station installation, retention and drained-restart coverage aligned with the approved defaults.

## 0.5.0

- Observe SHA-bound CodeQL checks and PR alerts after publication and during native reconciliation, returning threshold findings to implementation through the existing CI push-back route (#570).
- Adopt configurable security and non-security alert thresholds through bootstrap; retain code-scanning policy per candidate, wait for analysis before merge, and include findings in implementation assignments.
- Require an enabled CodeQL setup and the package's `dagu-codeql` CLI for newly adopted feature workflows; this new pre-merge analysis requirement changes the 0.x compatibility lane.
- Preserve retained runs' checks-only reconciliation when their immutable workflow has not published a candidate-bound CodeQL policy.

## 0.4.3

- Accept an explicit bootstrap `BASE_BRANCH` for integration-lane adoption, verify that branch exists, and retain the GitHub default branch when omitted (#434).
- Fetch role-job issue titles, bodies and comments through GitHub CLI JSON mode, allowing native triage and implementation dispatch with current `gh` releases (#434).

## 0.4.2

- Sync main through `58182c90eb0add228c0cf76a01cb6a06ca98839e` into the renamed v1 lifecycle package, retaining v1-owned renders and the quality-free workflow (#432).
- Observe running and queued station runs together before requesting a drained restart, preserving active work as queued runs begin execution.
- Persist run-wide lifecycle escalation budgets across native retries, resumes and push-backs, with owner-targeted decision evidence, renewed windows, route changes and retained stop/onExit evidence (#558).
- Fingerprint consecutive CI BLOCKED observations and send one owner decision request per fingerprint while reconciliation retains transition ownership.
- Require a bound PoC target/access assessment before admission and an owner decision for unreachable targets or repeated access/scope INCONCLUSIVE results; render configurable escalation thresholds through bootstrap.
- Exercise disposable live-Dagu recovery and publication fixtures against the escalation-aware graph, render PoC budgets as valid YAML strings, and serialize concurrent role-store initialization through SQLite's busy timeout.
- Render concise feature PR descriptions from the implement summary, passing gate and optional operator validation; refresh existing PR bodies on every candidate (#571).
- Share host-path rejection across feature PRs, PoC comments and the PR-body CI check. Require the repository PR template for Dagu and manual publication.

## 0.4.1

- Distribute all seven lifecycle workflow skills together: move refinement and the three sprint ceremonies into the lifecycle package, preserving their review, approval, handoff and Definition-of-Done boundaries (#428).
- Rename the independent OMP routing utility to `model-routing-audit`, preserving its scripts and updating runnable examples and catalog links.
- Record the #311 cutover source inventory and canonical destinations for pending ingestion; keep the optional refinement template configuration repository-owned.

## 0.4.0

- Move the complete private lifecycle package to `@a4s/issue-lifecycle`, with `issue-execution` and `repository-discovery` skills, retaining the shared breakdown, discovery and refinement implementations (#427).
- Migrate admission provenance, bootstrap, status, CLI/rebase paths, workspace/lockfile and CI consumers together; retain technical DAG, CLI and receipt identifiers.
- Follow the lifecycle bundle contract across package moves at the declared integration release base, and exercise candidate renders generated by the bootstrap shell independently of committed adoption.
- Preserve the adopted quality-free lifecycle from #561 and native triage/implementation job receipts.
- Isolate live recovery and gate-exclusion fixtures from the enclosing scheduler's retry-dispatch context, so native CLI retries retain their user-request semantics when acceptance runs inside a Dagu role job. Await the gate holder's native terminal run before fixture cleanup, including partial success after a continued gate failure.
- Path-migrate the committed v1 feature, PoC, discovery and planning renders while retaining their original bootstrap provenance stamps; document external temporary profiles for native candidate smoke.

## 0.3.119

- Merge the quality-free 0.3.118 lifecycle from main into `integration/v1`, preserving paginated merged-PR metadata (#493), terminal-snapshot observation (#522), and the v1 package identities.

## 0.3.118

- Publish each gated feature candidate through optional operator validation, push, PR and guarded auto-merge, then reconcile required CI and merge (#561).
- Retain native triage and implementation jobs and their receipts; remove the mandatory QA/reviewer checkpoint, quality evidence sealing and quality-only fixtures.
- Align waiting recovery, lifecycle documentation and sprint completion evidence with the local gate and optional adopted operator validation; match gate-selection fixtures to the package dependency graph.

## 0.3.117

- Allocate real Dagu test run identities through one shared per-execution fixture helper, including child runs and lifecycle lookups, so concurrent suites keep host-global control sockets separate (#542).

## 0.3.115

- Admit the owner session's literal inert-quality disposal completion only for a stored historical snapshot with no checkpoint cancellation route and a verified fail-closed QA/REVIEW binding; preserve normal structured verdict admission (#545).
- Document native failure at quality_admit, retained unpublished work and recovery under a fresh run ID.

## 0.3.114

- Declare cancellation-only `CANCEL=yes` completions on distributed feature, PoC and discovery checkpoints, routing to native failure or active-gate abort before successors, recovery and promotion (#290).
- Preserve native exit cleanup and unpublished candidates, suppress PoC failure publication on cancellation, and document new-snapshot compatibility and unresolved historical recovery.
- Admit literal cancellation-only implement/quality completions through OMP's quality guard only for same-repository waiting snapshots that declare and route cancellation; normal delivery evidence remains required.
- Exercise checkpoint cancellation against isolated pinned Dagu, real linked Git worktrees and an external-effect ledger.

## 0.3.112

- Run the explicit QA/reviewer join as authorized native role jobs, independently of the coordinator, and admit their actual emitting sessions through sealed job receipts (#514).
- Bind quality to the current repository/lane/candidate/capture iteration/attempt and registered role, retain effective models and fallback history, and enforce fresh distinct sessions and implementer-family exclusion before publication.
- Preserve immutable admission identity with appended runtime observations and validate typed verdicts and transcript artifacts at the quality boundary.

## 0.3.110

- Deliver later owner-session notices as asides at host step boundaries during a reserved autonomous turn, preserving FIFO order, one idle wake, session ownership and terminal delivery (#519).
- Drain queued idle batches on the host's asynchronous `agent_start`, with asynchronous-admission regressions and an isolated OMP 18.12.6 smoke confirming ten notices across two runs in one autonomous agent invocation.

## 0.3.109

- Run authorized feature triage and implementation/conflict resolution as Dagu command-owned native OMP jobs, retaining registered agents and complete role/model fallback routing (#513). Keep the existing coordinator-dispatched QA/reviewer human-task join, quality.json writer and quality admission operational; #514 owns wiring QA/reviewer role-job receipts and migrating quality templates/hooks.
- Persist canonical claims, executor identity, per-DAGU_HOME capacity, worktree exclusion and duplicate suppression in SQLite. Bind each native step retry to its fresh start timestamp, preserving failed/interrupted receipts; retain native session/model/fallback evidence and linked admission observations.
- Bind captured candidates to the admitted native implementer result digest/input HEAD for existing cross-family quality checks. Publish schemaVersion 1 receipts and QA/reviewer executor support for #514 and semantic-evidence consumer #517; retain operator validation.
- Remove the superseded coordinator triage-completion guard and its unreachable tests; document same-command-step recovery and exercise quality stage progression offline and in pinned Dagu.
- Preserve #543's triage contract in native role jobs: inject the shared decision schema, bind the exact job marker independently of agent name or criterion prose, and retain field/expected/observed diagnostics. The sealed current job receipt replaces coordinator-task lineage.
- Bind triage jobs to immutable admission HEAD so unrelated PRIMARY fast-forwards preserve active work and redelivery identity. Retain implement-completion guards for in-flight human-task snapshots and exercise their explicit historical form in live Dagu.

## 0.3.108

- Serialize the complete feature gate body per primary with an inherited kernel advisory lock, including human-task resumes, retries and reconciler BEHIND/DIRTY rebases, while retaining declared repository queue capacity (#537).
- Log waiting holder run/PID diagnostics and release exclusion with process/descendant descriptor lifetime, including failure, cancellation and holder death; validate Python 3/fcntl during adoption and cover native Dagu entry paths.

## 0.3.107

- Bind triage review tasks by DAG/run/generation/request marker across agent types, accept results only for the current request, inject one canonical decision schema, and report invalid bound output with field/expected/observed diagnostics.
- Verify native triage evidence by exact parent, complete marker, strictly fresh timestamp and final `poc=no`, while retaining selected agents' cross-family dispatch policy.
- Report primary and transcript namespace mismatches as expected/observed facts; document marker-based review and enforce distributed-agent schema identity.

## 0.3.106

- Diagnose rejected automatic checkpoint transitions after native stale-process repair and document same-run checkpoint recovery for feature, PoC, discovery and planning (#524).
- Cover stale-process recovery at PoC `decide`, including repeat verdict comments, PASS body-section appends, and operator-reviewed publication replay precautions (#524).

## 0.3.105

- Support native task batches containing QA/reviewer assignments for independent current quality requests, binding each assignment's verdict contract and model eligibility to its own run and effective implementer (#495).
- Validate every marked assignment before installing dispatch bindings; preserve exact markers, distinct names, request/candidate freshness and independent transcript-backed verdict admission. Unmarked tasks and shared batch context retain their native behavior.

## 0.3.104

- Align the distributed skill with the approved same-major-and-minor, patch-compatible admission contract for requested DAG and reconciler stamps, distinguishing exact package identity, source provenance, native-version checks and notice-only stale warnings while preserving immutable admission snapshots (#482).

## 0.3.103

- Share effective agent-directory resolution between activity and the primary-session guard, including named profiles and existing configuration-directory precedence (#356).
- Resolve exactly one coordinator parent across default and named-profile session roots before verifying its allocated triage-reviewer child; report consulted paths and match counts on rejection.
- Emit actionable parent-uniqueness failure markers for empty coordinator searches under Bash 3.2 nounset, while preserving named-profile verification and duplicate-parent rejection.

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
