# Issue lifecycle

Private native OMP package `@a4s/issue-lifecycle` for the Dagu
issue lifecycle. The Node.js requirement is root `package.json` `engines.node`;
the runtime requires official Dagu 2.23.0 or newer, with local
`auth.mode=none`. Standalone consumers use the same root Node pin. The package owns status observation/wakeup, admission/resource
guards, `triage-reviewer`, `plan-reviewer` and all seven lifecycle workflow skills.

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

A renamed package needs fresh bootstrap-generated renders, the matching
reconciler/CLI binding and a new OMP process. Restart OMP after lifecycle
redeployment; builtin resource rediscovery alone does not load newly introduced
TypeScript modules. Source publication is distinct from installation/adoption.
The runbook records main's adopted stable-controller identity, candidate isolation
and the completed temporary-v1-lane retirement.

## Workflow and command entry points

The seven skills are `issue-execution`, `repository-discovery`, `backlog-breakdown`,
`refine`, `sprint-planning`, `sprint-review` and `sprint-retrospective`.
`SKILL.md` and `feature.yaml`, `poc.yaml`, `discovery.yaml`, `planning.yaml`,
`reconcile.yaml`, `dagu-feature-bootstrap.yaml` remain together under
`skills/issue-execution/` for relative paths and bootstrap's SKILL_DIR bindings.

Reconciler behavior tests use the maintained `skills/issue-execution/reconcile.yaml`
directly, with throwaway materialization for native validation. From this package,
run `A4S_LIVE_DAGU=0 npx tsx --test test/reconcile-ci.test.ts test/reconcile-performance.test.ts`
for isolated script scenarios, or `A4S_LIVE_DAGU=1 npx tsx --test test/reconcile-ci.test.ts test/reconcile-performance.test.ts`
to include official-Dagu validation, bounded-tick checks and checkpoint/queue scenarios in isolated temporary homes.
The consumer config file is `.workspace/dagu/config.json`. Admission materializes DAGs from the installed templates.

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

### CodeQL merge gate

`CODE_SCANNING` is `required` or `off`. Blank bootstrap inputs keep the
installed choice; the initial choice is `required`. `off` neither observes nor
waits for CodeQL, so auto-merge and `authorize_ci` depend only on
`REQUIRED_CHECK`. Use it for repositories that cannot enable code scanning,
including private Free/Pro user repositories.

When `required`, `dagu-codeql` observes the current PR head's `CodeQL` check and
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
node packages/issue-lifecycle/bin/dagu-feature-bundle.ts validate-planning-units \
  --input <absolute-units.jsonl> --snapshot <absolute-validated-units.jsonl> \
  --findings <absolute-findings.md>
# Enqueue the breakdown backend under its owning controller:
node "$CONTROLLER_CLI" enqueue --run-id "<repo>-breakdown-<slug>" \
  planning -- \
  UNITS_FROM="<absolute-units.jsonl>" SOURCE=refine \
  PRIMARY="<absolute-independent-primary>" OMP_SESSION_ID="<persistent-session>"
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
`dagu-role-jobs stage triage|implement`; resource recovery and exact receipt
binding are detailed in the architecture and execution skill.

## Repository-owned queue capacity

Bootstrap's `QUEUE_CONCURRENCY` answer is a positive integer. Blank preserves
`queueConcurrency` in `.workspace/dagu/config.json`; the initial value is 1.
a4s commits **8**, the operator-approved installed capacity.

The config file is the source of truth. Bootstrap derives its named
`queues.config` entry in `$DAGU_HOME/config.yaml`, preserving other queues,
metadata, shared keys and comments. An unchanged entry keeps bytes and scheduler
intact. A changed entry requires the running launchd `local.dagu.server` to use
`dagu start-all` and the same Dagu home, then requests `launchctl kickstart -k`.
Waiting human tasks keep their persisted state. A failed restart atomically
restores the previous config for retry.

`dagu-feature-bundle <repo>` and `queue-check <config.json>` report queue drift as
`compat=incompatible action=re-run-bootstrap`. Re-run bootstrap when the config
file should change. Station installation manages shared defaults and preserves
repository queue limits; its drained activation requires
`--apply --repo-dag <config.json>` and the existing operator-owned admission
and restart hooks, and verifies that capacity with N+1 barrier runs.
Queue capacity counts Dagu runs; the independently managed role-job capacity
counts semantic jobs and remains controlled by `dagu-role-jobs capacity`.

## Development and real-Dagu fixtures

```sh
npm test --workspace @a4s/issue-lifecycle
npm run typecheck --workspace @a4s/issue-lifecycle
npm exec --workspace @a4s/issue-lifecycle -- tsx --test \
  test/planning-template.test.ts test/discovery-contract.test.ts \
  test/bundle-template.test.ts test/admission.test.ts
# Before a package release, run live integration on the station with its pinned binary in PATH:
A4S_LIVE_DAGU=1 npm test
```

CI and default tests need no Dagu binary: real-Dagu cases skip unless
`A4S_LIVE_DAGU=1`. That opt-in includes `test/live/*.test.ts` and guarded
real-Dagu cases in retained unit files; `test:live` remains a focused live command.
The shared live gate inspects `dagu version` only when activated and
requires the manifest pin. Tests cover progress/SSE (including the 20-topic
connection boundary), CLI history/status and persisted run records, native
stale-process repair text, resource identity, planning, transitions, semantic
multiprocess capacity/recovery, escalation across restart and native receipt verification.

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
`A4S_LIVE_DAGU=0 npx --no-install tsx --test test/status-timeout.test.ts`.
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
