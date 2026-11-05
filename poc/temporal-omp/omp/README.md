# Native interactive OMP / Temporal host probe

## Observed result

**Passed the minimal official compiled-binary interactive binding/hook/session smoke.** Session `01a1aa04-1394-738a-8afa-790553872714` ran `/home/pones/.local/share/tern/omp/bin/omp` 18.16.0 with embedded Bun 1.4.4 in an actual PTY. Workflow `native-host-3aecfa50-f891-4271-98a7-f468beccf7ec` completed with native task receipt `native-receipt-4afed631-1953-4074-b430-6234c74e2bc4`, tool call `call_CbD0mTin7iSfyIsJuGHUbV9o`. The terminal displayed `NATIVE_HOST_WORKFLOW_COMPLETED` and `NATIVE_HOST_DONE`.
The owned PTY host exited cleanly with code 0 after Ctrl-C. Its retained shutdown events are at `2026-11-05T04:43:33.723Z` and `2026-11-05T04:43:33.827Z`; no server or unrelated host was stopped.

The retained `events.jsonl` appends this run after the previous npm-host proof and prior failures. The compiled session records `hasUI:true`, only `task` active, `NODE_PATH` unset, and a working directory different from the source and deploy directories. Its worker records `debugMode:false`; the activity sends a `nextTurn` request; the main model invokes native `task`; the extension observes a successful `tool_result` containing the request receipt before completing the activity and workflow. There is no self-answering activity, print mode, RPC, or substitute delegation implementation.

`node poc/temporal-omp/omp/summarize.mjs` reconciles the latest compiled session, requires its completed workflow and shutdown, and checks source/build/deployed hashes before writing sanitized `evidence.json`. It cannot fall back to the earlier npm-host completion if the latest compiled run fails.

## Runtime pins and preparation

- Existing peer-owned SQLite Temporal server 1.32.2: `127.0.0.1:17233`, namespace `default`. This probe neither starts nor restarts it.
- Temporal JS SDK 1.25.0 from `../objective/node_modules`, resolved through `realpath`; no copied or newly installed SDK tree.
- Official compiled OMP 18.16.0, embedded Bun 1.4.4. The build below uses the retained private Bun 1.4.4; system Bun 1.4.2 is not the host.
- Model `cliproxy/gpt-6.1-sol`, with existing private provider configuration.
- `smoke-config.yml` disables async task execution so `tool_result` contains the child result, not a spawn acknowledgment.

`prepare.mjs` snapshots existing config and read-only SQLite credentials into ignored private `.runtime/` without printing them. It prebuilds the workflow with the exact SDK and explicit shared module resolution. The retained snapshot and `workflow-bundle.js` were reused for this run; preparation was not rerun. Original auth/provider files are not modified.

From repository root:

```sh
# Only when preparing a fresh private snapshot/workflow bundle:
poc/temporal-omp/omp/.runtime/package/bin/bun poc/temporal-omp/omp/prepare.mjs
# Exact targeted deployment build used for the compiled run:
poc/temporal-omp/omp/.runtime/package/bin/bun poc/temporal-omp/omp/build.ts
# Run in an actual PTY, never -p or RPC:
bash poc/temporal-omp/omp/launch.sh
# After exiting the owned host cleanly:
node poc/temporal-omp/omp/summarize.mjs
```

`launch.sh` is now the compiled-host launcher (the former npm launcher is replaced). It unsets `NODE_PATH` and inherited session/tool IDs, uses `PI_CODING_AGENT_DIR=.runtime`, disables extension/skill/rule/context discovery and LSP/title, selects only `task`, explicitly loads `dist/extension.js`, and bounds execution to 120 seconds. Both launch cwd and `--cwd` are `.runtime/compiled-cwd`, not the source directory. Only the owned probe host is exited; the user's original host and existing server are untouched.

## Self-contained deployment

`build.ts` bundles the existing receipt-contract `extension.ts` and SDK `workflow-worker-thread.js` as separate Bun-target outputs, externalizing only `@oh-my-pi/*`. Its SDK-specific plugin:

1. Replaces Temporal's webpack bundler with a stub that throws if called; runtime uses the prebuilt workflow bundle.
2. Redirects `threaded-vm.js`'s thread entry to `globalThis.__A4S_TEMPORAL_THREAD_ENTRY`.
3. Redirects core-bridge's native addon lookup to `A4S_TEMPORAL_DIST/releases/<target>/index.node`.
4. Redirects source-map's WASM lookup to `A4S_TEMPORAL_DIST/mappings.wasm`.

Each source rewrite throws at build time if its needle is absent. `runtime-paths.ts` must remain the first extension import: it initializes the environment/global before core-bridge loads; worker threads inherit the environment. The build copies only the prebuilt workflow, WASM and Linux x64 addon into ignored `dist/`, alongside both bundles. `build-manifest.json` records build Bun/SDK versions, build input hashes (including the objective lockfile), rewritten SDK input hashes and every deployed payload hash. The session hashes those payloads and the manifest from its actual deploy directory, not the original TypeScript file.

The normal launch is a clean cutover to the bundled compiled host; direct loading of source `extension.ts` is no longer a supported entrypoint. The build retains relative explicit SDK imports so it resolves the shared installation without `NODE_PATH`.

## Retained failure history

The previous **unbundled** compiled binary did load the extension into an interactive UI but its workflow worker thread could not resolve `@temporalio/common`; `NODE_PATH` did not repair it. That was a genuine failure, not an npm-host pass mislabeled as compiled. The self-contained thread bundle and runtime-path rewrites repair that deployment failure for the bounded scenario above.

The earlier npm OMP 18.16.0 + Bun 1.4.4 interactive proof passed in session `01a1a950-c27d-70ef-8dbf-068280bd1641`, workflow `native-host-e8a1a165-631e-4cbf-a687-ad658817191f`, receipt `native-receipt-283d707c-af07-4446-b1e6-1194ea53a23a`. Its events remain visible. Original preparation required explicit webpack shared-module resolution and explicit SDK imports. A dynamic-loader Bun launch started the worker but broke existing command-based API-key resolution; direct runtime execution fixed that earlier host. Async task acknowledgment lacked the receipt and correctly failed; synchronous task mode is intentionally retained. Headless inherited child extensions do not start workers.

An earlier dependency install before a private manifest existed selected the repository root; that inserted dependency and generated lockfile were reverted. No new dependency install or copy was performed for this compiled run.

## Scope and limitations

- The deployed addon is Linux x64 glibc-specific (`x86_64-unknown-linux-gnu`); other platforms are not proven.
- Build rewrites depend on SDK 1.25.0 source needles and must be reviewed on upgrade.
- Remaining hardcoded build paths in `@grpc/grpc-js` channelz/orca proto loading and Temporal's debug-replayer worker-thread are unexercised and not made portable here.
- Embedded runtime warns `v8.promiseHooks.createHook` is unavailable and disables Temporal stack trace collection; this does not prevent the observed workflow completion.
- Sync native task overlay is required; async completion hooks remain unproven.
- No durable ownership, context compaction, reload, crash/restart recovery, replay-safe delegation, deduplication, authorization or update-gate interoperability is claimed.
- `events.jsonl` contains sanitized IDs, hashes and errors, not credentials or raw provider/auth payloads. Private `.runtime/` is ignored.
- Only the targeted deployment build, interactive smoke and evidence reconciliation are in scope; no broad build/test/lint or earlier proof rerun.
