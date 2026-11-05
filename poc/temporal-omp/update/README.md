# Real Temporal artifact update proof

This isolated probe replaces a running Temporal workflow worker with a different executable workflow source while a real activity from the previous artifact remains in flight. It reuses `../objective/node_modules` (Temporal TypeScript SDK **1.25.0**) and the existing SQLite-backed Temporal server at `127.0.0.1:17233`, namespace `default`. It does not control or stop the server or any OMP process.

## Run

Install the ObjectiveProbe dependencies first using its lockfile. If the ignored local dependency link is absent, create it once:

```sh
ln -s ../objective/node_modules poc/temporal-omp/update/node_modules
node poc/temporal-omp/update/runner.mjs
```

Each invocation admits one unique workflow with isolated workflow, old-activity, and successor-activity queues. Activities have `maximumAttempts: 1`; the runner does not retry unknown effects. Source files, SHA-256 artifact identities, exact SDK versions, inputs, live observations, result, summary, and full Temporal history are retained under `evidence/artifact-update-<timestamp>/`.

## Protocol

1. Start the actual `workflow-v1.ts` worker and old `worker-v1.mjs` activity implementation. The old activity starts and waits at a controlled gate.
2. Query the real workflow to establish that the old artifact is running with the activity pending. Gracefully stop only this probe's workflow worker.
3. Start the actual `workflow-v2.ts` worker on the same workflow queue. Query the same execution: the new source has replayed its history and preserved the pending old attempt.
4. Signal authority supersession to attempt 2 / generation 2 before releasing the old activity. Query confirms the new authority is installed.
5. The actual old implementation computes a sum (`2 + 3 + 5 = 10`). Its completed result is retained in history but rejected by the reusable `version-binding.ts` acceptance predicate as `superseded-attempt`; it never enters accepted results.
6. The successor runs the different `worker-v2.mjs` implementation, computing the sum of squares (`4 + 9 + 25 = 38`). Its bound result alone is accepted.

Artifact hashes are content identities, not Git revisions. The small attempt/generation binding is scoped to this experiment and is **not** the productive SafetyProbe receipt schema or its Git-SHA revision field.

## Explicit limits

The query's workflow-version literal is an observation of which compatible code replayed, not a durable version marker or a version-pinning guarantee. No Temporal patch/deprecation APIs or Worker Deployment Versioning APIs are used. Retained `workflow-v1.bundle.js` and `workflow-v2.bundle.js` are the actual code strings handed to `Worker.create`, with SHA-256 identities in the manifest; activity module source identities are recorded separately.

This proves one compatible workflow source update and application-level fencing across a real Temporal execution. It is not Temporal server Worker Deployment Versioning, an arbitrary-incompatible-change gate, or native OMP extension reload/turn/context continuation. Old and new activity artifacts use explicit separate queues rather than relying on competing worker selection. No native OMP reload is connected to this probe. Independent PiOMPProbe capability evidence must not be combined into an unsupported end-to-end reload claim.
