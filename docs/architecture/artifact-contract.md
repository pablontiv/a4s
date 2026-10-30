# Versioned issue-lifecycle artifact contract

This is the normative delivery contract for #698, not a claim that its release
workflow or station cutover is already deployed. **MUST**, **MUST NOT** and
**SHOULD** have their RFC 2119 meanings. Dagu runs the DAGs; the selected release
owns engine behavior. Repository tooling need not adopt Bun.

Source citations and the inventory below were inspected on `origin/main` at
`66bb13a`. They describe the current behavior that this contract replaces.
Activation is an operator action: a hard cutover MUST have zero
nonterminal runs and zero open role jobs (I1). Active legacy runs MUST NOT be
rewritten into this contract.

## Release and identity

Publication is **staged**, not station activation. Only the release workflow,
after CI's `validate` succeeds for the same pushed `main` SHA, MAY publish.
It checks out that SHA with full history (`fetch-depth: 0`) and computes
`r<N>`, where `N = git rev-list --count --first-parent <sha>` and the ID grammar
is `^r(0|[1-9]\d*)$`. Main MUST never be rewritten. OT1's authenticated protection
inventory records force pushes/deletions disabled, admins enforced and linear
history required; changes to that precondition require operator review.

The workflow publishes only changed shipped inputs: `packages/issue-lifecycle/**`,
`packages/hot-reload/**`, `packages/loader/**`, `packages/launcher/**`,
`scripts/build-a4s.mjs`, root `package.json` and `package-lock.json`, compared with
the last published source SHA. It builds the Bun-compiled executable and plugin
bundles for `bun-linux-x64` and `bun-darwin-arm64`, and creates tag `a4s-r<N>`
and archives `a4s-r<N>-<os>-<arch>.tar.gz`. The head MUST be a first-parent descendant
of the last published SHA; an existing ID tag at another SHA MUST fail closed.
Same-SHA reruns retain the ID and MUST match every published archive digest.
Existing tags, assets and checksums MUST NOT be overwritten. Published releases
are immutable and a4s never deletes them.

The exact tuple is `<id>@<sha40>#<digest64>`. Historical stable SemVer IDs such
as `0.7.8`, `v0.7.8` release tags and their original archive names remain
parseable, verifiable and exactly restorable; their declarations and receipts
are not rewritten. Source delivery never
writes station/service configuration; only cache-directory runtime state is
engine-owned.

Every platform archive MUST extract directly to this root, without a checkout or
an additional version directory:

```text
a4s
identity.json
package.json
bin/dagu-gate.cjs
bin/gate-cache.cjs
bin/gate-cache-run.cjs
src/                         OMP extension entries and their dependency closure
agents/plan-reviewer.md
agents/triage-reviewer.md
skills/                      seven package skills and their retained assets
```

Artifacts declaring `layout: "omp-role-runner/1"` in their identity MUST also
include root-level `role-runner.ts`. Its five OMP task/config module imports
remain external host modules, not a bundled second runtime. Inspection and
restoration MUST require that file for the declared layout, while preserving
the baseline inventory above for immutable historical artifacts without a
layout declaration. Unknown layout declarations MUST fail closed.

The artifact MUST include:

- The five DAG templates at
  `skills/issue-execution/{feature,poc,discovery,planning,reconcile}.yaml`.
- The real filesystem gate preload `bin/dagu-gate.cjs` and its adjacent
  `gate-cache.cjs` and `gate-cache-run.cjs`. Node/tsx children MUST be able to load
  them; embedding them only in Bun's virtual filesystem is insufficient.
- The two OMP extension entries declared by its `package.json`, the two package
  agents and all seven package skills. Their a4s-owned dependency closure MUST
  load from the release, never an installed source checkout. The native OMP host
  remains operator-supplied.
- Planning's template, `plan-reviewer`, the backlog-breakdown/refine/ceremony
  skills, and the discovery contract, method and five lens documents. Planning
  unit validation and reviewer/transcript identity behavior MUST be included in
  `a4s planning`; there is no separate planning-assets directory in the baseline.
  Consumer `units.jsonl`, optional `source.md`/`plan.md`, approvals and generated
  planning output are inputs or run state, not release assets.

The executable MUST provide `gate`, `pr-body`, `codeql`, `poc-scope`, `protect`,
`role-jobs`, `admit`, `enqueue`, `queue`, `observe`, `escalation`, `stale-recovery`,
`prioritize`, `reconcile` and `planning`. Python helper behavior MUST be ported,
including its locking semantics; the released engine MUST NOT depend on the old
Python helpers. Legacy CLI aliases, station installation/executor code, service
configuration templates and automatic checkout bootstrap/re-seal MUST NOT be
release execution paths. Packaged skills MUST describe the new boundary.

`a4s version` and `identity.json` MUST contain equal embedded/declared identities,
including ID, commit, `support`, exact `dispatch`/checkpoint `protocols`, canonical
`registrationManifest`, its SHA-256 `registrationManifestHash`,
`requiredLauncherProtocol` and `requiredLoaderProtocol`. The registration manifest
is computed from shared source metadata before compilation: command/tool names,
descriptions, schemas, load modes, completion surfaces, extension entries,
loader/helper API version and digests of all seven skill trees and both agents.
Equal registration hashes permit the loader transaction; a different hash
requires keeping the old generation and reporting “restart OMP”, never partial
activation. Bundles embed the build ID/commit, so each published build reloads.

`support` is uniform: each of `receipt`, `roleJobStore` (SQL schema),
`roleJobPayload` (JSON), `config`, `runState` (`.git/dagu-feature`) and `prCheckpoint`
has `{ "read": [versions], "write": version }`. Exact protocol authorization is
separate from format support, never inferred from build distance. Historical
SemVer declarations retain their original decoder. Neither identity contains
the archive digest, which would make the archive depend on its own checksum.

The launcher/state adoption contract is separate from this staged publication:
state carries `schema`; a launcher embeds its protocol and readable state schemas.
It MUST refuse unknown state schemas or a payload requiring a newer launcher
protocol with “reinstall a4s-launch”; promotion MUST skip such candidates.

After the final archive bytes exist, the workflow MUST publish their SHA-256 as a
release asset named `<archive>.sha256`, identifying that archive and its full
64-character lowercase hexadecimal digest. The digest belongs to that platform
archive, not to the tag text, executable alone or extracted directory.

### Verified source inventory

All paths in this inventory are relative to `packages/issue-lifecycle/`. Source
tooling is not an instruction to ship development wrappers in the release.

- `bin/`: `dagu-codeql.ts`, `dagu-feature-bundle.ts`,
  `dagu-feature-prioritize.ts`, `dagu-feature-protect.ts`, `dagu-gate.cjs`,
  `dagu-poc-scope.ts`, `dagu-pr-body.mjs`, `dagu-role-jobs.ts`,
  `dagu-stale-recovery.ts`, `gate-cache.cjs`, `gate-cache-run.cjs`, `heavy-slot.py`.
- `src/` top-level: `admission.ts`, `agent-directory.ts`, `artifact-cache.ts`,
  `artifact-receipt.ts`, `artifact-support.ts`, `bundle.ts`, `cli.ts`, `code-scanning.ts`, `config.ts`,
  `executable.ts`, `file-lock.ts`, `identity.ts`, `integration-protection.ts`, `long-computation.ts`,
  `materialize.ts`, `planning-validator.ts`, `poc-scope.ts`, `primary.ts`,
  `queue.ts`, `receipt-version.ts`, `registration.ts`, `release.ts`, `resources.ts`, `role-dispatch.ts`, `role-jobs.ts`, `role-runtime.ts`,
  `reconcile-run.ts`, `run-artifact.ts`, `run-primary.ts`, `stale-recovery.ts`, `transcript-identity.ts`, `type-guard.ts`.
- `src/status/`: `activity.ts`, `event-log.ts`, `index.ts`, `issue-title.ts`,
  `progress.ts`, `receipt.ts`, `reloadable.ts`, `repository.ts`, `sse.ts`.
  `src/triage/`: `guard.ts`, `index.ts`, `native.ts`, `reloadable.ts`, `run-guard.ts`, `schema.ts`.
- `extensions/` does **not** exist. The two extension entries are
  `src/status/reloadable.ts` and `src/triage/reloadable.ts`, as declared in
  `package.json`.
- `agents/`: `plan-reviewer.md`, `triage-reviewer.md`.
- `skills/`: `backlog-breakdown`, `issue-execution`, `refine`,
  `repository-discovery`, `sprint-planning`, `sprint-retrospective`,
  `sprint-review`; each contains `SKILL.md`.
  `issue-execution/` also contains the five DAG templates and adoption-only
  `dagu-feature-bootstrap.yaml`.
  `repository-discovery/` also contains `CONTRACT.md`, `METHOD.md` and
  `lenses/{0-cobertura-funcional,1-limites-de-confianza,2-integridad-y-ciclo-de-vida-de-datos,3-resiliencia-y-concurrencia,4-cadena-de-suministro-y-publicacion}.md`.

The gate preload and its two CommonJS dependencies remain real Node files.
Python heavy-slot is retained only for opt-in npm live/compiled testing, not the
guarded default lane; release templates invoke `"$A4S_BIN" heavy-slot`.

At the repository root, `scripts/release-identity.mjs` computes full-history IDs
and publication invariants; `scripts/publish-a4s.mjs` verifies CI/event/SHA,
shipped-input changes, ancestry, tag ownership and rerun digests.
`scripts/build-a4s.mjs` embeds the same source identity and registration manifest.
`.github/workflows/release.yml` is the sole staged publisher.

## Committed consumer configuration

The consumer MUST commit `.workspace/dagu/config.json`. Its payload-independent
policy reader is `packages/launcher/src/config.ts`. New admission and policy
writing require schema 2. Schema 1, including its `uses` field, remains decode-only
historical evidence and cannot admit new runs. Old builds that read only schema 1
cannot read a schema-2 consumer; promotion/rollback read coverage MUST account for that.

```json
{
  "schemaVersion": 2,
  "lane": "example",
  "baseBranch": "main",
  "gate": "npm test",
  "requiredCheck": "validate",
  "testPaths": "test",
  "rebaseResolver": "",
  "validation": "",
  "blockerReporting": "ask",
  "codeScanning": "required",
  "codeqlSecurityThreshold": "high_or_higher",
  "codeqlAlertsThreshold": "errors",
  "escalation": {
    "pushbacks": 3,
    "findings": 2,
    "seconds": 3600,
    "ciBlocked": 2,
    "pocInconclusive": 2
  }
}
```

Build selection belongs to station state, not consumer policy. Existing policy
validation and strict unknown-field rejection remain, and queue capacity is
station configuration only. Committing schema 2 makes persisted `formats.config`
include 2; rollback MUST refuse builds that cannot read it.

Admission MUST read the config bytes from consumer HEAD, record their commit and
digest, and reject uncommitted policy. The selected payload MUST validate the
owning session before receipt creation, enqueue or role-job-store mutation (I2).
Launcher-only cache restoration and its process lease precede payload execution;
they do not authorize admission. Dagu parameters MUST contain only runtime inputs
such as issue, authorized scope and
owner session; policy including base branch, gate, validation and queue capacity
MUST NOT be caller overrides. Release selection MUST NOT change consumer HEAD.
Consumer policy and release identity remain distinct facts in every new receipt.

## Station cache

The canonical cache entry is `$DAGU_HOME/cache/a4s/<version>/`, containing one
native-platform artifact. It MUST NOT be a symlink to a checkout or installation.
A caller MUST populate a missing entry in this order:

1. Download the exact resolved release archive and `<archive>.sha256`, never
   assets through the still-moving alias.
2. Verify the archive's SHA-256 against the resolved digest **before extraction**.
3. Extract into a unique temporary directory on the same filesystem as the final
   entry. Archive paths MUST remain inside that directory. Validate the required
   assets and agreement between release metadata and embedded identity.
4. Write station-generated `artifact.json` inside that temporary directory with
   exactly `{version, commit, digest, verifiedAt}`. `verifiedAt` is the successful
   verification time in UTC; `digest` is the verified archive SHA-256. A release
   MUST NOT supply this station verification record.
5. Atomically rename the complete directory to `<version>/`. No reader may see
   a partially published entry.

Publication MUST be serialized per version. If two admissions race, the first
valid publication wins; the other MUST validate and reuse it only when version,
commit and digest all match its resolved tuple. It MUST discard only its own
staging data. A different commit or digest at the same version is a conflict,
not an upgrade. Publication MUST NOT replace an existing entry.

An existing entry MUST be checked before use, not trusted because its directory
exists. Missing/malformed metadata, missing or modified payload, identity
mismatch, partial extraction or a conflicting tuple MUST fail before enqueue.
Integrity checking MUST use evidence from the verified archive; recomputing
metadata to bless changed contents is forbidden. Abandoned staging directories
are never cache entries. The engine MUST NOT silently repair/re-seal a bad final
entry or fall back to an installed checkout.

`state.json` is the one authoritative station selector, inside this cache root
only. Schema 1 is `{schema:1, generation, current, previous, rejected:[], formats}`,
where both selections are complete immutable tuples and each of the six format
keys maps to a nonempty set of persisted positive versions. Initial `previous`
equals `current`. There are no execution selector symlinks. The cache-local
`current` resource symlink is derived from this state for native skills/agents
discovery by the once-installed stable loader package; it is repaired under the
same lock on state reads and never selects execution or authorizes a lease.
The launcher, plugin loader, promotion, rollback, admission handoff and GC share
`.state.lock`; selection and lease publication occur in the same transaction.
State replacement writes a unique temporary regular file, fsyncs it, renames it
to `state.json`, then fsyncs the containing directory. **Rename is the only commit point**:
interruption before it leaves old state, after it leaves new state. A downloaded, verified but
unselected directory is inert. Neither state nor leases write station/service
configuration, DAG definitions or historical receipts.

The separately compiled `a4s-launch` embeds launcher protocol 1 and readable state
schemas `[1]`; payload `identity.json.requiredLauncherProtocol` is mandatory.
Unknown state schemas and unsupported payload protocols fail closed with
`reinstall a4s-launch`. Installing/replacing that stable binary is an operator
action, not promotion. `a4s station init --artifact <tuple>` performs the one-time,
inventory-seeded cutover; `state`, `promote` and `gc` expose the locked operations.
The operator-installed tick uses this selector without a release pin.

`promote` lists immutable release IDs above current and above every rejected ID,
walks them descending, and commits the highest that downloads, structurally
verifies and passes the compatibility and installed-launcher gates. This is not a
functional health test. A skipped newest release does not hide an eligible bridge;
launcher skew reports `launcher reinstall required`. Commit sets
`previous=old current`, `current=candidate`, and increments generation. Lower IDs
arriving late cannot move selection backward. A precommit failure changes no
state; an error after rename never falls through to another candidate.

GC holds the same global lock and keeps current, previous, the ten highest build
IDs, all process leases, all nonterminal/retryable/waiting tick bindings, every
nonterminal run in **every DAG of every registered primary**, and every open role
job resolved through its repository/run receipt. All Dagu history pages are
required; repeated cursors, unknown status, unreadable sources or an unresolved
job abort before any deletion. An artifact-bound receipt not yet listed by Dagu
is a pending admission, even when enqueue recorded an incident/ambiguous outcome;
its build is kept for five minutes after `receiptCreatedAt` (legacy
`initial.admittedAt`). At that bound an absent run no longer pins the build, but
live leases, nonterminal/recoverable runs and open jobs remain readers regardless
of receipt age. Artifact-less schema-1 receipts predate the launcher cache and
are never pending cache readers. Receipts are unchanged and their exact tuples
remain restorable after expiry. Tick binding files remain for every listed
status and are deleted only after a definitive unknown response, never an API
error. Run identity remains in receipts/bindings even after build pruning.

Leases record build, PID, host, process start identity, generation and holder.
On Linux the start identity contains `/proc` start ticks and boot ID, preventing
PID reuse or a reboot from keeping a false live reference. Loaded **and retiring**
plugin generations keep leases until OMP exits. Probes are `alive`,
`dead-or-reused`, or `unknown`: only definite absence or a changed identity frees
a lease. Unreadable probes and foreign hosts are unknown and abort GC.
Reports name retained builds and holders. Keep-ten is a cache policy, **not a disk
bound** while processes/runs hold builds (about 116 MB each).

## One-time resolution and engine handoff

`a4s` on PATH is the separately compiled, operator-installed `a4s-launch`.
Its acquisition, verification, lease and state dependency graph imports no payload
identity. Release repository and supported launcher protocol are compiled into
the launcher; an expected build identity comes only from state or a receipt/binding.
Under `.state.lock`, argv determines selection:

- `tick` uses `$DAG_RUN_ID`'s durable binding, or creates one only after confirmed
  first-attempt native Dagu evidence (see D9 below).
- An existing-run command, including an action issued by tick A for run B, uses
  B's receipt tuple and ignores A's tick binding.
- A parent admission uses its parent's receipt tuple; a new admission uses
  `state.current`.
- Read-only `state` and `rollback` are launcher operations and never load current.

Unknown state schema fails closed before current is loaded. An unsupported
payload launcher protocol fails closed with `reinstall a4s-launch`.
The launcher restores a missing exact immutable tuple or fails closed, verifies
its structure/digest/protocol, publishes a process lease under the same lock,
then `execve`s the canonical cached binary. The lease remains live through
receipt/snapshot writes, `dagu enqueue`, and all other payload work until exit.
The payload rechecks its explicit tuple; it never resolves a default again.

The selected executable MUST materialize templates only from its cache entry and
set `A4S_BIN` to that entry's absolute executable path in the immutable DAG
snapshot. Every engine invocation, including self-spawn and successor admission,
MUST use `"$A4S_BIN" <subcommand>`, not ambient legacy commands, `PATH` lookup or
an interpreter pointed at source. The engine MUST enqueue the exact admitted
snapshot bytes. The receipt MUST record the resolved tuple, the artifact's
supported contract versions, the actual dispatch/receipt/protocol/job-store versions used,
and consumer config commit/digest as distinct identity facts.

Tests MUST cover selection changing after handoff without changing the executing
tuple, target-run dispatch from a foreign tick, replay of a pruned exact tuple,
and rejection of a conflicting cache entry without substitution.

## Successor binding (I3)

Feature → PoC, PoC → feature and discovery → planning MUST pass the parent's
receipt-bound tuple and use the parent's cached executable. The launcher verifies
the parent receipt and cache, restores a missing exact immutable artifact, and
fails closed if unavailable or invalid. It MUST NOT substitute `state.current`,
even when current changed or the child's policy was newly committed.

The child MUST independently read and validate its policy from consumer HEAD,
validate its owner and record its own config commit/digest plus parent lineage.
The parent's policy snapshot MUST remain unchanged. Engine identity is inherited;
policy is freshly committed input, recorded separately. A parent artifact that
cannot understand the child's committed config MUST reject the child, not
upgrade itself to interpret it.

Tests cover parent inheritance independently of current, freshly committed child
policy, and exact restoration or failure with no enqueue on unverifiable content.

## Pinned planning-reviewer selection and rediscovery policy (U4)

This section records the verified PoC-2 result for
[#788](https://github.com/pablontiv/a4s/issues/788) and the selection adopted for
[U4 / #795](https://github.com/pablontiv/a4s/issues/795). The
[published PASS and retained-evidence inventory](https://github.com/pablontiv/a4s/issues/788#issuecomment-6515034373)
are the evidence authority. Evidence root `E` is
`<git-dir>/poc/runs/poc-a4s-issue-788/computations/pinned-agents/`, where
`<git-dir>` is the primary repository's common Git directory, not a worktree's
`.git` pointer. `E/summary.json` records both native review results and the
rediscovery matrix; `E/identities.json` records the exercised binary identities.
These are retained local evidence, not release assets.

### Selected native cached-build mechanism

U4 selects native OMP startup loading with **`-e <run-cached-build>`**, pointing
at the run's complete cached package root before invoking native `task` with
`agent: "plan-reviewer"`. With compiled OMP **18.14.0**, the fixture parent
loaded cached build A this way while the isolated plugin registry linked newer
build B. Native discovery reported source `user`; the unchanged agent name
returned schema-valid `SENTINEL=A`, and its child `session_init` contained A's
instruction, not B's. A project `.omp/agents` symlink to A's agents directory
independently passed with source `project`; it is an observed alternative, not
the selected production mechanism. Native `task` exposed name-based selection;
no definition-file selector was established, and `taskFile` is assignment input,
not agent-definition loading.

Both a4s-shipped agent definitions MUST be pinned to the run's cached artifact.
For interactive planning review, U4 MUST establish that run-scoped native
discovery context before the name-based launch, rather than resolving the
reviewer from the currently linked registry. This does not establish that `-e`
can be injected into an already-running session. Role-job definition loading is
the separate PoC-3/D16 boundary. The native OMP builtin `task`, station OMP
binary, settings and model routing remain shared, not run-pinned.

The `plan-reviewer` declaration **`model: "@slow"`**, its structured schema and
read-only tools MUST be preserved, with station overrides and routing enabled.
Neither fixture task call supplied `model`. Copied station settings contained no
`plan-reviewer` model override and resolved `@slow` to
`anthropic/claude-fable-5-1`; unmodified `@a4s/review-routing` 0.3.1 remained
enabled. Both completed children and their actual assistant messages recorded
that Anthropic provider/model, distinct from the parent's
`openai-codex/gpt-6.1-sol`. Native progress recorded `modelRole: slow`,
`resolvedModelIsFallback: false` and route
`strict cross-family eligibility; effective transcript identity must pass the publication gate`.
Pending resolution had thinking `:high`; native automatic classification
completed at `:low`. Acceptance MUST check the actual child transcript
provider/model against native resolved task metadata and record the effective
routing/override resolution, not compare the literal alias `@slow` with a model
ID. The sources are `E/project-pinned.rpc.jsonl`,
`E/extension-pinned.rpc.jsonl`, their children under `E/native-sessions/`, and
`E/observer.jsonl` plus `E/routing-config.txt`.

### Version-qualified rediscovery policy

Interactive skills follow `state.current`, but changing the linked/current
build is **not immediate rediscovery**. In the exercised OMP 18.14.0 session:

| Change | Immediately after relinking | After `/reload-plugins` | After restart |
| --- | --- | --- | --- |
| B → C, skills-only | Old skill list | New skill list | New skill list |
| C → D, agents-only | Old agent catalog | Old agent catalog | New agent catalog |

The immediate and reload observations retained the same PID and session; fresh
processes inspected C and D independently. `E/summary.json` and the
`E/retry-*.state.json`, `E/retry-*.commands.json` and
`E/retry-rediscovery*.rpc.jsonl` files retain the full lists and identities.
This measures advertised catalogs, not whether an unadvertised agent name could
already execute. Reload-only agent refresh is **not established**.

U4 MUST record skill and agent manifest digests to detect changes rather than
treat relinking as a refresh acknowledgment. An agent digest change requires a
restart prompt: the conservative manifest-digest-plus-restart policy is justified
by this evidence. A skills-only change can refresh through `/reload-plugins` on
the exercised binary; it MUST NOT be described as automatic hot rediscovery or
assumed for unexercised OMP versions.

### Proof boundary and production ownership

The PASS proves fixture-level native discovery, provider execution, routing and
catalog refresh behavior. `poc-planning-a` had an A-bound fixture manifest; no
real Dagu admission, enqueue, human task, cancellation or lifecycle completion
was exercised. It does not prove production run-to-cache admission or integration
with an existing interactive coordinator. **#788 changes architecture
documentation only. U4 / #795 owns lifecycle integration, production cutover and
its end-to-end acceptance**, using the mechanism and policy recorded here.

The U4 source integration passes the cached build root from the planning DAG's
`check_plan` output into review instructions. An already-running coordinator
resumes the same parent session with `omp --no-extensions -e <run-cached-build>
--session <parent-session-file>` before the name-based review; it never
substitutes a `taskFile` for the definition or edits station routing. D16 role
jobs continue passing the cached triage-reviewer definition directly to the
native runner. `packages/loader` gates skill **and** agent digests conservatively:
either change keeps behavior on the old generation and requests OMP restart.
The cache-only resource pointer follows `state.current`; native catalog refresh
is acknowledged at restart, not inferred from relinking. The historical PoC
claims above remain limited to their retained receipts.


## Compatibility and a shared station (I6)

Build identity, dispatch protocol and shared data formats are separate axes.
Uniform read/write declarations replace fixed format-version assertions; exact
protocol IDs stay mandatory. Receipts preserve the declaration and actually
used contracts; unknown or missing declarations are not compatibility.

At activation cutover, inventory persisted receipts, role-jobs.sqlite, run state
and committed configs to seed `state.formats`. For each format it contains every
version written by any activated build, and never shrinks. A candidate or rollback
target MUST read that entire set plus its own writer. Every live reader MUST read
the candidate writer: leases, nonterminal tick bindings/runs, pending runs/open
jobs, loaded and retiring plugin generations, and the post-promotion previous
(old current) all count. A displaced previous counts only when otherwise live.
Dropping persisted read support requires a migration (out of scope).
A format change therefore requires a bridge build reading old+new while writing
old, then a build writing new. Completed jobs/history are not silently migrated.
The persisted set is an inventory, not just a maximum: reading the newest version
does not excuse missing a retained lower decoder. Failed promotions and rollbacks
leave it unchanged; successful activation unions in every declared writer. A
retired pre-bridge plugin remains a live reader until OMP exits, so idle reload
cannot unblock a new-format writer. The blocking report names its lease holder
PID and generation and the remedy **restart OMP**. After bridge N is active and
old readers have drained, writer N+1 can activate even if displaced previous is
pre-N: no third bridge is required.

Current admissions write receipt `schemaVersion: 2` in
`packages/issue-lifecycle/src/admission.ts`. Observation readers accept versions 1
and 2 in `packages/issue-lifecycle/src/receipt-version.ts`; version 1 read support
preserves historical reporting, not permission to continue legacy runs. This read
compatibility neither waives I1 nor supplies missing artifact identity.

The artifact contract uses dispatch protocol `a4s-run/1`, config schema 2 for
new admissions (schema 1 for historical decoding), receipt schema 2, role-job-store contract 1, and checkpoint protocols `triage=role-job/1`,
`implement=role-job/1`, `publication=pr-checkpoint/1`. A receipt lacking the full
artifact tuple or required contract declarations MUST be rejected even if its
numeric schema version is otherwise supported. Legacy receipts MUST NOT be
upgraded by reconstructing a digest from a checkout or the current tag.

Before enqueue or opening a store writer, the selected executable MUST reject an
unsupported receipt schema, unsupported/mismatched required protocol, unsupported
job-store version or artifact/receipt identity mismatch. Read-only observation
MAY report an unsupported record, but MUST NOT interpret it as permission for a
state-changing action. Unsupported data MUST NOT trigger an implicit migration.

Dispatch support is declared as top-level `dispatch` in new `a4s version` and
`identity.json`, and selected in `contracts.dispatch` in each receipt. The
historical decoder accepts `support.dispatch`/`artifactSupport.dispatch` unchanged.
The minimum historical dispatchable artifact is
v0.7.0, shipping #713's receipt-bound `run` boundary. Earlier artifacts, including
v0.6.0, do not declare `a4s-run/1` and are unsupported even when their other
contracts match. Reject them before invocation with the missing boundary named;
never probe an older executable by trial, add a fallback, infer support from
SemVer, or upgrade a historical receipt. #714 requires no nonterminal pre-#713
runs or open role jobs at cutover.

All versions MUST use the same `$DAGU_HOME/role-jobs.sqlite` and v1 job/result
JSON documents, preserving canonical bindings, claims and the shared capacity
policy. There MUST NOT be a per-artifact store, capacity domain or incompatible
schema migration. Store v1 and document v1 are established at
`packages/issue-lifecycle/src/role-jobs.ts:19` and
`packages/issue-lifecycle/src/role-jobs.ts:60`.

Two cached releases MAY serve different live runs concurrently. Each run and its
children remain bound to their own tuple, while both releases honor that same
store contract. The OMP plugin MUST use declared dispatch/receipt/protocol compatibility
and dispatch mutations through the run's artifact; equality with the plugin's
package version is not authority to execute a run. Existing exact-version role
dispatch at `packages/issue-lifecycle/src/role-dispatch.ts:143` is replaced by this
boundary. The baseline protocol IDs are at
`packages/issue-lifecycle/src/bundle.ts:5`; notice-only SemVer classification at
`packages/issue-lifecycle/src/bundle.ts:57`, stamp parsing at
`packages/issue-lifecycle/src/bundle.ts:86` and protocol inference at
`packages/issue-lifecycle/src/bundle.ts:134` MUST NOT select or authorize an
artifact. The legacy stamp parser/inference paths MUST be removed at cutover.

## Pinned station reconciliation (I4)

The operator installs `packages/launcher/reconcile.yaml`: one scheduled step,
`a4s tick`, with no A4S_BIN/A4S_ARTIFACT/version literal. Dagu does not forward
`A4S_*` service variables to steps, so the operator's installed copy adds one
DAG-level `env` entry, `A4S_SERVICE_ENV: <absolute declaration>`. The launcher selects
`state.current` for a fresh tick only after native Dagu confirms its first
attempt, and durably writes `ticks/<dagRunId>.json` =
`{dagRunId, tuple, createdAt}` under the state lock before exec. Retry reads that
binding, including after promotion or cache pruning; a missing retry binding or
unreadable attempt history fails closed, never repins. A tick selected as A stays
A through its own promote to B; the next fresh tick selects B.

The payload tick promotes, reconciles, then collects cache entries. Every per-run
action uses that run's receipt tuple, not the tick's tuple. Missing exact releases
and unsupported receipts leave that run untouched and report a failure; other
compatible runs can proceed. Tick bindings outlive cache retention while native
Dagu can replay the run. Pruned tuples are restored from the immutable release
or fail closed if unreachable.

The boundary MAY execute package-independent inspect/finish actions in-process
only when the run's exact tuple equals the executing tick's binding, the
embedded identity matches, and the executing binary is the verified cached
executable or has identical verified executable bytes. Version/commit equality
alone MUST NOT authorize this optimization. Foreign tuples or different bytes
MUST still invoke the run's own cached executable. The boundary MUST re-read and
authorize each receipt before every action, bind the run's environment for the
action, and restore the station environment afterward. Full cache verification
MAY be shared by exact tuple within one tick; it MUST NOT persist across ticks or
plugin actions. This is a verified same-artifact dispatch, not substitution by
the reconciler's release.

The operator owns the schedule, queue configuration, service installation and
cutover. a4s MUST only check/report station readiness; it MUST NOT write Dagu's
service/configuration, adjust queue concurrency, install/rewrite the scheduled
DAG or restart the service. Writing verified cache/run state and using the shared
job store do not grant station-configuration authority. Installing the OMP plugin
from an explicit release is likewise an operator deployment action.

### First-attempt confirmation for tick bindings (D9; U3)

The [published #790 PASS](https://github.com/pablontiv/a4s/issues/790#issuecomment-6514998747)
retains native Dagu **2.24.0** observations for a fresh enqueued run, a same-ID
retry after binding removal, and unavailable API / pruned history. The positive
discriminator for the exercised enqueue/retry path is
`dagRunDetails.triggerType` from
`GET /api/v1/dag-runs/<name>/<dagRunId>`, not an attempt-history count:

| Case | Observed native detail | Binding-creation interpretation |
| --- | --- | --- |
| Fresh `dagu enqueue` | HTTP 200, `triggerType: "manual"` | Positively confirmed fresh execution for this path |
| Same-ID `dagu retry` after deleting its successful binding | HTTP 200, `triggerType: "retry"` | Retry; missing binding MUST NOT select current anew |
| Same-ID retry while the API was stopped | Controller and step both received `URLError: Connection refused`; recovered detail reported `"retry"` | Unknown while unavailable; fail closed |
| History removed with native `dagu rm --history --force` | HTTP 404 `not_found`; native `status` and `retry` exited 1; history was `[]`, no step executed | Unknown/unavailable record, not a fresh execution |

There is no native `first/retry/unknown` enum: a failed or unavailable detail read
is the unknown input. Transport errors, failed lookups (including 404), invalid
detail responses, and missing or unverified trigger values MUST remain unknown
and fail closed. Absence of history MUST NOT be used to infer “first”; the pruned
run's detail error was identical to the pre-enqueue not-found error.

[U3 (#794)](https://github.com/pablontiv/a4s/issues/794) owns launcher enforcement;
this PoC changes no runtime code. For a missing `ticks/<dagRunId>.json`, its
launcher MUST allow a positively confirmed fresh tick to bind the selected tuple
under the lock before exec, and MUST reject retry or unknown inputs rather than
selecting current anew. A retry with an existing binding MUST run its recorded
tuple, even if current changed or cannot start. The disposable probe wrote a
binding on success; it did not demonstrate production launcher enforcement.

Raw evidence remains at
`<git-dir>/poc/runs/poc-a4s-issue-790/computations/first-attempt/`:
`01-fresh-running.api.json`, `02-retry-running.api.json`,
`02-retry.binding-loss.json`, `03-offline-running.api.json`,
`03-offline-recovered-detail.api.json`, `04-pruned-detail.api.json`,
`04-pruned-status.cli.json`, and `04-pruned-retry.cli.json`. The three complete
step environments and step-side API results are retained in `observations/`;
`execution-record.json` and `native-{before,after}-prune.tar.gz` retain command
records and native storage. The published PASS records their provenance and
archive hashes.

This result does not establish a first-ever ordinal after deletion and
recreation of the same run ID. A cron-scheduled trigger value was not exercised;
duplicate-ID rejection was source-inspected, not live-tested. History removal
was explicit, not an observation of age-based retention. Ordinary CLI status and
step identity variables did not distinguish fresh from retry; `autoRetryCount`
and node `retryCount` were zero in both. The attempted nested `/attempts` route
returned 404 even for an existing run. Supported event logs lagged an active
attempt and survived history removal, so absent events or list length MUST NOT
be treated as proof of complete history or permission to create a binding.

## Failures and recovery

- **Unavailable exact release/platform or failed download:** fail closed before
  payload execution. Restore release access and retry the same tuple; never infer
  an artifact from an installed package or repin a retry.
- **Checksum mismatch or incomplete archive:** do not extract/publish unverified
  data. Discard the admission's staging data; recover only by obtaining the exact
  immutable archive with the expected digest.
- **Corrupt, partial or conflicting final cache entry:** stop before enqueue or
  store mutation. Report the expected and observed identity. Operator recovery
  MUST preserve active references and restore only the identical verified
  artifact; never overwrite a live entry or manufacture fresh metadata for it.
- **Handoff identity mismatch:** fail without re-resolution or another handoff.
  Correct the release/cache selection externally; a different artifact requires
  a new root admission, not a rewritten receipt.
- **Missing parent/run artifact:** restore the exact immutable release tuple
  before child admission, recovery or reconciliation. If the release cannot be
  reached or verified, fail closed. A moved tag, current or the tick's release
  is never a substitute for the recorded tuple.
- **Invalid/uncommitted policy, invalid owner or unsupported contracts:** reject
  before runtime mutations. Commit compatible policy, restore the rightful owner
  or deploy a compatible artifact through the authorized cutover; do not weaken
  validation, migrate the shared store or add a legacy alias.
- **Station not ready:** report the missing readiness/configuration prerequisite.
  The operator fixes it; a4s MUST NOT repair station configuration or restart it.
- **Bad published release:** the stable launcher owns `a4s-launch rollback`, so
  recovery does not start the broken current payload. It selects previous only
  when that target reads every persisted format version plus its own writer,
  appends the bad current ID to `rejected`, and increments generation atomically.
  The target remains previous too; rollback cannot bounce into the rejected build.
  It may be refused even after every newer writer's run finishes, because
  persisted history does not disappear. Future promotion requires an ID greater
  than every rejected ID; publish a revert merge with a new ID rather than moving
  tags or rewriting assets/checksums/receipts. Existing runs retain their tuples.
- **Unknown process identity, unreadable inventory or launcher skew:** preserve
  state, leases, bindings and builds. Restore read access/API availability or
  reinstall a compatible stable launcher under operator authority. Do not delete
  leases on `ps` failure or replace persisted-format sets with observed maxima.
