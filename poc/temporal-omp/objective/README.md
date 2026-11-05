# Bounded objective controller — real Temporal command bootstrap

This standalone probe runs a TypeScript objective workflow on a **real Temporal server**. It is not an interactive OMP host replacement or proof of native OMP turns, context continuity, task tools, or reload behavior. Every activity receipt explicitly says `bootstrap_command_activity` and `nativeHostProof: false`.

## Prior implementation boundary

The inspected opensrc reference is `temporalio/pi-temporal` package version 0.2.0 (MIT), locally cached at `/home/pones/.opensrc/repos/github.com/temporalio/pi-temporal/main`; the cache has no upstream Git commit metadata, so no exact commit is claimed. Its `src/pi/local-turn-workflow.ts` separates a sandbox-safe workflow and typed `LocalActivities`, uses `proxyActivities`, and binds real host turns to a private process queue. This objective probe follows that workflow/activity separation using SDK 1.25.0 rather than copying its host-turn implementation (the reference declares SDK ~1.24.0). No source code is vendored from pi-temporal in this slice. Its private live-turn API cannot honestly serve as the command bootstrap's native-host proof; that responsibility remains the separate interactive OMP slice.


## Run

Node and npm are required. The pinned Temporal TypeScript SDK is 1.25.0. The initial observed runtime was Node 26.13.0 against the sibling SQLite-backed Temporal server 1.32.2.

```sh
cd poc/temporal-omp/objective
npm ci --ignore-scripts --no-audit --no-fund
npm run proof
```

The runner connects to `TEMPORAL_ADDRESS` (default `127.0.0.1:17233`) and `TEMPORAL_NAMESPACE` (default `default`). It registers that namespace only if absent. It does not launch an alternative environment or mock service. `OBJECTIVE_WORKFLOW_ID` and `OBJECTIVE_EVIDENCE_DIR` may select a unique execution ID and new evidence directory; do not reuse evidence directories. Main owns the server lifetime. The runner stops only its own worker/connections.

## Interface and behavior

`workflows.ts` exports `objectiveWorkflow(ObjectiveInput)` and the query `objectiveState`. Input contains a mandate ID, revision, generation, and 1–32 items with unique IDs, bounded dependency lists, a fixed operation (`inventory` or `validate-inventory`), and optional bounded named blockers. Bindings are `{mandateId,itemId,stage,attempt,revision,generation}`. Activities expose `recordState(snapshot)` and `executeBoundItem(binding, operation, upstreamReceipts)`.

One admission contains a blocked `await-host-authorization` item, eligible `inventory-evidence`, and its dependent `validate-evidence`. Without another admission or operator prompt, the latter two execute while the first remains blocked. Terminal objective state is truthfully `blocked`, not globally successful. Pending items with no eligible predecessors become explicit `dependency-unavailable` blockers. Receipt binding mismatch fails the workflow; activity retries are bounded to one attempt. Each eligibility frontier runs concurrently. State snapshots carry sequence numbers and Temporal-deterministic timestamps and are persisted by real activities. The runner also queries actual Temporal state during execution and after completion.

Commands are fixed local Node operations, never arbitrary strings loaded from evidence. The inventory reads declared retained files, parses input/admission schemas, hashes each source, and emits `inventory.json`. The dependent validator rereads those actual artifacts, validates their declared schemas, and compares their digests/lengths against the inventory before emitting `inventory-validation.json`. They are useful retained-evidence checks, not canned controller success output.

### Selecting subsequent real work

`OBJECTIVE_SELECTED_PATHS` accepts a JSON array of up to 32 entries: `{name,path,expectedScenario,expectedBinding?,references?,expectedAcceptance?}`. Paths are relative to the invocation directory. `name` is a bounded alphanumeric/hyphen/underscore name. `references` is a bounded array of explicit existing file paths. Selected evidence and referenced files are copied into the admission evidence, then the real workflow's inventory and successor validator read those actual bytes. Evidence must contain a parseable observation timestamp, named scenario, actual result, and explicit nonempty limitations. `evidence`/`scenarios` arrays are supported. `expectedScenario` must match the summary or one scenario in its array; optional `expectedBinding` requires an exact top-level binding. Completed SQLite restart evidence must include both before and after observations.

`expectedAcceptance` defaults to `accepted`: failed/pending/running/blocked outcomes are rejected. `reported` permits honest incomplete/native-host blockers as reported evidence only; the inventory retains that classification and does not turn it into accepted scenario completion. References are checked for existence, retained, and hashed, not executed. Commands never execute command strings found in selected summaries.

From the repository root, a substantive example is:

```sh
OBJECTIVE_SELECTED_PATHS='[{"name":"safety","path":"poc/temporal-omp/safety/evidence/latest.json","expectedScenario":"safety-real-git-reconciliation","references":["poc/temporal-omp/safety/index.ts","poc/temporal-omp/safety/scenario.ts"]}]' node poc/temporal-omp/objective/runner.mjs
```

This exact scenario completed in `evidence/objective-proof-1793841014953/`: one admission, 53 real history events, six persisted state transitions, 17 service queries, both evidence operations completed while `native-host-not-admitted` remained blocked. The selected real Git reconciliation summary passed semantic scenario/result/limitations validation and its explicit referenced sources were retained and rehashed. This is substantive command-activity dogfood of retained evidence, not proof that the safety gate ran inside this objective workflow. Numeric `Binding.revision` is this experiment's sequence and is not the safety slice's Git-SHA revision protocol.


## Evidence

Each execution retains `input.json`, `admission.json`, source/lockfile copies, `evidence-manifest.json`, `state-updates.jsonl`, live `query-observations.json`, `query-snapshot.json`, correlated activity receipts including exact command/stdout/stderr, inventory artifacts, `result.json`, full service-fetched `history.json`, and `summary.json`. Evidence is sanitized and credential-free. `summary.json` is written only after observed behavior assertions pass. History can be reread after server restart using the workflow ID without rerunning the activities.

For a subsequent independent check of an existing execution:

```sh
node commands.mjs validate-inventory /absolute/path/to/evidence/execution
```

That command validates the manifest's declared admission/input/source and any selected semantic evidence inventory; the full history, receipts, state transitions and final result remain separately available for architectural review. This is a narrow runnable architecture proof, not a deployment, authorization, cancellation, crash recovery, or native-host acceptance claim.
