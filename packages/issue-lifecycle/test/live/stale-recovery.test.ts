import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { compiledArtifact } from "../fixtures/admission.ts";
import { roleAdmission } from "../role-job-fixtures.ts";
import { FEATURE_STEP_ORDER, STALE_PROCESS_ERROR, type AdminEvent, type DagNodeSnapshot } from "../../src/stale-recovery.ts";

const cli = fileURLToPath(new URL("../../bin/dagu-stale-recovery.ts", import.meta.url));

function node(id: string, status?: number): DagNodeSnapshot {
  return status === undefined ? { step_id: id, step_name: id } : { step_id: id, step_name: id, status };
}

function event(input: {
  type: string; at: string; service: string; instance: string; run: string; attempt: string;
  nodes?: DagNodeSnapshot[]; error?: string; dag?: string;
}): AdminEvent {
  return {
    type: input.type, occurred_at: input.at, recorded_at: input.at, source_service: input.service,
    source_instance: input.instance, dag_name: input.dag ?? "feature", dag_run_id: input.run, attempt_id: input.attempt,
    data: { dag_run_status: { ...(input.error ? { error: input.error } : {}), nodes: input.nodes ?? [] } },
  };
}

function pair(run: string, attempt: string, previous: "dag.run.waiting" | "dag.run.queued", nodes: DagNodeSnapshot[], error = STALE_PROCESS_ERROR): AdminEvent[] {
  return [
    event({ type: previous, at: "2026-10-22T06:08:13.000Z", service: "cli", instance: "station:111", run, attempt, nodes }),
    event({ type: "dag.run.failed", at: "2026-10-22T06:08:14.000Z", service: "scheduler", instance: "station:64722", run, attempt, nodes, error }),
  ];
}

function queuedThrough(step: string): DagNodeSnapshot[] {
  const cutoff = FEATURE_STEP_ORDER.indexOf(step);
  assert.ok(cutoff > 0);
  return FEATURE_STEP_ORDER.map((id, index) => node(id, index < cutoff ? 4 : undefined));
}
async function recover(home: string, bin: string, calls: string, url: string) {
  return await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "recover-scheduled"], {
      env: { ...process.env, DAGU_HOME: home, DAGU_URL: url, PATH: `${bin}:${process.env.PATH ?? ""}`, DAGU_CALLS: calls },
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.resume();
    child.once("error", reject);
    child.once("close", status => resolve({ status, stderr }));
  });
}

function retryCommands(calls: string): string[] {
  return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as string[])
    .filter(args => args[0] === "retry")
    .map(args => args.join(" "));
}

test("scheduled recovery retries stale Waiting, Queued and await_ci runs and ignores other failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-stale-recovery-"));
  const primary = join(root, "primary");
  execFileSync("git", ["init", "-q", primary]);
  execFileSync("git", ["-C", primary, "-c", "user.name=Stale test", "-c", "user.email=stale@example.test", "commit", "--allow-empty", "-qm", "seed"]);
  const server = createServer((_request, response) => response.end(JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(primary)}\n` })));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const home = join(root, "dagu");
    const bin = join(root, "bin");
    const calls = join(root, "calls.jsonl");
    mkdirSync(join(home, "logs", "admin", "events"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(calls, "");
    writeFileSync(join(bin, "dagu"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DAGU_CALLS, JSON.stringify(args) + "\\n");
const run = args[args.indexOf("--run-id") + 1];
if (args[0] === "status") {
  console.log(run === "still-running" ? "Running - active" : "Failed - stale local process detected");
  process.exit(0);
}
if (args[0] === "retry") process.exit(0);
console.error("unexpected dagu " + args.join(" "));
process.exit(91);
`);
    chmodSync(join(bin, "dagu"), 0o755);
    const events = [
      ...pair("waiting-conflict", "aaa111", "dag.run.waiting", [node("conflict_review", 7)]),
      ...pair("queued-gate", "bbb222", "dag.run.queued", [node("start_gate", 4), node("implement", 4), node("capture", 4), node("rebase", 4), node("conflict_review", 4), node("gate", 0)]),
      ...pair("await-ci", "ccc333", "dag.run.waiting", [node("await_ci", 7), node("await_merge", 7)]),
      ...pair("gate-failed", "ddd444", "dag.run.waiting", [node("recover_gate", 7)], "gate command failed"),
      ...pair("still-running", "eee555", "dag.run.waiting", [node("validation", 7)]),
      ...pair("poc-stale", "fff666", "dag.run.waiting", [node("fix_result", 7)]).map(entry => ({ ...entry, dag_name: "poc" })),
    ];
    writeFileSync(join(home, "logs", "admin", "events", "20261022.jsonl"), events.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const artifact = compiledArtifact(home);
    for (const run of ["waiting-conflict", "queued-gate", "await-ci", "still-running"]) {
      const state = join(primary, ".git/dagu-feature/runs", run);
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "receipt.json"), JSON.stringify(roleAdmission(primary, home, run, "env: []", artifact)));
    }
    const first = await recover(home, bin, calls, url);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(retryCommands(calls).sort(), [
      "retry --run-id await-ci --step auto_merge --downstream feature",
      "retry --run-id queued-gate --step gate --downstream feature",
      "retry --run-id waiting-conflict --step rebase --downstream feature",
    ]);
    assert.match(first.stderr, /stale-process recovery: run=waiting-conflict attempt=aaa111 checkpoint=conflict_review step=rebase command=dagu retry --run-id waiting-conflict --step rebase --downstream feature/);
    assert.match(first.stderr, /stale-process recovery: run=queued-gate attempt=bbb222 checkpoint=gate step=gate command=dagu retry --run-id queued-gate --step gate --downstream feature/);
    assert.match(first.stderr, /stale-process recovery: run=await-ci attempt=ccc333 checkpoint=await_ci,await_merge step=auto_merge command=dagu retry --run-id await-ci --step auto_merge --downstream feature/);
    assert.match(first.stderr, /stale-process recovery skipped: run=still-running status=Running - active/);
    assert.doesNotMatch(first.stderr, /gate-failed/);
    assert.doesNotMatch(first.stderr, /poc-stale/);
    const ledger = JSON.parse(readFileSync(join(home, "stale-recovery.json"), "utf8")) as { recoveries: Array<{ run: string; attempt: string }> };
    assert.deepEqual(ledger.recoveries.map(record => record.run).sort(), ["await-ci", "queued-gate", "waiting-conflict"]);
    const second = await recover(home, bin, calls, url);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /stale-process recovery budget: run=waiting-conflict attempt=aaa111 step=rebase command=dagu retry --run-id waiting-conflict --step rebase --downstream feature; not retried/);
    assert.match(second.stderr, /stale-process recovery budget: run=await-ci attempt=ccc333 step=auto_merge/);
    assert.equal(retryCommands(calls).length, 3);
    // A second scheduler overwrite on the same attempt is still over budget,
    // even if the checkpoint advanced since the first recovery.
    const repeated = pair("waiting-conflict", "aaa111", "dag.run.waiting", [node("validation", 7)])
      .map((entry, index) => ({ ...entry, occurred_at: `2026-10-22T06:08:${15 + index}.000Z` }));
    const eventFile = join(home, "logs", "admin", "events", "20261022.jsonl");
    writeFileSync(eventFile, [...events, ...repeated].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const exhausted = await recover(home, bin, calls, url);
    assert.equal(exhausted.status, 0, exhausted.stderr);
    assert.match(exhausted.stderr, /budget: run=waiting-conflict attempt=aaa111 step=gate .*not retried/);
    assert.equal(retryCommands(calls).length, 3);

    // Native retry creates a distinct attempt; its budget is independent.
    const nextAttempt = pair("waiting-conflict", "new111", "dag.run.waiting", [node("conflict_review", 7)])
      .map((entry, index) => ({ ...entry, occurred_at: `2026-10-22T06:08:${17 + index}.000Z` }));
    writeFileSync(eventFile, [...events, ...repeated, ...nextAttempt].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const next = await recover(home, bin, calls, url);
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stderr, /recovery: run=waiting-conflict attempt=new111 checkpoint=conflict_review step=rebase/);
    assert.equal(retryCommands(calls).length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
