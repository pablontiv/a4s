# Single-host ownership and process-turnover proof

Run from the repository root with Node 26 (uses built-in `node:sqlite`; no install):

```sh
node poc/temporal-omp/ownership/probe.mjs poc/temporal-omp/ownership/evidence.json
```

`authority.mjs` is reusable local authority storage. `process.mjs` supplies isolated owner, detached child, and replacement process roles. `probe.mjs` coordinates only its own processes, writes sanitized `evidence.json`, and removes temporary SQLite databases and gates. No Temporal server or OMP credentials are needed.

## Contract

- `LeaseAuthority(path)` opens a local SQLite database using WAL, FULL synchronous commits, and a busy timeout.
- `acquire(mandateId, ownerId, ttlMs)` exclusively increments the persisted generation; an active lease prevents takeover. Release retains the generation rather than deleting it. A released or expired holder cannot renew itself.
- `current(mandateId)` returns a snapshot, **not** an atomic acceptance capability. Safety's `validateReceipt(raw, expected, evidence, currentGeneration)` may use the snapshot for validation, but final local acceptance must go through `commit`.
- `commit(lease, kind, binding, payload, validate?)` uses the same `BEGIN IMMEDIATE` transaction as acquisition to check generation, owner, expiry, and running attempt before inserting a local accepted result/effect record. An optional trusted synchronous validator must return void or throw; it receives current authority inside the write transaction. Async validators are forbidden. Expiry is checked again after validation. The binding shape is `{mandateId,itemId,stage,attempt,revision,generation}`. The process fixture supplies actual repository HEAD as its 40-hex revision. This module owns lease/attempt authority, not receipt schema or independent Git evidence validation.
- `commit` deduplicates under the same write lock by `(mandate, generation, kind, six-field binding)`. Binding fields are serialized in fixed order; payload identity is exact `JSON.stringify` equality, so reordered payload keys conservatively conflict rather than silently accept. An identical existing payload is observed without insertion, including after `complete` while the same lease remains authoritative; a different payload throws `conflicting-delivery`. Released, expired, or superseded leases remain rejected even for duplicates. This uses the existing schema and does not retroactively repair historical duplicate records or authorize direct SQL writers. `complete` rejects a binding from another mandate before updating attempts.
- `beginAttempt(lease, itemId, maxAttempts)` persists a new attempt only for a new owning generation; the same generation cannot relaunch an in-flight attempt, the attempt bound survives turnover, and completed items return `done` without relaunch. Call `complete` only after independently establishing successful completion.
- `deliver` puts untrusted child messages into an inbox. Inbox presence is not acceptance or permission to execute an effect.

## Actual scenarios

The probe waits for the child to announce it is in flight, kills its owner with SIGKILL, waits for lease expiry, and launches a replacement process. Only after replacement acquisition does it release the surviving child to deliver its old binding. The replacement rejects both old result and old effect records and accepts only its current-generation records. The replacement allocates attempt 2, bounded by a persisted maximum of 2. A separate normal child finishes and its owner exits with code 0; the next owner sees `done`, attempt 1, rather than starting a child. A close/reopen confirms generation and completion durability. Concurrent live-lease acquisition is also refused.

### Connected Safety receipt gate

```sh
node poc/temporal-omp/ownership/receipt-probe.mjs poc/temporal-omp/ownership/receipt-evidence.json
```

`receipt-gate.mjs` imports Safety's existing `validateReceipt` without changing its exports. It validates a receipt using current authority inside `commit`'s synchronous callback, so generation validation and local accepted-record insertion share the acquisition write lock. `receipt-probe.mjs` creates an actual temporary Git working repository and bare remote, commits and pushes a file, and obtains independent evidence with Safety's `observeGitEffect`. It rejects an old lease, an old receipt submitted using the new lease, and incomplete evidence, leaving zero accepted rows. A valid current-generation receipt with `completion:false` then produces exactly one accepted row. The revision is the actual temporary repository commit SHA, not a synthetic identifier. All repositories and SQLite files are removed after the run.

The connected probe also redelivers the identical receipt through a second SQLite connection and checks that only one accepted record remains. A conflicting but otherwise valid receipt (`completion:true`) is rejected. It repeats duplicate/conflict checks after completion, and proves a wrong-mandate completion is rejected without changing the running state before the correct completion succeeds.

Git observation occurs outside the SQLite transaction and is point-in-time evidence. This connected local receipt gate is not an atomic Git-plus-SQLite operation, an all-engineering-gates integration, or external-effect fencing.

## pi-temporal source reuse

Inspected the opensrc cache for `github.com/temporalio/pi-temporal@main` (`package.json` version 0.2.0), specifically `src/tree/lease.ts:1-150` and the scenario descriptions in `checks/lease-check.mts`, `checks/lease-recovery-check.mts`, and `checks/fence-check.mts`. The cache is an exported source tree without Git metadata, so its exact commit was not recoverable through `git rev-parse`.

Reused its invariants: monotonically increasing epochs retained after release; ownership checked at the actual mutation boundary; late living attempts never recover their former authority. Its directory/mtime lease supports a different filesystem storage domain and exposes a check-before-write API. Importing it would not make SQLite acceptance atomic, so this implementation uses SQLite's existing transaction primitive rather than copying that lease algorithm. No upstream code is vendored and no previous upstream probe suite is rerun.

## Boundaries, not deployment claims

- This is an actual generic Node process-loss proof. **Native OMP session-supervisor recovery, OMP host restart, session reattachment, and OMP-managed child recovery remain unproven here.** No shared OMP host is killed. A future native proof must use an owned isolated host supplied by the OMP slice, not relabel these process fixtures.
- The accepted effect is a local database record. No exactly-once external effect or fully fenced backend is claimed. A pre-dispatch lease check cannot revoke already-launched effects or close the dispatch/backend race. Remote Git pushes need an independent backend/reconciliation protocol.
- The connected receipt probe exercises Safety validation and local ownership acceptance together. Atomic generation fencing applies only to the SQLite record transaction; observed Git state can change before acceptance.
- SQLite must be on a local filesystem with working locks and fsync. Network filesystems, multiple hosts, hostile DB access, host power loss, filesystem faults, and clock discontinuities are not tested. TTL uses the shared host wall clock and assumes it is stable. SIGKILL proves process-crash turnover, not arbitrary hardware crash behavior.
- The 600ms lease and 100ms heartbeat are controlled-probe parameters, not operational defaults. The 6s runner deadlines are bounded probe failure detection.
