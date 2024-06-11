# Lanes, deployment and coherent recovery

These are reviewed operating procedures, not evidence that a service, link,
branch protection or consumer adoption changed. The
[dated walkthrough](v1-walkthrough.md) records only the observations exercised
for #431. Source publication, private installation, initial lane adoption,
post-release v1 adoption/proof and temporary-lane retirement have distinct owners
and acceptance outcomes.

## Repository lanes and ownership

| Lane | Independent PRIMARY clone | Base branch | Declared queue |
| --- | --- | --- | --- |
| Main | `a4s` | `main` | `a4s` |

PRIMARY is a canonical independent clone: its Git dir equals its common Git dir.
Issue worktrees are linked below that clone's `.workspace/worktrees/issue-N`.
Start the coordinator in a clean PRIMARY on its declared base. Main is the only
active lane and owns its admitted issues and issue-numbered remote
branches/checkpoints. Keep one coordinating owner per canonical repo and
preserve the run's original owner. Cross-repository contact carries only its
explicit request and return channel.

Pass the persistent main-session `dagu_session_id` as `OMP_SESSION_ID` when
admitting work. Missing, malformed or duplicate owners fail before receipts,
cache/store mutation or enqueue. A handoff preserves run, candidate, iteration,
receipt and session ownership; any explicit transfer follows the execution skill.
Committed `.workspace/dagu/config.json` is the only consumer policy authority,
including base branch. Policy parameters are rejected; successors carry only
operational inputs and the original owner. Queue capacity is station-owned,
independent of semantic-job capacity and OMP's subagent semaphore.
The PRIMARY gate lock serializes the conflicting gate, not unrelated jobs.

The temporary v1 integration lane completed its release into main and was retired
under #438. Its final integration, run outcomes and preserved recovery evidence
are recorded below.

### Release controller versus candidate

The [artifact contract](../architecture/artifact-contract.md) is normative.
Only immutable tagged releases supply the engine. Each platform archive contains
one compiled `a4s`, identity, gate preload files and complete OMP assets. A
consumer commits `.workspace/dagu/config.json` with required `uses`:
`a4s@v0` follows a published moving major; `a4s@v0.6.1` pins an exact release
(example, not an availability claim). Branches, paths, URLs and ranges are rejected.

Root admission resolves that selection once, verifies the exact archive's SHA-256
before extraction and atomically publishes `$DAGU_HOME/cache/a4s/<version>/`.
The cached executable receives
`admit --artifact '<version>@<commit>#<digest>'`, checks its embedded identity
and verified cache metadata, and does not resolve `uses` or hand off again.
Snapshots use only their absolute cached `A4S_BIN` for every engine command.
Candidate worktrees never supply controller code.

Feature → PoC, PoC → feature and discovery → planning retain and verify the
parent receipt's artifact tuple even when child policy selects a newer release.
Missing, corrupt or unsupported parent artifacts fail closed. Child policy is
still independently read from consumer HEAD. Retain cache entries referenced by
any nonterminal/recoverable run, open role job or pinned station reconciler.
Incomplete reference discovery prevents removal; age alone never authorizes it.
Cache population is runtime state, not installation or station configuration.

The native role runtime remains operator-supplied. Set
`DAGU_OMP_ROLE_RUNTIME` to the absolute installed `@oh-my-pi/pi-coding-agent`
package root for both service and bootstrap. Dagu filters `OMP_ROLE_RUNTIME`;
a compiled `omp` executable is not a package root. Link the extracted release
root for the service user so native discovery finds `triage-reviewer` and `task`.
From PRIMARY with that environment, `a4s role-jobs detect` checks discovery
without launching a role. Changing service environment is an operator action.

For lane work, use the initial installed release executable, actual Dagu home
and persistent owner; it selects and hands off to the configured cached release:

```sh
cd "$PRIMARY"
a4s enqueue --run-id "<lane>-issue-<n>" feature -- \
  ISSUE="<n>" OMP_SESSION_ID="<persistent-owner-session>"
```

The CLI rejects policy overrides, including base branch, gate, validation and
queue capacity. PRIMARY resolves from `$DAGU_HOME/primaries/<lane>`, then
`A4S_PRIMARY`, then `$DAGU_HOME/a4s-primary`. It must be a canonical independent
clone. The resource guard protects the bound PRIMARY only when its config is
committed at HEAD; an identical-config unbound clone is not protected.


## Versioned source, configuration and runtime state

Git versions source and configuration. That is content written through a pull
request, or generated deterministically from a versioned revision and declared
inputs so that regenerating it yields identical bytes. Changes to it land through
a commit, such as a version bump or an adoption.

Runtime state is written by a running process and carries per-execution data:
run identifiers, timestamps, process IDs, attempt counters, or observed external
state such as PR heads and check results. It lives under `.git/dagu-feature/runs/`
or `$DAGU_HOME`. Bootstrap writes the consumer config file; it does not version
receipts, observations, generated snapshots or scheduler data.

Classify a file in three steps:

1. Identify its producer (a person through a pull request, a generator such as the
   bootstrap config-authoring step, or a running process such as a DAG step or observer) and
   the producer's declared inputs.
2. If a generator produces it, regenerate it twice at the same revision with
   identical declared inputs. Identical bytes make it configuration. A render that
   changes only because a declared input changed (bundle version, repository, queue)
   is still configuration. `.workspace/dagu/config.json` is that configuration.
   A generated per-run snapshot is runtime state.
3. A file whose content records an execution (run identifiers, timestamps, process
   IDs, attempt counters, or observed external state) is runtime state, regardless
   of format or how often it changed.

Hand-written test fixtures, and a pull-request document that quotes a finished
operation, stay source. A process-owned receipt (`receipt.json` with `admittedAt`,
`admissionPid`, `observerPid`, `dagRunId`, `finishedAt`), `ci-observation.json`,
`status.jsonl`, or `$DAGU_HOME/data/**` is runtime state. Move a tracked file in
that class to `.git/dagu-feature/runs/` or `$DAGU_HOME` and remove it from the
repository in the same change. `package.json`, `.workspace/dagu/config.json` and `.workspace/config/refine.json`
are configuration even though they are JSON.

## Identity and adoption

Source delivery is not station activation. Operator authority must identify the
target PRIMARY/lane, release version/commit/archive digest, Dagu home/endpoint,
plugin links, queue configuration, reconciler and repository settings.

1. **Close admission and drain.** Inventory all runs, including queued, waiting
   and recoverable runs, and role jobs. Cutover requires **zero nonterminal runs
   and zero open role jobs**. Never rewrite legacy receipts/snapshots or silently
   substitute a new engine for them. Resolve uncertain references before cutover.
2. **Install an initial release.** Obtain the exact platform
   `a4s-v<version>-<os>-<arch>.tar.gz` and matching `.sha256` from the tagged
   GitHub release, verify SHA-256 before extraction, then install the extracted
   root at an operator-owned stable location. Put that release's `a4s` on PATH
   for initial admission and load/link its whole root as the OMP plugin. Do not
   install a checkout or point the service at a source interpreter.
3. **Provision the station explicitly.** Keep `DAGU_OMP_ROLE_RUNTIME` and native
   OMP role definitions. Configure Dagu's loopback API, coordinator and named
   queues with operator-chosen `max_concurrency`. Preserve the canonical home
   and PRIMARY binding. Any service activation/restart is performed by the
   operator under the station's drained policy, never by a4s.
   `$DAGU_HOME/config.yaml` must explicitly contain `auth.mode: none` and
   `coordinator.enabled: true`; environment overrides alone do not satisfy the
   station contract. Bootstrap `detect` checks these leaves through `a4s queue`
   and makes an unauthenticated loopback GET to its own existing run-spec
   endpoint (`/api/v1/dag-runs/dagu-feature-bootstrap/<run>/spec`), the same route
   used to resolve feature admission snapshots. This needs no prior feature run.
   If the check fails, the station operator merges the required leaves while
   preserving unrelated config, then restarts Dagu and retries bootstrap.
4. **Author and commit consumer policy.** Bootstrap defaults `uses` to `a4s@v0`,
   preserves an existing selection on blank input, and accepts an exact release.
   Review `.workspace/dagu/config.json`, remove retired `queueConcurrency`, and
   commit changed policy before feature admission. Reader and config migrate
   together: old schema-1 readers reject the new `uses` field.
5. **Pin reconciliation.** Follow [the exact-release procedure below](#pin-the-station-reconciler-and-release-plugin).
   Bootstrap and `reconcile render` never write `$DAGU_HOME/dags/`. Retain the
   pinned cache entry until the operator deliberately replaces that pin.
6. **Remove obsolete deployment bindings.** Once no references remain, remove
   old installed source checkouts, executor launchers/plugin links and checkout
   entries in the service PATH. Preserve unrelated operator files and development
   checkouts. Do not retain compatibility aliases.
7. **Load and accept.** Restart OMP to load the release plugin. Retain identity,
   readiness, exact receipt/snapshot tuple and agreed live acceptance evidence
   before reopening admission. A source test is not proof of station cutover.

The adoption DAG is a source/operator asset, not an installed engine checkout.
Enqueue its reviewed file with the initial release executable explicitly selected:

```sh
dagu enqueue --run-id "bootstrap-<repo>-<id>" \
  "<reviewed-bootstrap-file>" -- \
  PRIMARY="$PRIMARY" A4S_BIN="<absolute-release-root>/a4s" \
  BASE_BRANCH="$BASE_BRANCH"
```

An empty `BASE_BRANCH` selects the GitHub default; an explicit branch must exist.
`detect` checks tools, canonical PRIMARY, role discovery and read-only readiness.
`config` obtains policy; `worktrees` ignores managed issue worktrees locally;
`write_config` authors and validates config; `readiness` checks the station.
The authorized `github` step can change merge settings and branch protection;
`confirm` rechecks them and policy/readiness. No step renders/installs DAG files,
copies an engine, modifies station configuration or activates services.

Inspect with the installed release:

```sh
a4s version
a4s queue "$PRIMARY/.workspace/dagu/config.json"
dagu history reconcile --format json --limit 5
```

Admission records config commit/digest separately from artifact identity and
supported/used contract versions, and enqueues exact immutable snapshot bytes.
A later release needs no consumer commit when moving-major policy stays the same;
already admitted runs and their successors stay on their original artifact.

### Pin the station reconciler and release plugin

These steps are the separately authorized operator cutover (#714), **not** a4s
side effects. Use the drained station policy above, its canonical `DAGU_HOME`,
the selected platform's verified extracted release root, and an exact published
`VERSION` (for example `0.7.0` only after that release has actually been published).
Never use `v0`, a checkout path or PATH as the scheduled executable selection.

The minimum dispatchable release is v0.7.0, which ships #713. Its capability is
identified by `a4s version` declaring `support.dispatch: "a4s-run/1"` (not by
a SemVer comparison). v0.6.0 predates that boundary and cannot dispatch runs after this
cutover. Confirm zero nonterminal pre-#713 runs and zero open role jobs before
installing either consumer. Historical receipts remain read-only; a missing
dispatch declaration is reported as unsupported, never repaired or substituted.

```sh
export DAGU_HOME="<canonical-station-home>"
RELEASE_ROOT="<absolute-verified-extracted-release-root>"
VERSION="<exact-published-X.Y.Z>"

# Cache only: verifies the tagged platform archive and embedded identity.
ARTIFACT="$("$RELEASE_ROOT/a4s" reconcile cache --release "a4s@v$VERSION")"
"$DAGU_HOME/cache/a4s/$VERSION/a4s" version

# Read-only rendering: output goes to an operator-owned staging file.
STAGED="$(mktemp)"
"$RELEASE_ROOT/a4s" reconcile render --artifact "$ARTIFACT" > "$STAGED"
dagu validate "$STAGED"
# Review both A4S_BIN/A4S_ARTIFACT bindings and the minute schedule.
# Only the operator installs the reviewed bytes:
install -m 0644 "$STAGED" "$DAGU_HOME/dags/reconcile.yaml"
rm "$STAGED"

# Link the entire verified release, not packages/issue-lifecycle in PRIMARY.
omp plugin link "$RELEASE_ROOT"
```

Before installing, preserve/resolve an existing operator DAG under station
policy. `reconcile cache` writes only the artifact cache, refuses nonexact refs,
and never repairs a conflicting final entry. `render` requires the verified
entry, rechecks retained archive, all extracted payloads and embedded identity,
and prints YAML only; it does not create `$DAGU_HOME/dags/`. The emitted schedule
is once per minute with overlap skipped. The operator confirms the existing
scheduler is enabled, or activates it under the drained service policy; a4s
does not activate/restart the service. An initial manual `dagu start` of the
installed file plus scheduled history demonstrates activation separately from
successful rendering.

For the service user's persistent OMP installation, replace the existing
`@a4s/issue-lifecycle` registration rather than registering a second copy. The
plugin manager/link must make
`~/.omp/plugins/node_modules/@a4s/issue-lifecycle` resolve to `RELEASE_ROOT`,
not PRIMARY's `packages/issue-lifecycle`. Update the corresponding
`~/.omp/plugins/omp-plugins.lock.json` managed entry to the release's actual
`package.json` version and release-directory source/link; do not retain the
old `0.5.25` checkout record or alter unrelated plugin entries. Use the installed
OMP plugin manager's link/replacement operation to maintain its lock schema.
Retain the selected version, commit, archive digest, resolved link and lock
entry as operator evidence. A new OMP process must load both extension entries,
agents and skills from that root; refresh alone is not module-load evidence.
The packaged extensions select adjacent `RELEASE_ROOT/a4s`, then each run's
receipt-bound cache for mutations.

Admission can reopen only after read-only readiness, manual/scheduled tick
history and plugin-load evidence agree with the selected station tuple.
Retain cache entries for all referenced runs/open role jobs and the reconciler.
A mixed-version station is supported when declared receipt/protocol/store
contracts agree: the reconciler's pin is never substituted for a run's tuple.
An unavailable/unsupported run logs
`reconcile-failure run=<id> status=1 cause=<diagnostic>`, is left untouched, and
does not prevent compatible runs from proceeding. Restore its exact verified
artifact or resolve that run explicitly; never rewrite its receipt or silently
upgrade it.



## Operator-owned station configuration and readiness

The station operator owns Dagu's configuration, capacity, service unit and
activation. a4s never writes `$DAGU_HOME/config.yaml`, `base.yaml`, launchd or
systemd units, and never restarts Dagu.

Provide an unauthenticated loopback API, queues/coordinator enabled, and the
consumer lane's named global queue in station config. Its `max_concurrency` is
chosen by the operator, not committed consumer config. Ensure the service's own
PATH resolves `bash`, `git`, `gh`, `jq`, `node`, `omp`, and `dagu`. Engine helpers
use the snapshot's absolute `A4S_BIN`; Bun and Python are not release runtime dependencies.
Use the service's actual home and endpoint for read-only diagnostics:

```sh
a4s queue "$PRIMARY/.workspace/dagu/config.json"
# Before initial adoption:
a4s queue --lane a4s
```

Exit 1 reports missing/invalid lane queues in config or the running API,
endpoint/auth errors, inactive scheduler or unreadable/incomplete service
environment. Linux reads the running scheduler's `/proc` environment; macOS
reads the running launchd service's configured environment. The check performs
only reads and HTTP GETs, creates no home or probe DAGs, and does not enqueue
or activate anything. Bootstrap invokes it before adoption and confirmation.
When readiness fails, request station-operator correction; bootstrap cannot
repair or reload station configuration. Operator-led service changes must
preserve active/waiting runs and follow that station's safe activation policy.

History retention is operator policy in `$DAGU_HOME/base.yaml`; the retained
source example uses `hist_retention_days: 30`. The release's reconcile root
declares `hist_retention_runs: 1440`, about one day at one tick per minute.
The operator installs its pinned snapshot; bootstrap does not. The first tick
applies that count while retaining active/non-final roots. Retain durable
acceptance evidence outside both cleanup windows. Record first-tick duration,
skipped ticks and history bytes when accepting the operator's new reconciler.

## Active runs and recovery

Read exact DAG/run status and approval iteration before any human-task action.
The designated reconciler owns CI/merge observation and `await_ci`/`await_merge`
transitions. Those two checkpoints remain child runs. Other waiting checkpoints
are observed in the root tick, with one paginated issue-state read per
repository. Retain pending runs and candidate SHA rather than duplicating polling.
A dirty/wrong-branch PRIMARY remains waiting while queue capacity is released.
Restore it clean on its declared base while preserving operator changes, then
push back the exact availability checkpoint using its observed iteration (for
example `start_primary_unavailable`, `close_primary_unavailable`, or PoC
`base_primary_unavailable`). Cleaning alone does not resume a waiting task.

A local gate failure at `recover_gate` is automatic: the wait handler reads the
current run-wide push-back iteration and pushes that checkpoint back through
`implement_budget` to implementation in the same worktree, with SHA-bound gate
failure evidence. Repeated failures exhaust the configured cycle, fingerprint
or elapsed-time budget and wait at `escalation` for an owner decision. This is
the unattended repair loop's stop, not an unbounded retry. Infrastructure
checkpoints `recover_start_gate` and `recover_push` remain manual: repair lock,
network or other infrastructure causes, then push back the exact checkpoint
with its observed iteration to retry its command, not implementation.

Inspect `<git-dir>/dagu-feature/runs/<run>/` receipts, candidate, tested SHA,
resource owner and cleanup proof before retry or transfer. Terminal recovery can
reuse retained resources through a new suffixed run under the execution skill's
ownership-transfer contract. Interrupted semantic jobs retain their native
receipt/transcript; inspect side effects before retrying `triage` or `implement`.
A stale lock is diagnostic evidence requiring operator inspection, not permission
to discard a live owner. For a durable checkpoint in a separate clean recovery
checkout, the skill uses:

```sh
git fetch origin refs/dagu/checkpoints/issue-N
git branch dagu/issue-N FETCH_HEAD
```

Cleanup verifies candidate integration (including exact squash proof), canonical
ownership, clean resources and base freshness before worktree/ref removal. Dirty
resources, ambiguous GitHub responses and unproved integration retain diagnostics.

### CodeQL merge gate and correction

This repository runs CodeQL weekly (`.github/workflows/codeql.yml`, Mondays
06:00 UTC, plus manual dispatch) on `main` only. Pull requests and pushes do not
run CodeQL, no ruleset gates merges on it, and the adopted `CODE_SCANNING` is
`off`: the lifecycle neither observes nor waits for CodeQL. Weekly findings are
triaged from the code-scanning alert list. A consumer that keeps per-PR
enforcement adopts `required` with a matching `code_scanning` ruleset; the rest of
this section describes that mode. Repository enforcement and controller adoption
are separate operations requiring their respective authorization.

After PR publication, `code_scanning` records `codeql-policy.json` and
`codeql-observation.json` under `<git-dir>/dagu-feature/runs/<run>/`. Evidence
binds the candidate head SHA to the current `CodeQL` check and open alerts on
`refs/pull/<PR>/head`; a successful check alone is insufficient. Threshold
findings retain alert number, rule, severity, path, line, message and URL.
Pending analysis releases the repository queue through the native waits;
stale-head observations require fresh observation of the current head.

A ruleset `BLOCKED` merge state with current-head threshold findings is
`CODE_FAIL`. The scheduled reconciler persists the SHA-bound structured
findings in `ci-return.json` and pushes `await_ci` back through
`implement_budget` to implementation using the observed iteration. It disables
any existing auto-merge request before the return. Implementation reads that
diagnostic as untrusted data, corrects the genuine defect and retains the same
run, branch and PR through normal capture, gate and push.

The corrected head must earn fresh local gate evidence, CodeQL analysis without
threshold findings and successful required `validate` before the reconciler
enables guarded squash auto-merge. The reconciler owns `await_ci`, `await_merge`
and merge observation; `authorize_ci` repeats CodeQL authorization for the
published candidate before `close_gate` verifies integration and cleanup.
Permission failures or unsuccessful analysis without proven threshold findings
remain diagnosed `BLOCKED`, preserving the wait for its owner.

Genuine defects are fixed. A justified false positive or test-only finding
requires an explicit recorded reason and an authorized disposition before
dismissal; test-only location alone does not authorize dismissal.

### Rollback

Obtain rollback authority for the same lanes and shared reconciler. Close
admission and establish zero nonterminal runs and zero open role jobs before
changing engines. Restore the approved release/plugin root, committed config,
verified artifact cache tuple, pinned reconciler, Dagu binary/home/config and
service environment as a coherent set. Never overwrite a conflicting cache entry
or rewrite receipts to disguise an upgrade. Any necessary service activation
belongs to the operator. Restart OMP, retain readiness and agreed admission/live
evidence, then reopen. Restoring a directory or displayed version is not recovery.

## Post-release proof and temporary-lane retirement

The release ([#435](https://github.com/pablontiv/a4s/issues/435)), local adoption
([#436](https://github.com/pablontiv/a4s/issues/436)) and main-owned post-release
proof ([#437](https://github.com/pablontiv/a4s/issues/437), run
`a4s-issue-605-r1`, PR #611) completed before the separately authorized retirement
in [#438](https://github.com/pablontiv/a4s/issues/438).

The temporary `a4s-v1` lane is retired: its `integration/v1` protection and remote
branch, clean linked worktree and independent PRIMARY clone were removed.
Its final branch tree matched the v1 release merge `cacf718` on main. All inventoried
v1-owned runs were terminal; their immutable receipts, isolated-controller
history, six local branches (including the operator-owned #506 branch) and
original protection/configuration were preserved under
`<DAGU_HOME>/backups/a4s-438/`. The final inventory and command evidence are in #438.

The review requested a repo-owned retirement operation. #383 and #415 remain
open, and the tooling then in use did not remove queues, so the
operator explicitly authorized direct retirement of these exact targets.
Only the `a4s-v1` queue entry was removed from station `config.yaml`; every other
byte was retained. Active-lane derived configuration was unchanged. The shared
scheduler remained running, and the unused queue removal takes effect at the
next drained restart. The station base and template contain no v1 queue entry.

Read-only health and DAG-run API queries, `dagu status feature --run-id
a4s-issue-605-r1`, reconciler history and the clean main PRIMARY were exercised
after retirement. Main's queue/service, shared reconciler, links, historical run
store and unrelated resources retain their existing ownership.

## Published-clone retirement

The unused independent sibling clone `<harness>/a4s-published` was retired on
2026-10-23 under [#625](https://github.com/pablontiv/a4s/issues/625), following
main-only ownership in #612. The
[target-specific operator authorization](https://github.com/pablontiv/a4s/issues/625#issuecomment-6375584111)
covered only that clone. The [retirement evidence](retirement-625.json) retains
the exact targeted commands, exit codes, outputs and reference-search tool calls
with portable paths. `<harness>` denotes the parent directory of `<primary>`.

Immediately before removal the clone was on `main` at
`eb90e4341f06c56f8d91571fb1d00123eb94619f`, with a clean tree, no stashes, no
unmerged local or remote branches and only its independent main worktree.
Its revision was integrated into primary main. `lsof -nP +D` returned exit 1
with empty stdout and stderr, establishing the required open-file check.
The authorized operation was `rm -rf -- <harness>/a4s-published` (exit 0);
both subsequent existence and symlink checks established removal.

The reference inventory covered installed DAGs and native snapshots, user/system
LaunchAgents, station and repository scripts, Orca registrations, shell/runtime
configuration and operator documentation. No dependency on the clone was found.
One broad snapshot search timed out; the narrower snapshot and executor-script
searches completed, including native `dag.json` records. The existing scripts,
operator wiki, installed DAGs, services, configuration and Orca registrations
were intentionally unchanged. This section and the evidence file are historical
retirement records, not runtime dependencies.

After removal, primary remained clean on `main` at
`4ef614d7b87a162c95c585da2c3cb85c5ea82986`. All 49 preexisting registered
worktrees remained registered and each resolved its HEAD and common Git
directory through the primary. The then-installed Dagu remained healthy and its LaunchAgent
running. The 29 inventoried running/waiting runs, their owners and recovery
resources were preserved. These are targeted station-retirement observations;
the lifecycle full gate and operator validation remain separate decisions.
