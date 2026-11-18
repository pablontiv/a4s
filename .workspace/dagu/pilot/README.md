# Pi triage slice (2/4)

`pi-triage-slice.yaml` is standalone. Keep `pi-triage-slice.mjs` next to it.
Dagu 2.26.0 derives the entrypoint name `pi-triage-slice` from the filename.
Do not install this DAG in the operator's station.

Supply an explicit `--run-id pi-slice-…`, an absolute path to the trusted
`.mjs` entry as `WORKER_ENTRY`, and an existing, absolute, private temporary
directory owned by the current user as `STATE_ROOT` (e.g. `mktemp -d`).
`ISSUE` defaults to `fixture-1`.

The worker receives `--issue <ISSUE> --run-id <runId>` as separate arguments.
It must exit 0 and emit exactly one UTF-8 JSON line with `schemaVersion: 1`,
the matching `issue` and `runId`, `poc: "yes"`, and non-blank `question` and
`reason`. Invalid output fails the run before `decide`. While the run is
`Waiting`, `<STATE_ROOT>/<runId>/triage.json` is already available. Complete
`decide` with `DECISION=APPROVE` or `DECISION=REJECT`. Either answer finishes
`Succeeded` and writes `{schemaVersion: 1, runId, decision}` to `decision.json`
in the same directory. No PoC or publication follows either answer.

## Native test

With Node.js ≥22.19 and Dagu 2.26.0, run from the repo root:

```sh
DAGU_BIN=/absolute/path/to/dagu \
  node --test .workspace/dagu/pilot/pi-triage-slice.native.test.mjs
```

`DAGU_BIN` is optional if the bare binary is on `PATH`. Do not use a station
wrapper. The test copies only this slice and its own worker stub into a
temporary home, uses explicit local config and an available loopback port, and
checks the resolved paths plus the absence of `feature` and `triage-pilot`
before exercising the human task. It stops its server and removes its temporary
state on exit.
