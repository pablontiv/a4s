# Issue lifecycle architecture

[`@a4s/issue-lifecycle`](../../packages/issue-lifecycle/README.md) is a private
OMP package. Its manifest owns `BUNDLE_NAME`, `BUNDLE_VERSION`
and the exact Dagu pin (`daguFeature.dagu`). The package distributes two reloadable extension
entries, two specialized agents, the [seven workflow skills](catalog.md#lifecycle-skills),
and `dagu-feature-bundle`, `dagu-feature-prioritize`, `dagu-feature-protect`,
`dagu-role-jobs` and `dagu-station-install`. Technical DAG names remain `feature`, `poc`, `discovery`,
`planning` and `reconcile`; `planning.yaml` is the breakdown backend.

## Delivery and provenance

Distributed templates live together with `SKILL.md` under
`packages/issue-lifecycle/skills/issue-execution/`. The consumer versions one
answers file at `.workspace/dagu/answers.json`. Its schema version is independent
of the package version. Admission reads that committed file and materializes the
requested DAG from the station's installed templates. The scheduled reconciler is
installed separately at `$DAGU_HOME/dags/reconcile.yaml`. A package release that
does not change answers requires no consumer commit. Feature and PoC `PRIMARY`
in the materialized DAG is the host reference `"${A4S_PRIMARY}"`. Admission
resolves it from `$DAGU_HOME/primaries/<lane>`, then `A4S_PRIMARY`, then
`$DAGU_HOME/a4s-primary`, and the per-run snapshot records that absolute checkout.
Existing runs retain their admitted snapshots and receipt identities.

Bootstrap requires a clean source package, fetches its origin, resolves
`origin/HEAD`, verifies source HEAD ancestry and exact Dagu output, and checks
that PRIMARY is an independent clone rather than a linked worktree. It writes
`.workspace/dagu/answers.json` in PRIMARY. Its `reconcile` step installs the
user-level reconciler from the installed template; `github` can change repository
merge settings and branch protection. These are authorized deployment actions,
not read-only smoke commands.

### Compatibility is more than a version display

Status notices still classify the generated snapshot's `dagu-feature-bundle`
label by version distance (equal major and minor, patch allowed). That display
is not admission. Admission materializes the installed template and compares the
inferred `triage`, `implement` and `publication` protocol ids with the contracts
the loaded extension serves. The inspection CLI reports the committed answers
file, queue compatibility and exact runtime output; it does not prove enqueue.

[`src/admission.ts`](../../packages/issue-lifecycle/src/admission.ts) reads the
answers file from the consumer's committed revision, rejects unknown fields and
run-time policy overrides, resolves PRIMARY, and writes the immutable per-run
snapshot and receipt. The receipt records the answers digest, package
version/commit, template identity, Dagu runtime and generated DAG digest. A
corrupt installed template fails before run creation and names the protocol plus
the bundle version that serves it. Installed package version equals the loaded
version exactly; a supplied loaded-extension digest must match current source
bytes; Dagu output equals the manifest pin exactly. A missing station reconciler
does not block admission of a feature, PoC, discovery or planning run.
The feature/PoC first steps independently fetch/fast-forward clean PRIMARY and
require its HEAD and manifest version to equal the selected remote base exactly.

A manifest name change requires a fresh install of the package, matching
reconciler and CLI binding, and a new OMP process. Publication does not
transform existing deployed identity. See
[deployment](../operations/deployment.md#identity-and-adoption).

An immutable `receipt.json` (0600) in `<git-dir>/dagu-feature/runs/<run>/` captures
`sourceVersion`, `deploymentFingerprint`, source/render relationships, digests,
DAG bytes, parameters, primary/session and runtime. CLI enqueue submits admitted
snapshot bytes. Linked observations append resolved facts without replacing the
initial fingerprint. Unexposed runtime/model/external facts remain explicitly
pending, rather than being inferred from the package version.

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

The gate has a PRIMARY-wide advisory `fcntl` lock held across its Bash descendants.
Python 3 with `fcntl` is a service prerequisite. Unrelated lifecycle steps can
advance under their queue capacity. Optional operator validation remains a
repository adoption decision; a4s currently adopts an empty procedure.

An explicit operator decision can protect one candidate's integration order.
`dagu-feature-protect` stores that run, issue, changed paths, decision and
provenance in Git metadata. Gate admission, push and auto-merge of another run
wait only when their changed paths intersect; disjoint candidates proceed. The
record releases at `close_gate`, terminal exit or operator release, and the
owning session's `[DAGU STATE]` shows the protection and the runs it holds.
This is independent of `dagu-feature-prioritize`, which reorders queued tickets.

### Station-wide heavy-test slot

One POSIX `fcntl` slot at `$DAGU_HOME/a4s/heavy-slot.lock` serializes feature
gate bodies across independent clones and worktrees, plus root `npm test` and
`@a4s/issue-lifecycle`'s `test`/`test:live` scripts launched outside Dagu.
All station sessions must use the service's canonical `DAGU_HOME` (default
`~/.dagu`); the path does not depend on a repository's Git directory.
The shared `bin/heavy-slot.py` helper prints waiting diagnostics with the holder,
retains an inheritable descriptor through the command, and exports
`A4S_HEAVY_SLOT_HELD=1` so nested test scripts do not reacquire the slot.
The marker is inherited ownership, not an operator bypass.

Success, failure, cancellation and SIGKILL release kernel ownership when all
inheriting descriptors close; surviving descendants keep exclusion. The stable
lock inode is not removed. Single-file `tsx --test` runs and light-workspace
tests remain unslotted. Integration protection uses a separate short-lived
per-repository admission lock and releases the station slot while a gate waits
on protection. Dagu queue capacity stays `a4s=8` on main, foreign queues are
unchanged, and unrelated lifecycle steps proceed. Deployment acceptance still
requires operator-observed primary/authorized-clone full-gate windows and an
agent-session root test waiting behind a gate.


## Native semantic jobs and capacity

`dagu-role-jobs stage triage|implement` executes authorized obligations using
native OMP definitions, prompts, role model arrays and fallback routing. It
requires Bun and the installed OMP runtime (`OMP_ROLE_RUNTIME` can select its
root). Schema version 1 job/result/routing/assignment/native transcript artifacts
bind canonical repo, worktree, lane, DAG, run, stage, semantic role, SHA, iteration
and attempt. `candidate.json.implementation` binds the implementer's result to
the candidate. Native triage verification binds the exact authorized job marker,
receipt and structured schema, not an agent's display name.

SQLite at `$DAGU_HOME/role-jobs.sqlite` serializes claims and recovery. The persisted
policy is the capacity authority for active sessions in this boundary per
canonical Dagu home. `A4S_ROLE_JOB_CAPACITY` (default 4) seeds it only on first
creation. Subsequent dispatches use the policy and diagnose conflicting environment
values with `ROLE_JOB_CAPACITY`. With the service's actual `DAGU_HOME`, the operator
runs `dagu-role-jobs capacity <positive-integer>` to change it. One SQLite
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
uses REST/SSE for progress, and the pinned Dagu runtime's cursor event ledger for durable
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
active feature/PoC ownership. Primary resources stay protected. It does not
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
