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

Only the repository's tag workflow, running on `v<semver>`, MAY produce a release.
It MUST build one `a4s` executable with `bun build --compile` for each advertised
OS/architecture pair and publish an immutable archive named
`a4s-v<semver>-<os>-<arch>.tar.gz`. A version is the complete SemVer without the
leading `v`; a commit is the full source commit ID. Examples such as `v0.6.1`
illustrate names, not release availability.

The workflow MAY advance the moving major tag `v0` to a published `v0.x.y`
release. That alias selects an immutable release; it MUST NOT identify mutable
archive contents or become the version recorded in a receipt. An existing exact
tag, release archive or checksum MUST NOT be rewritten, including by a workflow
rerun. An ambiguous alias-to-release mapping MUST be rejected.

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

`a4s` MUST embed its version, commit and explicit supported dispatch,
receipt-schema, checkpoint-protocol and role-job-store versions. `identity.json` MUST declare the
same identity and support information for inspection without executing the
binary. Support MUST be explicit versions/protocol IDs, not a SemVer-distance
heuristic. Both identity declarations MUST NOT contain the archive digest: that
would make the archive depend on its own checksum.

After the final archive bytes exist, the workflow MUST publish their SHA-256 as a
release asset named `<archive>.sha256`, identifying that archive and its full
64-character lowercase hexadecimal digest. The digest belongs to that platform
archive, not to the tag text, executable alone or extracted directory.

### Verified source inventory

All paths in this inventory are relative to `packages/issue-lifecycle/`. Source
tooling is not an instruction to ship development wrappers in the release.

- `bin/`: `dagu-bundle-rebase.mjs`, `dagu-codeql.ts`, `dagu-feature-bundle.ts`,
  `dagu-feature-prioritize.ts`, `dagu-feature-protect.ts`, `dagu-gate.cjs`,
  `dagu-poc-scope.ts`, `dagu-pr-body.mjs`, `dagu-role-jobs.ts`,
  `dagu-stale-recovery.ts`, `gate-cache.cjs`, `gate-cache-run.cjs`, `heavy-slot.py`.
- `src/` top-level: `admission.ts`, `agent-directory.ts`, `artifact-cache.ts`,
  `artifact-receipt.ts`, `bundle.ts`, `cli.ts`, `code-scanning.ts`, `config.ts`,
  `executable.ts`, `file-lock.ts`, `identity.ts`, `integration-protection.ts`, `long-computation.ts`,
  `materialize.ts`, `planning-validator.ts`, `poc-scope.ts`, `primary.ts`,
  `queue.ts`, `receipt-version.ts`, `release.ts`, `resources.ts`, `role-dispatch.ts`, `role-jobs.ts`, `role-runtime.ts`,
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
Python heavy-slot is retained only for npm development tooling; release templates
invoke `"$A4S_BIN" heavy-slot`.

## Committed consumer configuration

The consumer MUST commit `.workspace/dagu/config.json`. Its policy reader is
`packages/issue-lifecycle/src/config.ts`; there is no legacy file/module alias.
Configuration `schemaVersion: 1` is independent of the artifact's version and of
the receipt schema. `uses` is a required top-level sibling of the existing policy
fields, not a replacement for them and not a nested policy object:

```json
{
  "schemaVersion": 1,
  "uses": "a4s@v0",
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

`uses: "a4s@v0"` selects the moving major; `uses: "a4s@v0.6.1"` selects an exact
release. Arbitrary branches, paths, URLs, unqualified versions and range syntax
MUST be rejected. A schema-1 reader predating this addition rejects `uses` as an
unknown field; keeping schema version 1 does not make that reader compatible.
Migration MUST update the reader and committed config together.

Existing policy fields and their validation remain, except that
`queueConcurrency` MUST be removed: queue capacity is station configuration only
(D5). There is no consumer override or implicit queue-repair operation. The
baseline schema and strict unknown-field rejection are at
`packages/issue-lifecycle/src/config.ts:30` and
`packages/issue-lifecycle/src/config.ts:109`.

Admission MUST read the config bytes from consumer HEAD, record their commit and
digest, and reject uncommitted policy. It MUST validate the owning session before
cache writes, receipt creation, enqueue or role-job-store mutation (I2). Dagu
parameters MUST contain only runtime inputs such as issue, authorized scope and
owner session; policy including base branch, gate, validation and queue capacity
MUST NOT be caller overrides. Release selection MUST NOT change consumer HEAD.
The committed-policy precedent is
`packages/issue-lifecycle/src/config.ts:219`; the baseline policy-parameter
filter being replaced is `packages/issue-lifecycle/src/admission.ts:165`.

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

Entries MUST be retained while referenced by any nonterminal run, including
queued, waiting or recoverable runs, and while an associated role job is open.
The pinned station reconciler also requires its entry to remain present.
Retention and publication MUST be coordinated with admission so that an entry
cannot disappear between selection and recording a run reference. Incomplete
reference discovery MUST prevent pruning. Removing an otherwise unreferenced
entry is operator-owned; cache population is runtime state, not service setup.

## One-time resolution and engine handoff

For a new root run, the caller MUST resolve committed `uses` once to the tuple
`(version, commit, digest)`, ensure that exact cache entry, then replace itself
with the selected executable:

```sh
exec "$DAGU_HOME/cache/a4s/<version>/a4s" admit \
  --artifact '<version>@<commit>#<digest>' ...
```

`...` denotes the admission's runtime inputs, not extra policy. The tuple is an
explicit trusted handoff input, not a Dagu policy parameter. The selected
executable MUST compare version and commit with its embedded identity and digest
with verified cache metadata. Any disagreement MUST fail before receipt/store
mutation or enqueue. In this explicit-artifact mode it MUST NOT resolve `uses`,
follow `v0`, consult a source checkout or hand off again.

The selected executable MUST materialize templates only from its cache entry and
set `A4S_BIN` to that entry's absolute executable path in the immutable DAG
snapshot. Every engine invocation, including self-spawn and successor admission,
MUST use `"$A4S_BIN" <subcommand>`, not ambient legacy commands, `PATH` lookup or
an interpreter pointed at source. The engine MUST enqueue the exact admitted
snapshot bytes. The receipt MUST record the resolved tuple, the artifact's
supported contract versions, the actual dispatch/receipt/protocol/job-store versions used,
and consumer config commit/digest as distinct identity facts.

This replaces checkout identity and installed-template materialization at
`packages/issue-lifecycle/src/materialize.ts:41` and
`packages/issue-lifecycle/src/materialize.ts:81`, and installed-package equality
at `packages/issue-lifecycle/src/admission.ts:205`. Exact snapshot enqueue at
`packages/issue-lifecycle/src/admission.ts:312` remains a required property.

**Test obligation:** move `v0` from release A to B after resolution but before
handoff. The executable, templates, receipt and all spawned engine work MUST
remain A, with exactly one ref resolution and no second handoff. A conflicting
cache entry MUST reject the same admission rather than switch it to B.

## Successor binding (I3)

Feature → PoC, PoC → feature and discovery → planning MUST pass the parent's
receipt-bound tuple and use the parent's cached executable. The child MUST
verify the tuple against the parent receipt and the cache; an unchecked caller
value is not inheritance. It MUST NOT resolve a ref, select the current default,
or substitute another artifact if the parent artifact is missing or invalid.
This applies even if the child's committed `uses` now names another release.

The child MUST independently read and validate its policy from consumer HEAD,
validate its owner and record its own config commit/digest plus parent lineage.
The parent's policy snapshot MUST remain unchanged. Engine identity is inherited;
policy is freshly committed input, recorded separately. A parent artifact that
cannot understand the child's committed config MUST reject the child, not
upgrade itself to interpret it.

The ambient successor calls being replaced are
`packages/issue-lifecycle/skills/issue-execution/feature.yaml:423`,
`packages/issue-lifecycle/skills/issue-execution/poc.yaml:561` and
`packages/issue-lifecycle/skills/issue-execution/discovery.yaml:342`.
Tests MUST cover each transition after the tag moves, a changed child policy and
missing parent cache content, with nothing enqueued on failure.

## Compatibility and a shared station (I6)

Artifact SemVer, dispatch protocol, config schema, receipt schema, checkpoint
protocols and job-store contract are separate version axes. Every artifact MUST
explicitly declare its dispatch boundary, which receipt schemas it reads and
writes, which protocol IDs it serves at each checkpoint, and which role-job-store
versions it supports. Receipts MUST preserve
that declaration as well as the selected versions; unknown or missing declarations
are not compatibility.

Current admissions write receipt `schemaVersion: 2` in
`packages/issue-lifecycle/src/admission.ts`. Observation readers accept versions 1
and 2 in `packages/issue-lifecycle/src/receipt-version.ts`; version 1 read support
preserves historical reporting, not permission to continue legacy runs. This read
compatibility neither waives I1 nor supplies missing artifact identity.

The artifact contract uses dispatch protocol `a4s-run/1`, config schema 1, receipt
schema 2, role-job-store contract 1, and checkpoint protocols `triage=role-job/1`,
`implement=role-job/1`, `publication=pr-checkpoint/1`. A receipt lacking the full
artifact tuple or required contract declarations MUST be rejected even if its
numeric schema version is otherwise supported. Legacy receipts MUST NOT be
upgraded by reconstructing a digest from a checkout or the current tag.

Before enqueue or opening a store writer, the selected executable MUST reject an
unsupported receipt schema, unsupported/mismatched required protocol, unsupported
job-store version or artifact/receipt identity mismatch. Read-only observation
MAY report an unsupported record, but MUST NOT interpret it as permission for a
state-changing action. Unsupported data MUST NOT trigger an implicit migration.

Dispatch support is declared as `support.dispatch` in `a4s version` and
`identity.json`, preserved in `artifactSupport.dispatch`, and selected in
`contracts.dispatch` in each receipt. The minimum dispatchable artifact is
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

The station's scheduled reconciler MUST be operator-pinned to an explicit exact
release and tuple, not `v0`, `latest`, a mutable checkout or an ambient command.
Its tick MUST read each run's receipt and dispatch every per-run action through
that run's own cached `a4s` with its recorded tuple. Its own release MUST NOT
replace the run's artifact. Missing artifacts or unsupported receipts MUST leave
the affected run untouched and report the failure; other compatible runs MAY
still be dispatched. The baseline scheduled ambient recovery call is
`packages/issue-lifecycle/skills/issue-execution/reconcile.yaml:14`.

The boundary MAY execute package-independent inspect/finish actions in-process
only when the run's exact tuple equals the reconciler's operator pin, the
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

## Failures and recovery

- **Unresolvable/ambiguous ref, unavailable platform or failed download:** reject
  admission before enqueue. Restore release access or commit a valid `uses`, then
  begin a new root admission; do not infer an artifact from an installed package.
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
- **Missing parent/run artifact:** fail closed for child admission, recovery and
  reconciliation. The operator MAY restore the exact parent archive by its
  recorded tuple and verified checksum, then retry the original action. Neither
  a moved tag nor the station reconciler's release is a substitute.
- **Invalid/uncommitted policy, invalid owner or unsupported contracts:** reject
  before runtime mutations. Commit compatible policy, restore the rightful owner
  or deploy a compatible artifact through the authorized cutover; do not weaken
  validation, migrate the shared store or add a legacy alias.
- **Station not ready:** report the missing readiness/configuration prerequisite.
  The operator fixes it; a4s MUST NOT repair station configuration or restart it.
- **Bad published release:** supersede it with a new exact version and advance
  `v0` only for future root admissions. Existing runs MUST retain the original
  tuple, or be explicitly terminated by their authorized owner before replacement
  runs are admitted. Tags, assets, checksums, receipts and cached artifacts MUST
  NOT be rewritten to disguise an in-place upgrade.
