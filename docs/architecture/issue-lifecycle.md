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

The [artifact contract](artifact-contract.md) is normative. Immutable build releases
publish one compiled `a4s` executable per platform with identity, real Node gate
preload files, extension closure, agents and skills. The release engine never
executes an installed source checkout.

The consumer commits `.workspace/dagu/config.json` with `schemaVersion: 2`.
Admission reads config bytes at consumer HEAD; unknown fields and uncommitted
policy are rejected. Schema 1 remains readable only as historical evidence, not
as new-admission policy. Queue capacity is not consumer policy.

A root admission selects station `state.current` as `(version, commit, archive digest)`,
verifies the archive before extraction, validates its identity/assets and
atomically publishes `$DAGU_HOME/cache/a4s/<version>/`. Existing entries must pass
integrity validation and cannot be overwritten or silently repaired. Admission
hands off to that entry's executable with
`admit --artifact '<version>@<commit>#<digest>'`. The selected engine verifies
the tuple without another resolution/handoff, materializes its own templates
and binds `A4S_BIN` to the cached absolute executable in the immutable snapshot.

Feature → PoC, PoC → feature and discovery → planning verify and inherit the
parent receipt's tuple. Changed child policy does not upgrade the successor.
Each child independently validates committed policy; missing/invalid parent
artifacts fail closed rather than falling back to a checkout or another release.
Cache retention protects station pointers, process leases, nonterminal/recoverable
runs and open role jobs.

Bootstrap checks the independent canonical PRIMARY, tools, native role discovery
and station readiness, then authors schema-2 consumer policy.
Its authorized GitHub step may change merge settings and branch protection.
It neither renders/installs DAGs nor installs an engine or shared reconciler.
The operator separately provisions the stable launcher, tick DAG and station settings.
a4s never writes `$DAGU_HOME/config.yaml`, `base.yaml` or service units and never
restarts Dagu. `a4s queue <config>` performs only reads and HTTP GETs.

### Compatibility is more than a version display

Explicit supported dispatch (`a4s-run/1`), receipt-schema, checkpoint-protocol and
role-job-store versions are declared by both the executable and `identity.json`. Admission
requires supported contracts, not a SemVer-distance guess. Status version-distance
labels remain presentation only, not authorization.

The operator installs a separate compiled `a4s-launch` as `a4s` on PATH and its
one-step scheduled DAG (`a4s tick`). Under the state lock the launcher selects
current for fresh admissions, the parent's tuple for successors, and the target
receipt for existing-run actions. Tick first-attempt evidence binds its run ID
durably; retries never repin, even if current changes. Exact missing tuples are
restored and verified before leasing and exec. Unknown state schemas/protocols
fail closed without loading current. Installation/scheduling stay operator-owned.

Station-wide listing and scheduling use the tick's bound binary. Stale recovery,
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

## D11 — Stable-loader hot-reload transaction

**Status: native PoC PASS; U4 production source integration is in
[`packages/loader`](../../packages/loader/) and the shared
[`generation runtime`](../../packages/hot-reload/src/generation.ts).**
[Issue #787's PASS comment](https://github.com/pablontiv/a4s/issues/787#issuecomment-6515266902)
is the retained native decision basis, not a claim that this source is installed.
Issue #787 preserves the throwaway `poc/hot-loader/` harness and this architecture
record; its observations below remain the historical PoC's bounded claims.

U4's stable `packages/loader` package (`@a4s/loader`) lives outside the
selected build root and is operator-linked once at `~/.omp/plugins/node_modules`.
Changing that loader requires an OMP restart. The experiment instead installed
only `@a4s/poc-hot-loader` in an isolated plugin root. Native plugin discovery
loaded it without `-e` or `--no-extensions`; native OMP PID 405996 executed both
cached builds A → B → A without restarting or invoking `/reload-plugins`.

The production loader checks state automatically and defers session/agent-end
requests through a timer before checking idle. It attempts a changed generation
once, retaining the old behavior on failure; manual `/reload-plugins` can retry.
It checks the canonical metadata/resource manifest and required protocols before
leasing/importing, then constructs both complete bundles privately. Generation
abort owns observer controllers and pump timers; switch-owned plain queues,
notification toasts, transition deduplication and event-log acknowledgements
survive success and rollback. Every imported candidate retains its lease until
OMP process exit, even if construction or timed startup fails. No module-memory
eviction is claimed. The restart/drain procedure in
[`deployment.md`](../operations/deployment.md#retiring-plugin-generations-restart-and-drain)
separates retiring-reader retention from active behavior.

### Transaction and ownership boundary

The proven mechanism in [`poc/hot-loader/loader.ts`](../../poc/hot-loader/loader.ts)
keeps the host-facing registration surface stable and delegates callbacks
through **one combined active-generation pointer**, not two independently
published status/triage registrations:

1. Read the requested `state.json` generation at native `session_start`, or
   after native `agent_end` using `setTimeout(..., 0)`. Only the deferred callback
   checks `ctx.isIdle()`; checking inside the event handler is too early because
   the host becomes idle after handlers return. The loader has a single-flight
   transaction and each lifecycle attempt carries a generation token.
2. Before acquiring a lease or importing code, read the candidate's
   `identity.json` registration manifest (D12) and required loader/launcher
   protocols (D17). A mismatch keeps the current generation and prompts
   **“restart OMP”**, with no lease or import. The PoC captured canonical
   host-facing command/tool metadata, schemas, descriptions, load modes,
   completion surfaces and event names from source before compilation; the
   instrumented build embedded and declared the same manifest. Functions were
   represented by `"<function>"`, so this checks callback presence, not callback
   implementation equivalence. Its protocols were `poc-d11/1` and
   `poc-launcher/1`, not production protocol declarations.
3. Acquire the candidate artifact lease, import `<build>/src/status/index.ts`
   and `<build>/src/triage/native.ts`, and construct both real factories against
   staging facades. Validate the constructed registrations against the manifest
   before publishing any candidate behavior. Import or factory failure leaves
   both current extensions active.
4. Revoke the old token, abort its status observer controller and clear its
   pending pump timer; merely changing dispatchers cannot stop detached status
   work. Take its undelivered per-session notification queue, preserving the
   queue's claim/hold state, and transfer ownership to the candidate. Switch the
   single pointer for **both extensions**, then run the candidate's
   `session_start`-equivalent lifecycle with a deadline. Startup notifications
   are held in an outbox until commit.
5. On lifecycle failure or timeout, revoke/abort candidate work, recover its
   undelivered queue and startup outbox, switch both extensions back together,
   and restart the old lifecycle with a fresh token. A late candidate
   continuation retains its stale/aborted token and cannot publish. The PoC
   deadline was 150 ms; its injected completion at 450 ms published nothing.

Behavior ownership and artifact retention are separate. A lease is released
immediately only when preparation fails **before the first candidate import
starts** (for example, a lease/restore error). Once any import attempt starts,
that candidate's lease stays until OMP process exit, even for import, factory or
startup failure. Retiring generations also retain their leases: evaluated
module code may still refer to build files and there is no module-eviction API.
“Lease held” never means “behavior active.” U4 must expose those leases to cache
GC; actual GC was not exercised here.

### Retained native evidence and resources

Let `E=<git-dir>/poc/runs/poc-a4s-issue-787/computations/hot-loader`, where
`<git-dir>` denotes the repository's shared Git directory. These are retained
run artifacts, not files shipped in the plugin or committed runtime state:

- `E/observations.jsonl` is the primary evidence (285 rows).
  `E/acceptance-evidence.json` is a compact extraction, not a substitute.
  Commits at lines **17 / 47 / 84** show A/A → B/B → A/A, each with one
  non-aborted observer controller on the same PID. Lines **24→26 / 61→63 /
  98→100** show native `agent_end` followed by deferred `idle=true`; lines
  **62 / 99** execute B and then A status code on native `agent_end`.
  Sentinel probes at **21 / 50 / 87** execute the real status tool and triage
  guard callbacks.
- Manifest rejection at **104–105** warns “restart OMP” with
  `importStarted=false`, `leaseAcquired=false`. Import failure (**128**),
  second-factory failure (**155**), lifecycle rollback (**202**) and timeout
  rollback (**250**) all leave A/A with one active observer controller.
  Late completion at **252** has `stale=true`, `aborted=true`, `published=false`.
- Queue probes **1–21** are conserved without missing, duplicate or outstanding
  IDs, including recovery from both lifecycle faults. Seven imported/retiring
  generation leases remain before clean exit; `E/checkpoints/99-process-exit.json`
  records zero afterward.
- `E/native-launch.json`, `E/isolated-plugin-list.json` and
  `E/native-commands.jsonl` retain native discovery, invocation and measurement
  provenance. `E/binary-paths.json` records the executed OMP realpath, version
  **omp/18.14.0** and binary SHA-256. `E/builds/build-index.json` records archive
  SHA-256 and build identities; `E/builds/commands.jsonl` retains build commands.

The contemporaneous driver checkpoints used `ps -o rss=` and `du -sk`; per-case
measurements are in `E/driver-observations.jsonl`,
`E/acceptance-evidence.json` (`resourceMeasurements`) and `E/checkpoints/`:

| Outcome | Status / triage | Active controllers | RSS (KiB) | Held leases |
| --- | --- | ---: | ---: | ---: |
| Initial A | A / A | 1 | 322,968 | 1 |
| Promote B | B / B | 1 | 290,900 | 2 |
| Return to A | A / A | 1 | 289,244 | 3 |
| Manifest mismatch | A / A | 1 | 280,660 | 3 |
| Import failure | A / A | 1 | 283,248 | 4 |
| Second-factory failure | A / A | 1 | 284,432 | 5 |
| Lifecycle failure | A / A | 1 | 289,676 | 6 |
| Lifecycle timeout | A / A | 1 | 289,984 | 7 |

Both builds were extracted in advance: each retained **81,680 KiB**, totaling
**163,360 KiB** throughout the run. Final pre-exit RSS was **290,444 KiB**.
These are resource observations, not a monotonic retained-module estimate or a
proven long-running memory bound; old module memory is not evicted.

### Source/adapter limits carried into U4

Builds A (`87fdff7571f6cbbc9999843f341c52c2be968882`) and B
(`abe25b8ac1be022304f461164b892a94e26bdf7e`) differ only in their status/triage
sentinel constants on shared disposable-source instrumentation.
`E/builds/sentinel-commits.bundle` preserves those source commits and
`E/builds/instrumentation.patch` preserves the exact source/adapter boundary:
the status observer loop and triage guard still ran from the compiled modules.
The patch also changed lifecycle behavior, not just observability:

- Status captured each observer's own `signal` in its notification callback,
  rather than reading the mutable controller variable after a restart. It
  tracked the deferred pump timer so `stop()` could clear it before handoff.
- The status adapter exposed the actual private queue and supplied
  `takeQueue`/`putQueue`, preserving per-session messages, claims and the
  synthetic probe's hold flag. Queue batches were held before each switch,
  including both lifecycle rollback faults, then explicitly released.
- The triage wrapper reported sentinel use and forwarded `tool_call` to the
  real guard; it also added a startup observation hook.

These changes belong to the disposable builds, not the production status/triage
sources. U4 must implement the lifecycle and queue ownership boundary in
[`packages/issue-lifecycle/src/status/index.ts`](../../packages/issue-lifecycle/src/status/index.ts)
alongside the stable loader; the PoC does not establish that production already
has it.

The notification proof uses **synthetic numbered inputs in the real status
`Map` and claim/pump path**, with `pi.sendMessage` intercepted into a delivery
ledger. It proves conservation for that instrumented handoff, not untouched
production notification guarantees, real Dagu transitions, end-user delivery or
extra model turns. The hold/transfer adapter closes a queue handoff race and is
absent from production; U4 must implement that boundary rather than copy a
dispatcher-only swap.

Observer counts measure actual root `AbortController` state. Abort and source
signal checks support cessation of old work **[INFERENCE]**; settlement of the
detached `observe()` promise was not directly observed, nor cancellation of
arbitrary third-party effects. Manifest mismatch was injected into the loader's
declared-manifest view; factory failure followed the real status factory;
lifecycle failure/timeout followed real status and triage startup.

`E/independent-review.json` confirms the PASS with these limits. The observer
used an unreachable loopback Dagu endpoint. Overlapping transitions, the
single-flight join path, actual cache GC, manual `/reload-plugins` compatibility,
abrupt-kill lease cleanup and a long-run memory bound were **not exercised**.
Clean-exit lease release does not establish hard-kill cleanup; a hard kill may
leave PID-checkable stale lease files. Manual reload compatibility remains a
U4 requirement, not a result of this experiment.

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

Required-check classification uses the latest workflow run for each check name
on that head, preserving required GitHub App bindings. Workflow run IDs take
precedence over check/job IDs: a concurrency-cancelled run can create its
aggregate job after the superseding run has started. Superseded failures,
cancellations and skips do not override the newer outcome or cause escalation;
within one workflow run, the newest check ID handles job reruns. Legacy statuses
and checks without Actions run links retain newest-ID selection.

The repository CI aggregate `validate` job uses `${{ !cancelled() }}` so a
concurrency-cancelled workflow does not start a failing aggregate. An invoked
aggregate still rejects missing/blank `WORKSPACES` explicitly; a published `[]`
matrix remains valid when the workspace test job is skipped.

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
gate bodies across independent clones and worktrees, plus
`@a4s/issue-lifecycle`'s opt-in `test:live`/`test:compiled` scripts launched
outside Dagu. Default root/workspace `npm test` scripts are unslotted: they
select only top-level tests and enforce in-process execution with the shared
spawn guard (direct `git`/`tar` excepted). Test files no longer need forced
serial execution to protect a real runtime.
Station gate sessions use the service's canonical `DAGU_HOME` (default
`~/.dagu`); live test fixtures instead own isolated temporary homes.
The release engine's `a4s heavy-slot` retains an inheritable descriptor through
the command and exports `A4S_HEAVY_SLOT_HELD=1` so nested heavy scripts do not
reacquire the slot. Source live/compiled scripts retain `bin/heavy-slot.py`.
The marker is inherited ownership, not an operator bypass.

Success, failure, cancellation and SIGKILL release kernel ownership when all
inheriting descriptors close; surviving descendants keep exclusion. The stable
lock inode is not removed. Single-file `tsx --test` runs and light-workspace
tests remain unslotted. Integration protection uses a separate short-lived
per-repository admission lock and releases the station slot while a gate waits
on protection. Dagu queue capacity is station-operator configuration, unrelated
to consumer config; unrelated lifecycle steps proceed. Deployment acceptance
still requires operator-observed primary/authorized-clone native gate windows;
the lightweight default test lane is not evidence of heavy-slot exclusion.


## Native semantic jobs and capacity

### Role runtime on the station omp binary — D16

`a4s role-jobs stage triage|implement` resolves `omp` from the Dagu service PATH
and starts it with `-p --no-session -e <packageRoot>/role-runner.ts <job-directory>`.
The runner ships in the executing release and therefore stays pinned to the run.
No Bun or OMP source tree is used. Before spawn, a4s constructs the child
environment: Dagu output/log/step variables are removed, while home, run,
iteration and ordinary tool/provider context survive. Only a4s retains the
stage's private output sink.

The runner imports the host's external `task/discovery`, `task/executor`,
`task/settings`, `config/settings` and `config/model-resolver` modules. It reads
the pinned release's `triage-reviewer` definition directly; only shared `task`
comes from native discovery. Settings, role model arrays, named routing roles
and strict native structured execution retain their existing behavior.
Bootstrap's `a4s role-jobs detect` uses the same runner and validates all five
modules and both agents before adoption; each job repeats those checks.
Detection reports `{root, agents}` with the binary realpath and agent sources.
It starts a headless OMP host but neither a role session nor its own model turn.
Missing binaries, host modules, agents and runner results fail closed with an
operator diagnostic; cancellation terminates the OMP child.

Routing evidence records `runtime: {binary, version, digest}`: the OMP realpath,
`omp --version` and binary SHA-256, alongside pinned-agent provenance and model
selection. Existing source-runtime evidence remains valid without migration.
Factory-awaited execution followed by an immediate main `session_start` exit
consumes the [PoC-3 PASS evidence](https://github.com/pablontiv/a4s/issues/789#issuecomment-6515111305).
The factory owns the work once, including across subagent rebinds; the handler
only exits after the loader restores its exit guard. Native work does not run
inside the time-limited handler. PoC-3 retained both final native jobs beyond the
ordinary 30-second handler limit with zero hosting-session provider requests.
`--no-extensions` suppresses ambient discovery but not explicit `-e` entries;
the production flags omit it so shared `task` discovery remains available.
Parent SIGTERM/SIGINT is explicitly forwarded to the OMP child; OMP's normalized
SIGTERM status 143 maps to a failed role job, not a completed result.

The [retained final native artifacts and cancellation receipts](https://github.com/pablontiv/a4s/issues/789#issuecomment-6515111305)
include transcripts, `native-result.json`, `routing.json` and assignments in
`tern-factory-job/` and `system-factory-job/`, binary identities in
`binary-metadata.json`, and verification in `observations.json`. Final
`*.launcher-events.jsonl`, `*.ps-before.txt` and `*.ps-after.txt` preserve the
forwarding and cancellation observations under
`<git-dir>/poc/runs/poc-a4s-issue-789/computations/role-runner/`.
These native job/cancellation artifacts, not import-only detection or the
earlier timed-handler experiment, are the runtime basis. Station binary/PATH
choice and service configuration remain operator-owned.

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

## Role runtime on the station omp binary — D16

The [retained PASS for #789][d16-pass] establishes the headless entrypoint for
[UR / #791](https://github.com/pablontiv/a4s/issues/791). This section records the
verified mechanism and its limits; #791 owns the runtime, packaging and operator
documentation cutover. It does not change the package-root runtime described
above or authorize station/service changes.

The final [runner][d16-runner] is an **awaited async extension factory**. While
the host loader awaits that factory, it loads the assignment, resolves routing,
awaits `runSubprocess` with caller-supplied strict structured output and persisted
artifacts, and retains the success/error exit status. After the factory returns
and the loader restores its `process.exit` guard, the owning **main** session's
`session_start` handler exits immediately with that status, before a hosting
model turn. Child-session extension rebinds neither repeat the work nor exit.
Calling `process.exit` inside the guarded factory fails; putting the native work
inside `session_start` encounters that handler's 30-second timeout. Neither the
import-only probe nor the earlier timed-handler runner is the final proof.

The exact runtime host-module imports are:

```text
@oh-my-pi/pi-coding-agent/task/discovery
@oh-my-pi/pi-coding-agent/task/executor
@oh-my-pi/pi-coding-agent/task/settings
@oh-my-pi/pi-coding-agent/config/settings
@oh-my-pi/pi-coding-agent/config/model-resolver
```

These modules come from the compiled omp host, not an installed source tree or a
second bundled runtime. The canonical
`packages/issue-lifecycle/agents/triage-reviewer.md` definition and its schema
were loaded **from the file**, not chosen from discovery. Its retained SHA-256 is
`5f3b2358e156e382ba10bfdc12e6b80f564f9c205ccd491e1d4841d7f666d210`;
its `@slow` role resolved to `anthropic/claude-fable-5-1`. The shared bundled
`task` agent remained discoverable. A plugin agent with the same triage name was
only a discovery probe, not the selected definition. D16 pins the triage file to
the executing release; it does not require a service-user registry link for it.

Both compiled candidates ran with `env -i`, isolated HOME/config/data directories,
Bun absent from PATH and no runtime-root override. The final exercised omp argv
was:

```sh
omp -p --no-session --model poc-unroutable/hosting-model \
  --no-extensions -e "$SCRATCH/plugin" -e "$EVIDENCE/runner.ts" "$JOB"
```

Here `$SCRATCH/plugin` is the explicit-plugin probe, not a production dependency;
`$JOB` is the candidate's scratch assignment/binding directory. The deliberately
unreachable hosting route and event guards exposed any hosting provider request.
On both versions, **`--no-extensions` suppresses ambient discovery, not explicit
`-e`**: the runner and explicitly loaded plugin still executed and the latter
still supplied an agent; a plugin configured only through ambient discovery
disappeared. These flag observations do not require discovering the pinned
triage definition.

The [binary metadata][d16-binaries], per-case launcher receipts and each job's
`detect.json` bind the invoked path, actual executable **realpath**, `omp --version`
and binary **SHA-256**, rather than a source executor digest:

| Candidate | Executable identity | Version | Binary SHA-256 |
| --- | --- | --- | --- |
| tern | `~/.local/share/tern/omp/bin/omp` → `~/.local/share/tern/omp/versions/18.14.0` | `omp/18.14.0` | `e7dd2b606c4ebe9d1a7bcfad1b8820db968cd6b05409fed1c6bc8db0b6a95a8f` |
| system profile | `<system-profile>/bin/omp` → exact immutable-store realpath retained in metadata | `omp/18.13.3` | `42d39fa8996fed9f999e26306e60e2fdbea0c0de0d0b2d68feba275f44c41d04` |

All six completed observations retained valid strict output, assignment-bound
JSONL transcripts and matching successful `yield` results with final assistant
provenance `anthropic/claude-fable-5-1`. Each completed job made one native provider
request and **zero hosting-session provider-request or agent-start events**.
The final factory-based pair additionally held the factory open for 31 seconds
after native completion: total omp lifetimes were 49.765 s and 47.582 s, both exit
0 without a hosting turn. This exercises waiting beyond the handler's 30-second
limit, not unlimited duration or compatibility with every omp version.

### Retained final artifacts and cancellation

`$EVIDENCE` denotes
`<git-dir>/poc/runs/poc-a4s-issue-789/computations/role-runner/`.
The local artifact links below resolve from the canonical primary checkout;
in a worktree, substitute `git rev-parse --path-format=absolute --git-common-dir`
for that checkout's `.git`. These untracked runtime artifacts are not published
in the source tree; the [PASS comment][d16-pass] is the public evidence index.
[observations.json][d16-observations] records the six completed jobs, artifact
hashes, routing, strict-yield equivalence, flag matrix and cancellations.

| Final candidate | Completed native artifacts | Host receipt | Cancellation receipt |
| --- | --- | --- | --- |
| tern | [native-result.json][d16-tern-result], [825c7312…jsonl transcript][d16-tern-transcript], [job directory][d16-tern-job] | [tern-factory-live.receipt.json][d16-tern-live] | [tern-factory-cancel.cancellation.json][d16-tern-cancel] |
| system profile | [native-result.json][d16-system-result], [181c2cd2…jsonl transcript][d16-system-transcript], [job directory][d16-system-job] | [system-factory-live.receipt.json][d16-system-live] | [system-factory-cancel.cancellation.json][d16-system-cancel] |

Each final job directory also retains `assignment.json`, `binding.json`,
`routing.json`, `detect.json` and `host-events.jsonl`. The final cancellation
receipts record SIGTERM sent **only to the harness parent**, which explicitly
forwards SIGTERM to its omp child. Both parent and child disappeared from `ps`;
the child normalized SIGTERM to **exit status 143**, not an OS-signal result,
in 37 ms (tern) and 105 ms (system), without SIGKILL escalation. The accompanying
`<case>.launcher-events.jsonl` and `<case>.ps-{before,after}.txt` retain forwarding
and process evidence. D16 must preserve this explicit parent-to-omp forwarding
and status-143 mapping; arbitrary parent death does not automatically kill the
child. The native role here executes in-process inside that omp child.

[d16-pass]: https://github.com/pablontiv/a4s/issues/789#issuecomment-6515111305
[d16-runner]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/runner.ts
[d16-binaries]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/binary-metadata.json
[d16-observations]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/observations.json
[d16-tern-result]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/tern-factory-job/native-result.json
[d16-tern-transcript]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/tern-factory-job/825c7312a9a748eb9a40b9f2ff2c702a9fe5d8860ee62fd5f2dd1b967f8cd780.jsonl
[d16-tern-job]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/tern-factory-job/
[d16-tern-live]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/tern-factory-live.receipt.json
[d16-tern-cancel]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/tern-factory-cancel.cancellation.json
[d16-system-result]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/system-factory-job/native-result.json
[d16-system-transcript]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/system-factory-job/181c2cd26cd6eb3eba8f2790488309c1591dc6180229e355b931c1ef246726e6.jsonl
[d16-system-job]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/system-factory-job/
[d16-system-live]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/system-factory-live.receipt.json
[d16-system-cancel]: ../../.git/poc/runs/poc-a4s-issue-789/computations/role-runner/system-factory-cancel.cancellation.json

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
