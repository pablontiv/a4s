# Real Temporal Server + SQLite persistence probe

This is a local operational experiment, not a deployment, backup, or HA recipe. It uses the **real `temporal-server` 1.32.2 release binary**, not `temporal server start-dev`, an in-memory server, or the SDK testing server. `server.yaml` selects distinct file-backed default and visibility databases with WAL, one connection per store, and one history shard. All Temporal listeners bind to loopback. No system service is changed.

## Reproduce

Prerequisites: Linux x86_64, Bash, curl, tar, sha256sum, Node, and the exact Temporal TypeScript SDK 1.25.0 already installed by the adjacent `objective/` experiment. Set `TEMPORAL_SDK_MODULES` to another private directory's `node_modules` containing `@temporalio/client`, `worker`, `workflow`, and `common` 1.25.0 if needed. The probe does not install packages or edit a shared manifest. Worker workflow bundling is intrinsic to the actual workflow execution, not a repository build/test suite.

```bash
bash poc/temporal-omp/sqlite/runtime.sh install
# Export the exact private path printed by install:
export TEMPORAL_SQLITE_RUNTIME=/tmp/a4s-temporal-sqlite.YOUR_SUFFIX
bash poc/temporal-omp/sqlite/runtime.sh version
bash poc/temporal-omp/sqlite/runtime.sh start
```

Keep the server foreground in its own terminal. In another terminal:

```bash
node poc/temporal-omp/sqlite/probe.cjs before poc/temporal-omp/sqlite/evidence.json
```

Quiesce other users of this isolated server, stop it gracefully with Ctrl-C, and wait for process exit. Restart with **the same private runtime directory** and the same `start` command. Do not delete or copy any SQLite/WAL files between phases. Then, with no proof worker running:

```bash
node poc/temporal-omp/sqlite/probe.cjs after poc/temporal-omp/sqlite/evidence.json
```

The first phase registers namespace `default` if missing, runs a real workflow with one real activity, shuts its worker down, reads completion history/result, and waits for completed visibility indexing. The second phase reads the same workflow/run after the server restart and requires exactly equal result, history event types/count, and visibility record. There is no activity re-execution in phase two. The evidence includes the shared binding fields (`mandateId`, `itemId`, `stage`, `attempt`, `revision`, `generation`).

This independent storage proof uses numeric `revision: 1` as an experiment sequence only. It is not the safety gate's 40-hex Git revision binding and is not end-to-end acceptance-gate integration. No productive mandate is executed by this probe.

Endpoint: `127.0.0.1:17233`; HTTP: `127.0.0.1:17243`; internal gRPC: 17234/17235/17239; membership: 16933/16934/16935/16939. Ports must be free. This unauthenticated loopback setup must not be exposed to a network. The install uses a mode-700 private runtime and verifies the pinned release SHA256 before extraction. The launcher additionally sets umask 077. Binaries, databases, WALs and raw server logs remain outside the repository. Retain only sanitized evidence in this directory.

The exercised runtime/cache is retained privately at `/tmp/a4s-temporal-sqlite.jcPWbdmy`; do not remove its database or WAL files when reusing it. Exact local restart command from the repository root:

```bash
TEMPORAL_SQLITE_RUNTIME=/tmp/a4s-temporal-sqlite.jcPWbdmy bash poc/temporal-omp/sqlite/runtime.sh start
```

Stop only this foreground process with Ctrl-C after its consumers finish. No global service management is needed. The path is a local observed artifact, not a portable checkout dependency; use `install` for another workstation.

## Evidence and limits

`evidence.json` is the actual SDK observation; `runtime-evidence.json` records binary provenance and process stop/restart observations. Their observed timestamps come from the actual host clock. Read their result fields rather than inferring that the presence of a runner proves execution.

A graceful restart of one local process proves only the exercised local SQLite persistence path. It does **not** prove crash/power-loss durability, backup consistency/restoration, disaster recovery, multi-host failover, HA, retention under sustained load, upgrade compatibility, or production supportability. WAL mode alone is not any of those guarantees. No backup or HA behavior is claimed.

## Official source references

- Release: https://github.com/temporalio/temporal/releases/tag/v1.32.2
- Linux AMD64 SHA256: `6260f110b6853d2d7f8daa31793d1fac44096077e3b058dc3482de6ac50bc543`
- https://github.com/temporalio/temporal/blob/v1.32.2/config/development-sqlite.yaml (upstream example uses memory mode; this experiment deliberately replaces it with files)
- https://github.com/temporalio/temporal/blob/v1.32.2/common/persistence/sql/sqlplugin/sqlite/plugin.go (`mode=rwc`, `setup=true`, pragma handling, and WAL behavior)
