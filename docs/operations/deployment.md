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
admitting work. A handoff preserves run, candidate, iteration, receipt and
session ownership; any explicit transfer follows the execution skill. Queue
capacity, semantic-job capacity and OMP's subagent semaphore are independent.
The PRIMARY gate lock serializes the conflicting gate, not unrelated jobs.

The temporary v1 integration lane completed its release into main and was retired
under #438. Its final integration, run outcomes and preserved recovery evidence
are recorded below.

### Stable controller versus candidate

The main lane uses `@a4s/issue-lifecycle@0.5.4` for its adopted renders and
controller, and the shared scheduled reconciler uses the 0.5.4 installation.
Main adopted this identity through `bootstrap-a4s-v0-5-4`.

Runs admitted under pre-0.4 `@a4s/omp-dagu` receipts continue through executors
pinned to each receipt's exact source commit. The station role-job launcher
selects the receipt-pinned executor and fails when that executor is missing.

Inspect each run with its identity-matched controller; report incompatibility
as deployment state rather than changing a stamp.
Scheduled reconciliation is a shared resource: replacing it affects other lanes
and active runs. A shared scheduler's actual home/config may differ from an
unset shell's defaults. Capture its service environment before drawing conclusions.

The tree declares queues; it does not establish the deployed scheduler's effective
concurrency or enforce every direct CLI/REST bypass. #335's revised actual-queue
guard and lane mapping work must be assessed against delivered code and separate
live evidence. #383's concurrency/restart PoC is not evidence that its acceptance
value is installed. TUI/Git/Dagu-store access keeps these controls advisory,
not process or OS isolation.

For already adopted lane work, use the installed controller's **real source
path**, selected Dagu home and assigned issue/session:

```sh
cd "$PRIMARY"
node "$CONTROLLER_CLI" enqueue \
  --run-id "<lane>-issue-<n>" .workspace/dagu/dags/feature.yaml -- \
  ISSUE="<n>" OMP_SESSION_ID="<persistent-owner-session>"
```

`CONTROLLER_CLI` is the identity-matched `bin/dagu-feature-bundle.ts` in a durable
source checkout. Node >=22.19 supports direct TypeScript here; use the real
source path because Node rejects stripping TypeScript under `node_modules`.
The admitted feature/PoC policy fixes PRIMARY, BRANCH, GATE, REBASE_RESOLVER,
REQUIRED_CHECK and blocker-reporting policy; the CLI rejects overrides.

## Identity and adoption

Before any consequential change, obtain explicit authority for the target
PRIMARY/lane, source SHA/package version, Dagu binary/version, scheduler home and
URL, links, service hooks, reconciler replacement and repository settings. Record
current stamps, adoption trailers, installed source/CLI/extension digests, active
runs, queue configuration and pending human tasks. Preserve a coherent recovery
set rather than only a package directory.

1. **Source publication:** merge tested package source and its version/changelog
   where required. Template/skill changes require a version above the merge base;
   the release guard follows the manifest across moves. Publication alone changes
   neither installed links nor adopted renders.
2. **Private installation:** choose durable pinned source, install dependencies,
   verify official Dagu 2.20.1 against upstream release checksums and exact version
   output, and review operator-owned links/PATH/config. The official asset naming
   is `dagu_2.20.1_<os>_<arch>.tar.gz`; CI validates upstream `checksums.txt` before
   extraction. The maintained station installer checks the same manifest pin.
3. **Initial stable-controller lane adoption:** preserve the approved controller
   and shared reconciler while adopting the lane's independent PRIMARY/base/queue.
   Review lane-specific rendered values and actual evidence independently of v1
   package publication. Existing initial adoption does not prove new v1 identity.
4. **Post-release v1 adoption:** from clean, approved source whose HEAD is an
   ancestor of its fetched `origin/HEAD`, bootstrap with explicit canonical PRIMARY
   and SKILL_DIR. Normal GitHub default remains main. An unmerged integration/v1
   candidate needs an approved isolated source/controller origin; changing an
   isolated bare remote's default is proof setup, not production adoption.
5. **Consumer delivery:** inspect bootstrap `answers`, `render` and `confirm`.
   The staging location is `git rev-parse --path-format=absolute --git-path
   dagu-feature/feature.yaml`. Bootstrap also installs/validates the reconciler and
   may change GitHub settings. Deliver its four repository renders via the normal
   adoption issue/commit and retain the three emitted adoption trailers.
   Supply the tested commit body explicitly when squash-merging so each emitted
   trailer retains its complete value on one line:

   ```sh
   git show -s --format=%b "$HEAD_SHA" > "$ADOPTION_BODY"
   gh pr merge "$PR" --squash --match-head-commit "$HEAD_SHA" \
     --body-file "$ADOPTION_BODY"
   ```

   Confirm the merged commit's three values with
   `git show -s --format=%B "$MERGE_SHA" | git interpret-trailers --parse`.
6. **Fresh loading and proof:** bind CLI/reconciler/OMP to the same adopted source
   identity and restart OMP. Inspect all stamps and perform admission plus agreed
   live acceptance before reopening work. Changed `BUNDLE_NAME` follows this whole
   procedure: fresh real renders and matching components establish compatibility.

The authorized bootstrap command shape is:

```sh
skill_dir="$SOURCE/packages/issue-lifecycle/skills/issue-execution"
dagu enqueue --run-id "bootstrap-<repo>-v<version-with-hyphens>" \
  "$skill_dir/dagu-feature-bootstrap.yaml" -- \
  PRIMARY="$PRIMARY" SKILL_DIR="$skill_dir" BASE_BRANCH="$BASE_BRANCH"
```

`BASE_BRANCH` selects an existing integration branch explicitly; an empty or
omitted value retains the GitHub default branch. Bootstrap checks and settings
operations target the selected branch. Review its current protection before
running the `github` step: adoption requires strict required checks.

Run IDs use hyphens rather than dotted versions. Source `origin/HEAD` ancestry,
source cleanliness, independent canonical PRIMARY and exact runtime checks are
real preconditions, not prompts that can be waived. #431's isolated partial
bootstrap executes only detect/render/reconcile; GitHub mutation and adoption
remain outside that proof.

Inspect with the chosen identity-matched CLI:

```sh
dagu version
dagu history reconcile --format json --limit 5
node "$SOURCE/packages/issue-lifecycle/bin/dagu-feature-bundle.ts" "$PRIMARY"
```

The inspection reports name/version stamps and runtime compatibility. Admission
adds verified source-render provenance, loaded-byte binding and an immutable
snapshot; [architecture](../architecture/issue-lifecycle.md#compatibility-is-more-than-a-version-display)
details the actual equalities. All newly admitted components should be pinned to
the approved set; patch-compatible display alone is insufficient.

## Station configuration and drained activation

`dagu-station-install.ts` owns base.yaml and rendered LaunchAgent bytes; it merges
owned config leaves and queue entries by name. Its template sets loopback
`127.0.0.1:8080`, `auth.mode=none`, queues/coordinator enabled and **a4s capacity 8**.
Applying that template preserves the operator-approved a4s capacity; foreign
queue entries survive. Review intended capacity before applying.

By default installation writes files and defers restart. File bytes alone do not
reload the active scheduler. An authorized initial install can use:

```sh
node "$SOURCE/packages/issue-lifecycle/bin/dagu-station-install.ts" \
  --dagu-home "$DAGU_HOME" \
  --launch-agent "$HOME/Library/LaunchAgents/local.dagu.server.plist" \
  --log-dir "$HOME/Library/Logs/Dagu"
```

Use the same parameters with `--check` for byte-level drift (exit 0 unchanged,
1 drift/version/validation failure); `--check` and `--apply` are exclusive.
For an isolated install, set a fresh Dagu home and omit `--launch-agent` so both
plist and logs stay there. Actual service activation belongs to the operator.

For an active station, provision actual close/restart/open hooks:

```sh
node "$SOURCE/packages/issue-lifecycle/bin/dagu-station-install.ts" \
  --dagu-home "$DAGU_HOME" --apply \
  --admission-close "$CLOSE_ADMISSION" \
  --restart-command "$RESTART_SERVICE" \
  --admission-open "$OPEN_ADMISSION"
```

The close hook stops **all** producers, including sessions, CLI/API, automation
and scheduled triggers, and holds exclusion until open. The installer lock only
serializes installers. It waits for both queued and running history to empty;
existing queued runs drain under the previous scheduler. The restart hook sends
TERM to drained `start-all`, waits for replacement PID/readiness with the same
home/config, then leaves admission closed. On launchd, the signal operation is
`launchctl kill SIGTERM "gui/$(id -u)/local.dagu.server"`; readiness belongs in the
operator hook. The installer then verifies eight held running probes plus one
queued in a4s and nine successes before opening. A hook of `true` is valid only
in an isolated environment with no producers or schedules.

The maintained proof is drained TERM restart, bounded to local Dagu 2.20.1
(#255); host restart/distributed-worker survival is a separate proposition.
After a failure during closure, admission remains closed. Inspect service,
history and output before recovery. Preserve `.station-install.lock` barriers
until outstanding probes finish; remove the completed lock only after recovery.
Thirty-day global history retention comes from the installed base; retain durable
acceptance evidence outside that cleanup window.

## Active runs and recovery

Read exact DAG/run status and approval iteration before any human-task action.
The designated reconciler owns CI/merge observation and `await_ci`/`await_merge`
transitions; retain pending runs and candidate SHA rather than duplicating polling.
A dirty/wrong-branch PRIMARY remains waiting while queue capacity is released.
Restore it clean on its declared base while preserving operator changes, then
push back the exact availability checkpoint using its observed iteration (for
example `start_primary_unavailable`, `close_primary_unavailable`, or PoC
`base_primary_unavailable`). Cleaning alone does not resume a waiting task.

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

Production ruleset `25743985` enforces CodeQL on the default branch (`main`)
with security threshold `high_or_higher`, other-alert threshold `errors` and
no bypass actors. These match the adopted `CODEQL_SECURITY_THRESHOLD` and
`CODEQL_ALERTS_THRESHOLD` policy. Repository enforcement and controller adoption
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

Obtain rollback authority for the same lanes and shared controller scope. Close
admission and inventory active/snapshot-bound runs; drain or preserve them under
their original controller contract before changing shared reconciliation. Restore
the approved **coherent set**: source SHA and dependency lock, private package,
source-generated adopted renders/trailers, scheduled reconciler, CLI/PATH binding,
Dagu binary/home/config and OMP package links. Use the restored source's supported
bootstrap/adoption path where regeneration is required, retaining real provenance.
Restart the service only under the drained policy and restart OMP to load restored
modules. Verify stamps, actual admission, readiness and agreed live behavior before
reopening. Restoring a directory or a displayed version alone is not recovery.

## Post-release proof and temporary-lane retirement

The release ([#435](https://github.com/pablontiv/a4s/issues/435)), local adoption
([#436](https://github.com/pablontiv/a4s/issues/436)) and main-owned post-release
proof ([#437](https://github.com/pablontiv/a4s/issues/437), run
`a4s-issue-605-r1`, PR #611) completed before the separately authorized retirement
in [#438](https://github.com/pablontiv/a4s/issues/438).

The temporary `a4s-v1` lane is retired: its `integration/v1` protection and remote
branch, clean linked worktree and independent PRIMARY clone were removed.
Its final branch tree matched the v1.0.0 merge `cacf718` on main. All inventoried
v1-owned runs were terminal; their immutable receipts, isolated-controller
history, six local branches (including the operator-owned #506 branch) and
original protection/configuration were preserved under
`<DAGU_HOME>/backups/a4s-438/`. The final inventory and command evidence are in #438.

The review requested a repo-owned retirement operation. #383 and #415 remain
open, and the station installer only adds or updates queue entries, so the
operator explicitly authorized direct retirement of these exact targets.
Only the `a4s-v1` queue entry was removed from station `config.yaml`; every other
byte was retained. Active-lane derived configuration was unchanged. The shared
scheduler remained running, and the unused queue removal takes effect at the
next drained restart. The station base and template contain no v1 queue entry.

Read-only health and DAG-run API queries, `dagu status feature --run-id
a4s-issue-605-r1`, reconciler history and the clean main PRIMARY were exercised
after retirement. Main's queue/service, shared reconciler, links, historical run
store and unrelated resources retain their existing ownership.
