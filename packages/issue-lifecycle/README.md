# Issue lifecycle

Private native OMP package `@a4s/issue-lifecycle` for the Dagu
issue lifecycle. The Node.js requirement is root `package.json` `engines.node`;
the runtime requires official Dagu 2.23.0 or newer, with local
`auth.mode=none`. Standalone consumers use the same root Node pin. The package owns status observation/wakeup, admission/resource
guards, `triage-reviewer`, `plan-reviewer` and all seven lifecycle workflow skills.

The source CLI runs with Node's strip-only TypeScript support. The package
`typecheck` script enables `erasableSyntaxOnly` to reject non-erasable syntax,
including constructor parameter properties, enums, and runtime namespaces.

## PR-head readiness

Fresh feature snapshots use `code_scanning -> pr_head_ready -> auto_merge`.
Readiness is an idempotent GitHub head observation, not merge authorization.
Native Dagu retries only exit 75 (a successful read of a different head): one
initial observation plus twelve retries, five seconds apart. Each attempt has
its own 30-second native timeout. Exhaustion logs
`rule=pr_head_ready.head_convergence` with the expected candidate and last
observed head. Read failures preserve GitHub stderr and add a
`rule=pr_head_ready.read` authentication/permissions/network diagnostic; they do
not retry, even if the external process returns 75. Malformed heads, changed
candidate/gate/worktree bindings and native timeouts also fail closed.

Pending required CodeQL still releases the queue without polling or enabling
merge; adopted off policy still follows required checks. `auto_merge` retains
integration protection, candidate/gate authorization, final head revalidation
and `--match-head-commit`. No merge/publication mutation is retried. The
integration-protection loop, durable CI/merge human checkpoints, implementation
and rebase retries, and CI budgets are separate mechanisms, not short PR-head
observation loops; their policies are unchanged.
The remaining short feature-template loops perform lock acquisition, retry
`update-ref` after lock contention, wait for cancellation termination, or confirm
an operator transition reached Waiting. They are synchronization, mutation
recovery or durable-checkpoint protocols, not equivalent head observations, and
are intentionally unchanged. No automatic-step defaults are applied to human
tasks or Git effects.

`npm test --workspace @a4s/issue-lifecycle` stays in-process.
`npm run test:live --workspace @a4s/issue-lifecycle` explicitly opts into native
coverage, including `test/live/native-observation.test.ts` against pinned Dagu
2.24.0. Its isolated homes and stubbed GitHub calls exercise all thirteen
convergence positions, exhaustion, auth failures and fresh timeout budgets.
Native step logs are append-only across retries; inspect each labelled read and
`retryCount`, not `doneCount` or separate DAG-attempt IDs. Failure/timeout routing
is a failed observation and aborted downstream. On failure the test retains the
generated definition, native logs/status and timing records in its temporary
home. Existing admitted snapshots and receipts are not rewritten.

## Versioned executable and release builds

The release engine is one Bun-compiled `a4s` executable. Repository tools and
tests continue to use Node/tsx; deployed engine execution never uses a source
checkout. A published release is verified into
`$DAGU_HOME/cache/a4s/<version>/` before admission hands off to that executable.
New admissions require committed `.workspace/dagu/config.json` schema 2.
Schema 1 remains decode-only historical evidence, not admission policy.
Build selection belongs to the stable launcher and `state.current`.

The operator-installed `a4s-launch` is `a4s` on PATH. New admission selects current,
parent admissions select the parent's receipt, and existing-run actions select
the target run's receipt regardless of a caller tick binding. The launcher
restores the exact tuple if missing, verifies it and acquires a process lease
under the state lock before exec. Receipt/snapshot writes and enqueue remain
inside that lease. Snapshots bind every engine call to absolute cached `A4S_BIN`.
Missing immutable releases and corrupt entries fail closed, never select a
replacement. New schema-2 consumers prevent rollback to schema-1-only readers.

Each cache entry retains `verified-archive.tar.gz`. Every reuse rehashes that
archive and streams its tar entries to compare every extracted payload file;
changed cache metadata cannot bless changed contents. `artifact.json` contains
only `version`, `commit`, `digest` and `verifiedAt`. Cache publication is atomic,
and corrupt/conflicting final entries fail closed. Retain referenced artifacts
for nonterminal/recoverable runs, open role jobs and live tick leases;
uncertain reference discovery prevents pruning.

Both CLI `admit` and `enqueue` submit the exact admitted snapshot bytes. Receipts
record top-level `artifact`, `artifactSupport` and actually used `contracts`;
successors additionally record `parent` (`receipt`, `dag`, `run`, `artifact`).
Consumer config identity is separate at `initial.deployment.config`.

`a4s version` and the archive's `identity.json` agree exactly, including uniform
`support` entries `{ read: [...], write: N }` for receipts, job SQL/JSON, config,
run state and PR checkpoints; exact dispatch/checkpoint protocols; the canonical
registration manifest/hash; and the required launcher protocol. Historical
declarations and receipt bytes remain untouched. Compatibility is read coverage,
not build-number distance; `r<N>` status differences are notice-only.

### Stable launcher, scheduled tick and release plugin

Install the separate `a4s-launch-<platform>.tar.gz` once, verify its checksum,
make its compiled binary `a4s` on the service PATH, and initialize cache state
with `a4s station init --artifact '<version>@<commit>#<digest>'`. The operator
installs its `reconcile.yaml`, whose single step is `a4s tick`. No version,
A4S_BIN or A4S_ARTIFACT is pinned in station configuration. See
[deployment](../../docs/operations/deployment.md#install-the-stable-launcher-tick-dag-and-release-plugin).

### Operator-owned service environment

Readiness and bootstrap require one station-local UTF-8 JSON declaration selected
explicitly by absolute `A4S_SERVICE_ENV`. Required fields are `DAGU_URL` (an
unauthenticated HTTP loopback origin), absolute `DAGU_HOME`, and scheduler `PATH`
(colon-separated absolute, nonempty entries). Values are literal; a4s never
infers missing fields from a user home, default port, process table, service
manager or caller PATH. The operator supplies the same values to Dagu and a4s.
Any explicitly selected home/endpoint must match. The declared PATH must resolve
`bash`, `git`, `gh`, `jq`, `curl`, `node`, `omp` and `dagu`.

`a4s service-environment` emits the validated JSON through the shared
launcher-layer reader. `a4s queue --lane <lane>` checks it, station config leaves,
lane capacity and the running API/scheduler using only reads and bounded GETs.
Bootstrap calls the reader only through its release-bound `$A4S_BIN`; it has no
declaration parser or endpoint/home fallback. Other clients/templates migrate
in a separate endpoint/home cutover, so keep their explicit values consistent.

Missing/unreadable/malformed/incomplete declarations or mismatched selections
fail with field-specific diagnostics and operator actions. A healthy caller PATH
cannot conceal missing declared tools, and an unrelated caller PATH does not
invalidate a complete declaration. Recovery belongs to the operator: correct the
declaration/service inputs and missing station settings, preserve foreign queues
and active/waiting runs, follow the station's safe activation policy, then retry.
a4s never creates, repairs or rewrites the declaration, service definitions or
station config, creates a home/probe DAG, enqueues a readiness probe, or installs,
activates, reloads or restarts Dagu. No live-station change is needed for this
feature's isolated tests.
See [format, recovery and operator-owned launchd/systemd examples](../../docs/operations/deployment.md#declare-the-station-service-environment).

Only a confirmed fresh Dagu attempt may create `ticks/<dagRunId>.json` with
`{dagRunId,tuple,createdAt}` before handoff. Retries use that tuple; a missing
binding or unreadable history fails closed, never repins. Tick A remains A after
its promote commits B; the next fresh tick runs B. Binding identity outlives
cache retention, and replay restores only its exact immutable release.
Unknown state schemas and unsupported launcher protocols report
`reinstall a4s-launch` without executing current to interpret the state.

The tick lists runs and dispatches every per-run action through the receipt.
Foreign artifacts are invoked with
`a4s run --primary <canonical-primary> --run <id> -- <command> [args...]`.
The boundary reads the immutable receipt, requires declared dispatch protocol
`a4s-run/1`, checks config/receipt, checkpoint protocols and role-job-store
compatibility, and verifies its exact cache tuple and identity. The selected
engine rechecks the handoff before any action. Observation, no-progress
accounting, stale recovery, transitions, escalation, protection, successors and
role jobs therefore do not borrow the reconciler's release. CI/merge shell
implementations also come from the run artifact's shipped template.

Root classification runs in the selected tick executable, not a per-row shell/jq
loop. Within one tick cache/archive verification is shared by exact tuple, while
each receipt is re-read before every action. Only package-independent
inspect/finish actions matching the tick's exact tuple **and executable bytes**
may execute in-process under that run's receipt-bound environment.
That binding is restored after each action; no verification survives the tick.
Different tuples or bytes still invoke their own cached process. The classify
metric reports `artifactVerifications` and `inProcessActions` to expose this cost
without changing the bounded observation, pagination or no-progress semantics.
Shell observation/transition calls use one deadline-aware subprocess helper per
external call, rather than separate remaining-time and positive-time processes.
The helper computes the remaining original budget immediately before spawning;
startup overhead never grants a fresh budget or changes the per-call cap.

An unavailable/unsupported run is untouched and produces
`reconcile-failure run=<id> status=1 cause=<diagnostic>`; compatible runs continue.
Do not edit old receipts or substitute a newer binary to recover one. Restore
its exact verified artifact or resolve the incompatible run under operator
authority. No automatic installation, cache repair or station restart occurs.

The extracted archive root is directly loadable with `omp -e <release-root>` or
`omp plugin link <release-root>`; its manifest names the two shipped reloadable
extension entries, agents and skills. Packaged extensions select the adjacent
`a4s` for station/admission commands, not PATH or a checkout. HUD observations,
triage/native transitions, protection and role dispatch resolve the run's
artifact instead. Plugin version equality is not an authorization rule.
Unsupported receipts remain visible in the read-only HUD, flagged unsupported,
but mutations are rejected with `A4S_RUN_UNSUPPORTED`. Tool mutations must use
one literal Bash command with an explicit run and PRIMARY (or the bound
checkout); compound/expanded mutation commands are rejected before execution.

Status notices distinguish the admitted `bundle`, loaded `extension`, currently
`installed` plugin and lifecycle source version on `main`. The installed version
is re-read through `~/.omp/plugins/node_modules/@a4s/issue-lifecycle` so replacing
the managed release link is visible to an already-running OMP process. One-off
package loads without that registration use their own on-disk manifest.
Only an installed version newer than the loaded extension produces `compat=stale`
and the restart warning. Main ahead of the installed release is release-pending,
not restart-pending, and produces no restart warning; publishing, installing and
re-pinning that release remain operator actions. Consumer repositories without
the lifecycle manifest continue to report `main=n/a`. Unknown manifest versions
do not establish that a restart would help. These labels never authorize runs.


Every command below preserves its existing arguments, environment variables,
stdout and exit status. `planning` and `reconcile` provide engine utility and
receipt-bound dispatch modes, not a second scheduler.

| Existing command | Executable command |
| --- | --- |
| `dagu-gate <args>` / `node bin/dagu-gate.cjs <args>` | `a4s gate <args>` |
| `dagu-pr-body <args>` / `node bin/dagu-pr-body.mjs <args>` | `a4s pr-body <args>` |
| `dagu-codeql <args>` | `a4s codeql <args>` |
| `dagu-poc-scope <args>` | `a4s poc-scope <args>` |
| `dagu-feature-protect <args>` | `a4s protect <args>` |
| `dagu-role-jobs <args>` | `a4s role-jobs <args>` |
| `dagu-feature-bundle admit <args>` | `a4s admit <args>` |
| `dagu-feature-bundle enqueue <args>` | `a4s enqueue <args>` |
| `dagu-feature-bundle readiness <args>` | `a4s queue <args>` |
| `dagu-feature-bundle observe <args>` | `a4s observe <args>` |
| `dagu-feature-bundle escalation <args>` / `python3 escalation.py <args>` | `a4s escalation <args>` |
| `dagu-stale-recovery <args>` | `a4s stale-recovery <args>` |
| `dagu-feature-prioritize <args>` | `a4s prioritize <args>` |
| `dagu-feature-bundle validate-planning-units <args>` | `a4s planning validate-planning-units <args>` |
| `dagu-feature-bundle planning-reviewer-identity <args>` | `a4s planning planning-reviewer-identity <args>` |
| `python3 bin/heavy-slot.py [--gate <run>] <command> [args...]` | `a4s heavy-slot [--gate <run>] <command> [args...]` |
| Inline reconcile millisecond clock | `a4s reconcile now` |
| Inline reconcile subprocess deadline and call cap | `a4s reconcile bounded <discover\|observe\|transition> <budget-seconds> <started-ms> <cap-seconds> <command> [args...]` |
| Inline reconcile stdin SHA-256 | `a4s reconcile sha256` |
| Inline reconcile CI-no-progress accounting | `a4s reconcile ci-no-progress <state-directory> <observation-id> <threshold>` |
| Inline reconcile sorted transition locks | `a4s reconcile lock <command> [args...]` |

`a4s version` prints JSON with `version`, `commit`, `layout` and `support`.
`src/identity.ts` exports that same identity and the explicit support declaration:
config schemas `[1]`, receipt reads `[1, 2]` and writes `2`, role-job stores `[1]`,
and protocols `triage=role-job/1`, `implement=role-job/1`,
`publication=pr-checkpoint/1`. Source/tsx execution uses the explicit commit
marker `unbuilt`; it is not a release identity. The builder injects the package
version and full `git rev-parse HEAD` commit using Bun `--define`. `identity.json`
is the same declaration, without an archive digest.
New releases declare `layout: "omp-role-runner/1"` and ship `role-runner.ts`
at their root. Verification requires that runner only for this declared layout;
immutable releases without the declaration retain the baseline inventory and
remain inspectable/restorable without migration.

All engine/sibling self-spawns go through `src/executable.ts`: a compiled engine
runs `process.execPath <subcommand>`, a release OMP extension selects its adjacent
`a4s`, and Node/tsx selects the existing source entry with an absolute tsx loader.
The gate command is different by contract: it launches real `node` with the
adjacent real filesystem `bin/dagu-gate.cjs`, whose two CJS siblings also ship in
the archive. Bun's virtual filesystem is not a Node preload location.

`packages/launcher/src/file-lock.ts` uses libc `flock` through `bun:ffi` on Linux and macOS:
blocking exclusive locks, nonblocking exclusive attempts, explicit unlock, and
descriptor-close release all use the original lock files. Node/tsx development
and live tests use Python's standard-library `fcntl.flock` on an inherited
duplicate of the open descriptor; the parent's open file description retains
the kernel lock after the helper exits. This development branch needs `python3`,
but the released Bun engine never invokes it. `bin/heavy-slot.py` remains for
the opt-in `test:live` and `test:compiled` lanes, not default tests. Release
archives contain the compiled engine, real gate preload files, identity and
complete OMP assets; they contain neither source executors nor Python helpers.
Reconcile acquires unique lock paths in Python-compatible Unicode code-point
order before launching the child, including when paths contain non-BMP text.

From the monorepo root, using the locked Bun dependency and GNU tar:

```sh
npm ci
node node_modules/bun/install.js
npm run build:a4s
# Or select one target/output directory:
npm run build:a4s -- --target bun-linux-x64 --outdir dist
```

The default build cross-compiles `bun-linux-x64` and `bun-darwin-arm64` and writes
`dist/a4s-r<N>-<os>-<arch>.tar.gz` plus `.tar.gz.sha256`.
It uses `--compile --compile-autoload-package-json`, disables dotenv/bunfig
autoload, bundles the OMP extension dependency closure, sorts archive entries,
fixes permissions/mtime/uid/gid, and uses deterministic gzip headers.
The checksum line is `<64 lowercase hex>  <archive filename>`.
The build ID is `r<N>`, with `N = git rev-list --count --first-parent <sha>`;
builds fail on shallow checkouts. The workflow checks out the exact validated `main` head with
full history, verifies that CI's `validate` succeeded for that SHA, and publishes
only when the explicit shipped-input set changed since the last published SHA.
It creates `a4s-r<N>` itself, rejects non-first-parent ancestry and ID/SHA
conflicts, and allows a same-SHA rerun only when rebuilt digests equal the
published ones. Releases/assets are never overwritten or deleted by a4s.
Publication is **staged**:
publication does not activate the station, replace plugins, or write service
configuration. Historical SemVer artifacts still verify and restore exactly.

The opt-in `npm run test:compiled --workspace @a4s/issue-lifecycle` builds both
targets, checks archive contents and reproducibility, and exercises the extracted
Linux engine, real Node gate preload, OMP entry loading and flock interoperation.
Set `A4S_RELEASE_DIR` to an existing build directory to reuse its first build.
Run tests with `node_modules/.bin` and the official `dagu` on `PATH`. The test
preload automatically isolates `HOME` and `DAGU_HOME`; none of these commands
changes the station service. The native wrapper retains only the inherited
station-wide orchestration lock (see [test lanes](#development-and-test-lanes)).
For compiled tests, isolated `HOME` may relocate Bun's cache unless
`BUN_INSTALL` or `BUN_INSTALL_CACHE_DIR` is explicitly configured.
`A4S_RELEASE_DIR` remains available to reuse an existing build.

## Consolidated documentation

- [Source catalog and workflow ownership](../../docs/architecture/catalog.md#lifecycle-skills).
- [Architecture, compatibility and receipts](../../docs/architecture/issue-lifecycle.md).
- [Whole-package private installation and native smoke](../../docs/operations/private-install.md).
- [Lane ownership, bootstrap/adoption, station deployment and rollback](../../docs/operations/deployment.md).
- [Dated read-only and isolated identity walkthrough](../../docs/operations/v1-walkthrough.md).
- [Executable issue-execution skill](skills/issue-execution/SKILL.md).

Load the whole package so OMP discovers its two extension entries, agents and
skills together:

```sh
omp -e <absolute-package-directory>
# Persistent linking is a separately authorized operator action:
omp plugin link <absolute-package-directory>
```

Headless Dagu role jobs resolve the station's `omp` from the service PATH.
a4s launches the executing release's pinned `role-runner.ts` with
`-p --no-session -e`, without Bun or an installed OMP source tree. The runner
reads `triage-reviewer` from that release and discovers shared `task` from OMP.
Bootstrap's `a4s role-jobs detect` checks the five required host modules and
both agents, reporting the binary realpath as `root` and resolved sources.
It starts a headless host without launching a role session or a model turn of
its own. Routing records OMP binary realpath, version and SHA-256; a4s strips
Dagu output/log/step variables before host startup. Service PATH selection and
activation remain operator actions. Load/link the complete extracted release
root for the coordinator plugin; restart OMP when switching release packages.

Initial/model-changing cutover closes admission and establishes **zero nonterminal
runs and zero open role jobs**. Install the stable launcher and single-step tick
DAG, initialize verified cache state, link the release-root plugin and select
the intended compiled `omp` on the service PATH. Ordinary payload changes select
through state, not an exact station reconciler pin. Remove obsolete links/PATH
entries only when unreferenced. a4s never writes station/service configuration
or restarts Dagu. See
[operator cutover](../../docs/operations/deployment.md#identity-and-adoption).

## Workflow and command entry points

The seven skills are `issue-execution`, `repository-discovery`, `backlog-breakdown`,
`refine`, `sprint-planning`, `sprint-review` and `sprint-retrospective`.
`SKILL.md` and `feature.yaml`, `poc.yaml`, `discovery.yaml`, `planning.yaml`,
`reconcile.yaml` are release assets under `skills/issue-execution/`.
`dagu-feature-bootstrap.yaml` is the source adoption DAG; it authors policy and
checks readiness, but does not install DAGs or alter the station.

Default reconciler tests exercise classification, pagination, budgets and run
decisions in-process with injected dependencies. The preserved YAML/bash,
compiled-artifact, fanout, timing and official-Dagu scenarios live under
`test/live/`. From the repository root, run
`npm run test:live --workspace @a4s/issue-lifecycle` to include native validation,
mixed-release dispatch, bounded-tick checks and checkpoint/queue scenarios.
The test preload automatically isolates `DAGU_HOME`. Deadline/performance scenarios still
build and run the real release executable so source-loader startup cannot consume
the measured operation budget; `A4S_RELEASE_DIR` can reuse an existing build.
The consumer config file is `.workspace/dagu/config.json`. Admission materializes DAGs from the selected verified release.

The OMP resource guard protects an idle PRIMARY when its policy is committed at
`HEAD` and its canonical path matches the host binding. It resolves
`$DAGU_HOME/primaries/<lane>`, then `A4S_PRIMARY`, then `$DAGU_HOME/a4s-primary`,
using the committed config's lane. Rendered DAGs are not adoption evidence;
an identical-config clone is not protected unless it is the bound PRIMARY.
Active feature/PoC ownership remains independently protected.

The existing feature lifecycle publishes a gated candidate through
`push → pr → code_scanning → auto_merge → await_ci → await_merge`. Triage review remains independent;
optional operator validation is fixed in the config file (a4s currently uses an empty
procedure). Sprint Planning alone selects/ranks/enqueues new work. Discovery and
refinement feed `planning.yaml`, the shared issue-creation backend, which owns
independent plan review and operator approval. Sprint Review evaluates goal
checks from delivery evidence rather than adding a lifecycle checkpoint.

### Local gate failure handoff

`recover_gate` is an operator recovery decision, not an automatic retry.
An authorized push-back returns through `implement_budget` to the implementation
role in the same run/worktree with an incremented iteration. Assignment creation
automatically attaches eligible local gate failure evidence; it does not choose
or perform that recovery transition. Existing CI-return and conflict-resolution
obligations remain independent.

The handoff uses `gate.json` only for the current candidate SHA and the latest
recorded attempt: the gate and that completed attempt must both be `FAIL`, with a
nonzero attempt exit code and an attempt iteration no greater than the assignment
iteration. An incomplete, invalid, successful or different-SHA latest attempt
never causes fallback to an older failure.

Evidence JSON carries `run`, `sha`, `iteration`, validated UUID `gateAttemptId`,
`exitCode`, the configured `GATE` as `command` (at most 2048 characters),
`failures` (at most eight failed phases with bounded `phase`, optional `workspace`
and `command`, and `exitCode`), `diagnostic` (at most 8192 characters), and
`diagnosticTruncated`. The diagnostic prefers a failure-focused excerpt with
small context, otherwise a bounded tail, without loading the whole log into
memory. `gate-output.log` is used only when the latest failed phases prove the
configured command was invoked and failed; pre-/post-check failures instead
carry an explicit phase diagnostic so an old command log is not reused.
Unavailable diagnostics are explicit.

Carried text strips ANSI/control characters and replaces repository/worktree
and absolute host paths with placeholders. The JSON and diagnostics are still
**untrusted input**, never instructions. Read and diagnose the failure, repair
it before reporting completion, and do not resubmit the unchanged candidate
while its failure is unresolved. Keep raw evidence/logs in run artifacts, not
GitHub issues, comments, PR bodies or published summaries; publish only a concise,
path-safe account of the repair and exact checks actually exercised.

### CodeQL merge gate

`CODE_SCANNING` is `required` or `off`. Blank bootstrap inputs keep the
installed choice; the initial choice is `required`. `off` neither observes nor
waits for CodeQL, so auto-merge and `authorize_ci` depend only on
`REQUIRED_CHECK`. Use it for repositories that cannot enable code scanning,
including private Free/Pro user repositories.

When `required`, `a4s codeql` observes the current PR head's `CodeQL` check and
paginated open alerts from `refs/pull/<PR>/head`. Bootstrap fixes
`CODEQL_SECURITY_THRESHOLD=high_or_higher` and `CODEQL_ALERTS_THRESHOLD=errors`
by default; blank inputs preserve installed policy. Security and non-security
thresholds use GitHub ruleset enum values. Enable CodeQL analysis and give the
service permission to read code-scanning alerts before that adoption.

After publication, pending required analysis releases the queue through the native
CI/merge waits. The scheduled reconciler enables guarded squash auto-merge only
when required CI passes and, if code scanning is required, CodeQL passes for the
head. Findings meeting either threshold return the same run to implementation
through `await_ci`, including when GitHub reports ruleset merge state `BLOCKED`.
Rule, severity, location and message remain
in `<git-dir>/dagu-feature/runs/<RUN>/ci-return.json` and the implementation
assignment requires that diagnostic. Permission failures and unexplained analysis
failures stay diagnosed waits; changed heads require fresh evidence. An `off`
policy does not query the code-scanning API, so an HTTP 403 does not block the run.

The adopted candidate policy and latest analysis are retained in
`codeql-policy.json` and `codeql-observation.json`; final authorization repeats
the observation. Retained immutable workflows continue their original checks-only
reconciliation until their publication supplies a candidate-bound CodeQL policy.
Repository `code_scanning` enforcement is separately authorized and configured with
matching thresholds. See the
[execution contract](skills/issue-execution/SKILL.md#codeql-findings-and-merge-enforcement)
for threshold choices, evidence and ownership.


```sh
# Validate prepared units and retain the exact-byte valid snapshot:
a4s planning validate-planning-units \
  --input <absolute-units.jsonl> --snapshot <absolute-validated-units.jsonl> \
  --findings <absolute-findings.md>
# Enqueue the breakdown backend under its owning controller:
a4s enqueue --run-id "<repo>-breakdown-<slug>" \
  planning -- \
  UNITS_FROM="<absolute-units.jsonl>" SOURCE=refine \
  OMP_SESSION_ID="<persistent-session>"
```

Validation reports independent mechanical failures as ordered JSONL (`line`,
`field`, `rule`, expected/observed). Semantic review owns completeness and judgment.
The backend retains durable source/review/materialization receipts, supports
operator-approved unit subsets and typed native GitHub relationships, and
preserves finding lineage/idempotent reuse. Read the
[breakdown skill](skills/backlog-breakdown/SKILL.md) before authorizing publication.
Discovery's `snapshot` prints the persistent output directory; `discover`,
`validate` and `consolidate` preserve lens findings/verdicts/units and backend run.
PoC requires an existing ISSUE; successful PoC/feature continuation preserves the
coordinating session rather than selecting new backlog work.

`dagu_session_id` provides the persistent owner. `/workflows` toggles progress;
`expand`, `collapse`, `hide`, `show` set presentation. Status compatibility is a
display classification, not proof of admission. Native semantic jobs support
`a4s role-jobs stage triage|implement`; resource recovery and exact receipt
binding are detailed in the architecture and execution skill.

### Session notification baseline

The owner watcher freezes the existing-run set after its first successful full
discovery. Each existing active run keeps separate current-details and persisted
event-log baselines: a failed or timed-out first read never makes its history
live on a later sweep. Current details can establish their baseline and deliver
subsequent openings even while event-log reads are unavailable. New runs are live
immediately. Notices are deduplicated by DAG, run, human-task step and approval
iteration, with one terminal notice per run.

Persisted waiting events are checked against the current active run's waiting
human tasks and approval iterations; closed checkpoints do not wake the owner.
The current snapshot is observed before recovered historical entries so a fresh
opening is not consumed by a delayed ledger baseline. Terminal `succeeded`,
`failed` and `aborted` runs need no event-log read: terminals already present at
startup are retired silently, and live terminal transitions are notified once
and removed from tracking. The widget retains terminal toasts but never produces
a second owner wake.

This removes repeated terminal detail/event-log polling; it does not establish
the cause of the historical Dagu 2.20.1 event-log latencies reported in #296.
Native session-restart checks and matched before/after endpoint measurements
remain distinct operator acceptance evidence, not claims made by unit tests.


## Station-owned queue capacity and readiness

The committed `.workspace/dagu/config.json` selects the lane and lifecycle policy,
including its base branch. Queue capacity belongs exclusively to the station
operator's `$DAGU_HOME/config.yaml`, not consumer policy or run parameters.
Admission rejects policy overrides and requires a valid persistent
`OMP_SESSION_ID` before writing a receipt, touching stores or enqueueing.
Successor runs carry operational inputs and the same owner, never policy.

To reenqueue a terminal run's retained candidate, use a suffixed run ID and the
same `ISSUE` and `OMP_SESSION_ID`, preserving `POC_BASIS`/`PR_NUMBER` when
applicable. The branch is derived from `ISSUE` as `dagu/issue-<N>`; admission
rejects `BRANCH`, so do not pass it to `a4s enqueue`. See the
[failed-run recovery procedure](skills/issue-execution/SKILL.md#enqueue-an-issue)
for the ownership-transfer contract and a concrete replacement command.

```sh
a4s queue .workspace/dagu/config.json
# Before first adoption, select the station lane to inspect:
a4s queue --lane a4s
```

Readiness exits 0 only when the named global queue exists in station config and
the running Dagu API, the scheduler is active, and its service environment can
resolve lifecycle tools. It diagnoses missing queues, endpoint/auth failures
and service PATH/home problems. Linux reads the running scheduler's `/proc`
environment; macOS reads the running launchd service's configured environment.
It performs only file reads and HTTP GETs, including on a missing or empty
Dagu home. Bootstrap checks readiness but never repairs station configuration,
installs a service unit or restarts Dagu. Resolve failures with the station
operator; the API must be unauthenticated and loopback-only.

Dagu run capacity remains separate from the semantic-job capacity controlled by
`a4s role-jobs capacity`. The manifest registers only `a4s`; legacy `dagu-*`
registrations are removed. Source wrappers remain for Node/tsx development,
direct CI PR-body validation and the real Node gate preload, not as deployment
aliases or ambient commands used by release snapshots.

## Development and test lanes

```sh
npm test --workspace @a4s/issue-lifecycle
npm run typecheck --workspace @a4s/issue-lifecycle
# Focus a default-lane file without bypassing home isolation or the spawn guard:
npm exec --workspace @a4s/issue-lifecycle -- tsx \
  --import ./test/fixtures/dagu-home.mjs \
  --import ../../scripts/test-no-spawn.mjs --test test/planning-validator.test.ts
# Before release, run native integration with a supported Dagu runtime on PATH:
A4S_GATE_JOURNAL= npm run test:live --workspace @a4s/issue-lifecycle
# Release packaging and extracted-engine acceptance remain separately opt-in:
A4S_GATE_JOURNAL= npm run test:compiled --workspace @a4s/issue-lifecycle
```

All three lifecycle test lanes load `test/fixtures/dagu-home.mjs` before test
modules. It replaces inherited `HOME` and `DAGU_HOME` with a fresh private
temporary directory for each test process and removes that directory on exit.
Fixtures and subprocesses use isolated homes rather than the ambient station's
artifact cache, including children that omit `DAGU_HOME` and fall back to
`~/.dagu`. Callers need not set temporary homes.

`npm test` (also the local feature gate and CI lane) selects only
`test/*.test.ts`, never `test/live/`. It runs module/CLI logic in-process with
fake process, GitHub, Dagu and station dependencies. The shared
`scripts/test-no-spawn.mjs` preload patches every `node:child_process` entry point,
including promisified execution, and throws with the test filename on forbidden
commands. Only direct `git` against temporary repositories and `tar` used by the
archive implementation are allowed; shell execution is forbidden. Setting
`A4S_LIVE_DAGU=1` does not add live tests to the default lane.

`npm run test:live` selects only `test/live/*.test.ts`, sets `A4S_LIVE_DAGU=1`,
and does not load the spawn guard. It preserves real CLI, compiled release,
YAML step-script, multiprocess/OS-lock and timing coverage: feature/PoC,
planning/discovery, admission/cache, reconciler dispatch/fanout/performance,
status/SSE/recovery, resource/protection/readiness, role jobs and escalation.
The shared live gate checks the supported Dagu minimum only when activated.
The compiled-smoke lane enables its release-specific assertions separately.
Default scripts no longer acquire the heavy slot or force serial test-file
execution: Node isolates files, and their fixtures do not use station state.
Native live/compiled lanes retain `bin/heavy-slot.py`: before the test preload
runs, this wrapper acquires the inherited station-wide
`$DAGU_HOME/a4s/heavy-slot.lock` (default home `~/.dagu`). Keep the service's
canonical home in the invoking shell so concurrent native runs share that lock;
do not set a temporary home around the npm command. This orchestration lock is
the single explicit exception outside the isolated test process, not permission
for tests, fixtures or subprocesses to access the station's artifact cache.

Real fixtures use temporary Dagu homes and distinct HTTP ports. Every run identity
comes from `test/fixtures/run-id.ts` and is reused across CLI, REST, status,
recovery and assertions. Its per-process random suffix and counter also isolate
the host-global Unix control sockets: Dagu derives
`/tmp/@dagu_<name>_<hash>.sock` from name/run identity, not Dagu home alone.
Concurrent recovery fixtures preserve separate checkpoints, SHA/iterations and
owned cleanup; closing one leaves the other able to finish.

Failed live PoC fixtures stop their service before preserving the original error,
last HTTP evidence, stdout/stderr and only isolated `data/`/`logs/` under
`A4S_DAGU_DIAGNOSTICS_DIR` when configured on the station. Successful fixtures
clean their owned temporary state. Retention failure does not replace the
original error. This diagnostic evidence is not a production-store snapshot.

For network deadlines, from this workspace run
`npx --no-install tsx --import ./test/fixtures/dagu-home.mjs --import ../../scripts/test-no-spawn.mjs --test test/status-timeout.test.ts`.
Six scenarios cover discovery, detail and SSE-header deadlines: 8000 ms succeeds,
15001 ms aborts against 15000 ms network timeout. Request readiness has a separate
10000 ms real-time bound captured before mocked timers. The fixture uses the
existing repository resolver, canonical or issue-clone origin, and cancels pending
requests on session shutdown. A missing request reports phase/path/workspace/cwd
and observed requests.

For native breakdown review admission, preserve parent/child transcripts in the
canonical encoded-PRIMARY sessions root under the same isolated HOME used by the
controller. The verifier binds the exact parent session path and generation;
`--no-session` cannot prove that provenance. See the planning backend and existing
behavioral tests rather than adding prose/source-shape tests.
