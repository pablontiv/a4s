# Issue lifecycle

Private native OMP package `@a4s/issue-lifecycle`, currently `0.4.1`, for the Dagu
issue lifecycle. Requires Node.js >=22.19.0 and official Dagu `2.20.1` with local
`auth.mode=none`. The package owns status observation/wakeup, admission/resource
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
The runbook covers the baseline's retained stable-controller stamps and the
isolated procedure required before integration/v1 is on origin's default branch.

## Workflow and command entry points

The seven skills are `issue-execution`, `repository-discovery`, `backlog-breakdown`,
`refine`, `sprint-planning`, `sprint-review` and `sprint-retrospective`.
`SKILL.md` and `feature.yaml`, `poc.yaml`, `discovery.yaml`, `planning.yaml`,
`reconcile.yaml`, `dagu-feature-bootstrap.yaml` remain together under
`skills/issue-execution/` for relative paths and bootstrap's SKILL_DIR bindings.

The existing feature lifecycle publishes a gated candidate through
`push → pr → auto_merge → await_ci → await_merge`. Triage review remains independent;
optional operator validation is fixed at adoption (a4s currently uses an empty
procedure). Sprint Planning alone selects/ranks/enqueues new work. Discovery and
refinement feed `planning.yaml`, the shared issue-creation backend, which owns
independent plan review and operator approval. Sprint Review evaluates goal
checks from delivery evidence rather than adding a lifecycle checkpoint.

```sh
# Validate prepared units and retain the exact-byte valid snapshot:
node packages/issue-lifecycle/bin/dagu-feature-bundle.ts validate-planning-units \
  --input <absolute-units.jsonl> --snapshot <absolute-validated-units.jsonl> \
  --findings <absolute-findings.md>
# Enqueue the adopted breakdown backend under its owning controller:
node "$CONTROLLER_CLI" enqueue --run-id "<repo>-breakdown-<slug>" \
  .workspace/dagu/dags/planning.yaml -- \
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

## Development and real-Dagu fixtures

```sh
npm test --workspace @a4s/issue-lifecycle
npm run typecheck --workspace @a4s/issue-lifecycle
npm exec --workspace @a4s/issue-lifecycle -- tsx --test \
  test/planning-template.test.ts test/discovery-contract.test.ts \
  test/bundle-template.test.ts test/admission.test.ts
# Explicit live acceptance, with the pinned binary in PATH:
npm run test:live --workspace @a4s/issue-lifecycle
```

The default script forces `A4S_LIVE_DAGU=0` even if the caller exports 1.
`test:live` activates `test/live/*.test.ts` and guarded real-Dagu cases in retained
unit files. The shared live gate inspects `dagu version` only when activated and
requires the manifest pin. Tests cover progress/SSE, resource identity, planning,
transitions, semantic multiprocess capacity/recovery and native receipt verification.

Real fixtures use temporary Dagu homes and distinct HTTP ports. Every run identity
comes from `test/fixtures/run-id.ts` and is reused across CLI, REST, status,
recovery and assertions. Its per-process random suffix and counter also isolate
the host-global Unix control sockets: Dagu 2.20.1 derives
`/tmp/@dagu_<name>_<hash>.sock` from name/run identity, not Dagu home alone.
Concurrent recovery fixtures preserve separate checkpoints, SHA/iterations and
owned cleanup; closing one leaves the other able to finish.

Failed live PoC fixtures stop their service before preserving the original error,
last HTTP evidence, stdout/stderr and only isolated `data/`/`logs/` under
`A4S_DAGU_DIAGNOSTICS_DIR` (CI uses runner-temp storage). Successful fixtures
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
