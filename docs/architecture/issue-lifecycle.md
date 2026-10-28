# Issue lifecycle architecture

[`@a4s/issue-lifecycle`](../../packages/issue-lifecycle/README.md) is a private
OMP package. Its manifest owns `BUNDLE_NAME` and `BUNDLE_VERSION`.
The runtime requires Dagu 2.23.0 or newer without an exact version pin; admission
records the observed `dagu version` output. The package distributes two reloadable extension
entries, two specialized agents, the [seven workflow skills](catalog.md#lifecycle-skills),
and the compiled `a4s` engine. Technical DAG names remain `feature`, `poc`, `discovery`,
`planning` and `reconcile`; `planning.yaml` is the breakdown backend.
Spike #692 compared Harness² with these loops and discarded adoption; see
[Harness² vs issue-lifecycle](harness2-issue-lifecycle.md).

## Delivery and provenance

The [artifact contract](artifact-contract.md) is normative. Tag releases publish
one compiled `a4s` executable per platform with identity, real Node gate preload
files, extension closure, agents and skills. The release engine never executes
an installed source checkout.

The consumer commits `.workspace/dagu/config.json` with `schemaVersion: 1` and
required `uses: "a4s@v0"` (moving major) or `"a4s@v0.6.1"` (exact example).
Admission reads config bytes at consumer HEAD; unknown fields, uncommitted policy,
branches, paths, URLs and ranges are rejected. Queue capacity is not consumer policy.

A root admission resolves `uses` once to `(version, commit, archive digest)`,
verifies the archive before extraction, validates its identity/assets and
atomically publishes `$DAGU_HOME/cache/a4s/<version>/`. Existing entries must pass
integrity validation and cannot be overwritten or silently repaired. Admission
hands off to that entry's executable with
`admit --artifact '<version>@<commit>#<digest>'`. The selected engine verifies
the tuple without another resolution/handoff, materializes its own templates
and binds `A4S_BIN` to the cached absolute executable in the immutable snapshot.

Feature → PoC, PoC → feature and discovery → planning verify and inherit the
parent receipt's tuple. A changed child `uses` does not upgrade the successor.
Each child independently validates committed policy; missing/invalid parent
artifacts fail closed rather than falling back to a checkout or another release.
Cache entries remain retained for all nonterminal/recoverable runs and open role
jobs; the pinned station reconciler also retains its entry.

Bootstrap checks the independent canonical PRIMARY, tools, native role discovery
and station readiness, then authors consumer config (default `uses: a4s@v0`).
Its authorized GitHub step may change merge settings and branch protection.
It neither renders/installs DAGs nor installs an engine or shared reconciler.
The operator separately provisions the pinned reconciler and station settings.
a4s never writes `$DAGU_HOME/config.yaml`, `base.yaml` or service units and never
restarts Dagu. `a4s queue <config>` performs only reads and HTTP GETs.

### Compatibility is more than a version display

Explicit supported dispatch (`a4s-run/1`), receipt-schema, checkpoint-protocol and
role-job-store versions are declared by both the executable and `identity.json`. Admission
requires supported contracts, not a SemVer-distance guess. Status version-distance
labels remain presentation only, not authorization.

The scheduled reconciler has an independent exact artifact pin. Its read-only
`reconcile render --artifact '<version>@<commit>#<digest>'` interface verifies
the cache exactly as admission does and prints that artifact's DAG with absolute
`A4S_BIN` and tuple binding. `reconcile cache --release a4s@vX.Y.Z` populates a
missing exact release using the normal verification path. Neither installs DAGs
or changes station configuration; installation/scheduling are operator actions.

Station-wide listing and scheduling use the pinned binary. Stale recovery,
per-run classification/CI observations/no-progress tracking, transition shell
logic, escalation, integration protection, successors and semantic role jobs
execute through `a4s run --primary <primary> --run <id> -- <action>`. That boundary
requires dispatch protocol `a4s-run/1` and checks declared config/receipt/protocol/
job-store contracts, canonical receipt location and runtime home,
archive/metadata/payload integrity, and the
receipt/cache/embedded identity tuple before invoking the cached executable.
The selected engine rechecks its tuple and executable location; its own shipped
template supplies the per-run reconcile implementation.

The release archive is also the complete OMP plugin root. Its manifest points to
shipped extension entries; extensions select adjacent `a4s` for admission and
station work, then receipt-bound artifacts for run mutations. Tool triage,
protection, role dispatch and HUD receipt appends cannot use plugin-version
equality or its own implementation to mutate another release's run. Read-only HUD
rows may display unsupported receipts with a diagnostic. Mutation rejection is
explicit (`A4S_RUN_UNSUPPORTED`); ticks emit the stable
`reconcile-failure run=<id> status=1 cause=<diagnostic>` without touching the run
and continue compatible peers. Missing artifacts never trigger an implicit
upgrade, repair, receipt migration or station change.


[`src/admission.ts`](../../packages/issue-lifecycle/src/admission.ts) validates
exactly one persistent owner session before cache writes, receipts, enqueue or
role-job-store mutation. All policy, including base branch and gate, comes from
committed config; Dagu parameters contain operational inputs only. PRIMARY
resolves from `$DAGU_HOME/primaries/<lane>`, then `A4S_PRIMARY`, then
`$DAGU_HOME/a4s-primary`; the snapshot records the canonical independent clone.

The immutable receipt records artifact version/commit/archive digest, supported
and actually used contracts, consumer config commit/digest, exact template and
snapshot bytes, owner and observed Dagu runtime as distinct facts. The enqueue
path submits those exact admitted bytes. Linked observations append newly resolved
facts without replacing the initial fingerprint. Unobserved runtime/model facts
remain explicitly pending.

An engine upgrade does not rewrite existing snapshots or receipts. Operator
cutover requires zero nonterminal runs and zero open role jobs; see
[deployment](../operations/deployment.md#identity-and-adoption). Source publication,
release availability, plugin loading and station activation are separate facts.

## Candidate state and publication

The feature path is `implement → gate → push → pr → auto_merge → await_ci → await_merge`,
with an optional adoption-fixed operator `validation` procedure before `push`.
Independent triage and plan review retain their own contracts. A passing local
gate establishes the candidate SHA; publication and CI/merge remain separate.

The native implementer supplies files, `SUMMARY`, conventional `MESSAGE` and its
`IMPLEMENTER` role-job ID. Dagu validates canonical PRIMARY/worktree, owner,
branch and symlink boundaries, then captures one commit through a private index.
`candidate.json`, `diff.patch`, base and historical SHA evidence live in the
run directory. Correction/rebase replaces the candidate and requires fresh gate
evidence. `checkpoint_push` leases `refs/dagu/checkpoints/issue-N`; publication
uses the tested SHA and branch lease. PR creation/reuse and guarded auto-merge
bind that same head. The scheduled reconciler observes required CI and merge at
the current head/approval iteration, preserves pending waits, returns code failure
to implementation and BEHIND/DIRTY to rebase. `await_ci` and `await_merge` stay
on child runs. Other waiting checkpoints are observed in the root tick.

The gate has a PRIMARY-wide kernel advisory lock held across its Bash descendants.
The release engine uses native flock; Python's `fcntl` is a Node/tsx development
fallback only. Unrelated lifecycle steps can advance under their queue capacity.
Optional operator validation remains a repository adoption decision; a4s
currently adopts an empty procedure.

An explicit operator decision can protect one candidate's integration order.
`a4s protect` stores that run, issue, changed paths, decision and
provenance in Git metadata. Gate admission, push and auto-merge of another run
wait only when their changed paths intersect; disjoint candidates proceed. The
record releases at `close_gate`, terminal exit or operator release, and the
owning session's `[DAGU STATE]` shows the protection and the runs it holds.
This is independent of `a4s prioritize`, which reorders queued tickets.

### Station-wide heavy-test slot

One POSIX `fcntl` slot at `$DAGU_HOME/a4s/heavy-slot.lock` serializes feature
gate bodies across independent clones and worktrees, plus root `npm test` and
`@a4s/issue-lifecycle`'s `test`/`test:live` scripts launched outside Dagu.
All station sessions must use the service's canonical `DAGU_HOME` (default
`~/.dagu`); the path does not depend on a repository's Git directory.
The release engine's `a4s heavy-slot` retains an inheritable descriptor through
the command and exports `A4S_HEAVY_SLOT_HELD=1` so nested test scripts do not
reacquire the slot. Source npm scripts retain `bin/heavy-slot.py` for Node
development. The marker is inherited ownership, not an operator bypass.

Success, failure, cancellation and SIGKILL release kernel ownership when all
inheriting descriptors close; surviving descendants keep exclusion. The stable
lock inode is not removed. Single-file `tsx --test` runs and light-workspace
tests remain unslotted. Integration protection uses a separate short-lived
per-repository admission lock and releases the station slot while a gate waits
on protection. Dagu queue capacity is station-operator configuration, unrelated
to consumer config; unrelated lifecycle steps proceed. Deployment acceptance still
requires operator-observed primary/authorized-clone full-gate windows and an
agent-session root test waiting behind a gate.


## Native semantic jobs and capacity

`a4s role-jobs stage triage|implement` executes authorized obligations using
native OMP definitions, prompts, role model arrays and fallback routing. It
requires Bun and an explicit installed OMP package root in the Dagu service's
`DAGU_OMP_ROLE_RUNTIME`. Dagu 2.24.0 preserves `DAGU_*` environment variables but
filters the former `OMP_ROLE_RUNTIME`. Runtime resolution validates that exact
package and its native source modules; it never walks PATH or falls back from an
invalid selection, so a compiled `omp` cannot accidentally select another runtime.
Bootstrap's `a4s role-jobs detect` shares native discovery with role execution
and requires both `triage-reviewer` and `task` from PRIMARY. The lifecycle package
must be linked for the service user, not only loaded in the coordinator session.
Detection reports the root and agent sources without launching a session; errors
name the attempted root or missing agent and the required environment/link action.
Schema version 1 job/result/routing/assignment/native transcript artifacts
bind canonical repo, worktree, lane, DAG, run, stage, semantic role, SHA, iteration
and attempt. `candidate.json.implementation` binds the implementer's result to
the candidate. Native triage verification binds the exact authorized job marker,
receipt and structured schema, not an agent's display name.

SQLite at `$DAGU_HOME/role-jobs.sqlite` serializes claims and recovery. The persisted
policy is the capacity authority for active sessions in this boundary per
canonical Dagu home. `A4S_ROLE_JOB_CAPACITY` (default 4) seeds it only on first
creation. Subsequent dispatches use the policy and diagnose conflicting environment
values with `ROLE_JOB_CAPACITY`. With the service's actual `DAGU_HOME`, the operator
runs `a4s role-jobs capacity <positive-integer>` to change it. One SQLite
transaction updates the policy and records previous capacity, new capacity and
time in `capacity_changes`; JSON output exposes the same change. Every claim reads
the current policy: increases admit waiting claims immediately, while decreases
preserve active jobs and block new claims until active count falls below capacity.
The operator restores the original value through the same command and retains
both changes plus conflicting-environment dispatch evidence after deployment.
Dagu queues, this store and OMP/provider semaphores are independent limits.
Mutating roles exclude the affected worktree. Live duplicate jobs reuse
execution/results; missing owners become `interrupted`, retaining evidence.
Retry the same native step after inspecting effects; its new `startedAt`
identifies a new attempt.

## Observation, notifications and boundaries

The status extension resolves the repository from origin (including worktrees),
uses REST/SSE for progress, and Dagu's cursor event ledger for durable
human-task/success notifications. It discovers the last 48 hours with workspace
labels. `dagu_session_id` returns the persistent main-session owner; pass it as
`OMP_SESSION_ID`. Notifications target only that session and work headlessly.
Idle FIFO reservations coalesce autonomous wakeups; active turns receive ordered
asides. Restart establishes a new silent baseline. A stopped owner cannot receive
notifications; two processes with the same owner ID can both wake.

`/workflows` toggles the widget; `expand`, `collapse`, `hide` and `show` set its
process-local presentation. Expanded output is bounded by OMP's widget line cap.
REST/SSE failures retain known runs and back off from 1 to 30 seconds. Command
activity comes from a bounded log tail; PoC human-task activity comes from a
bounded owning transcript tail. Input is sanitized before display.

The OMP resource guard intercepts literal destructive Bash calls and checks
active feature/PoC ownership. An idle PRIMARY is also protected when it holds
`.workspace/dagu/config.json` committed at `HEAD` and its canonical path matches
the host PRIMARY resolver, using the committed `lane` for the workspace binding.
The resolver checks `$DAGU_HOME/primaries/<lane>`, `A4S_PRIMARY`, then
`$DAGU_HOME/a4s-primary`. Rendered DAGs do not establish adoption; identical
committed policy in an unbound clone does not protect it. The guard does not
sandbox shell expansion, external scripts, dynamic commands or other tools.
Dagu's private-index commit, gate lock and resource records are cooperative
contracts: TUI access to Git and the Dagu store makes the boundary advisory.
Unauthenticated local Dagu HTTP/human-task interfaces record an attributed
decision, not cryptographic operator identity or proof a smoke ran.

Verified cleanup requires canonical resources, exact ownership and integration
of the proved candidate (including verified squash identity). Dirty/ambiguous
resources are retained with diagnostics. Run `resource.json`, `tested-sha`,
`cleanup-head`, `cleanup-proof.json`, `cleanup-phase` and `cleanup-diagnostic`
artifacts support repeatable recovery; details are in
[operations](../operations/deployment.md#active-runs-and-recovery) and the
[execution skill](../../packages/issue-lifecycle/skills/issue-execution/SKILL.md).
