import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { retirementFixture } from "./fixtures/station-retirement.ts";
import { main as staleRecovery } from "../src/commands/stale-recovery.ts";
import { STALE_PROCESS_ERROR } from "../src/stale-recovery.ts";
import { classifyRuns, type ClassifyDependencies } from "../src/reconcile-classify.ts";
import { main as reconcile } from "../src/reconcile.ts";
import { tick } from "../src/tick.ts";
import { parseAllDocuments } from "yaml";

for (const invalid of [false, true]) {
  test(`scheduled stale recovery ${invalid ? "rejects invalid retirement" : "skips a retired terminal legacy run"} before receipt/PATH verification or invokeRun`, async t => {
    const f = retirementFixture(t); await f.retire();
    if (invalid) writeFileSync(f.evidencePath, JSON.stringify({ ...f.evidence(), receiptDigest: "0".repeat(64) }));
    const directory = join(f.home, "logs", "admin", "events"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "20261022.jsonl"), JSON.stringify({
      type: "dag.run.failed", dag_name: "feature", dag_run_id: f.run,
      data: { dag_run_status: { error: STALE_PROCESS_ERROR } },
    }) + "\n");
    const requests: string[] = [], logs: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      requests.push(String(input)); assert.ok(String(input).endsWith(`/feature/${f.run}/spec`));
      return Response.json({ spec: f.snapshot });
    });
    const log = t.mock.method(fs, "writeSync", (fd: number, chunk: string) => {
      assert.equal(fd, 2); logs.push(chunk); return chunk.length;
    });
    syncBuiltinESMExports();
    t.after(() => { log.mock.restore(); syncBuiltinESMExports(); });
    await staleRecovery(["recover-scheduled"]);
    assert.equal(requests.length, 1);
    if (invalid) { assert.equal(logs.length, 1); assert.match(logs[0]!, /reconcile-failure.*retirement evidence binding is invalid/); }
    else assert.deepEqual(logs, []);
    assert.equal(existsSync(join(f.home, "stale-recovery.json")), false);
    assert.equal(existsSync(join(f.home, "cache", "a4s", ".state.lock")), false);
  });
}

for (const invalid of [false, true]) {
  test(`classification ${invalid ? "reports invalid retirement evidence" : "excludes retired discovery rows"} before artifact verification or dispatch`, async t => {
    const f = retirementFixture(t); await f.retire();
    if (invalid) writeFileSync(f.evidencePath, "{");
    process.env.RUNS = JSON.stringify([{ PRIMARY: f.primary, RUN: f.run, ISSUE: "922", REPO: "example/repo" }]);
    const errors: string[] = []; t.mock.method(console, "error", (line: string) => errors.push(line));
    let verified = 0;
    const dependencies: ClassifyDependencies = {
      scope: { artifactVerifications: 0, async verify() { verified++; throw new Error("unexpected receipt/PATH verification"); },
        async locally() { throw new Error("unexpected artifact execution"); } },
      invoke() { throw new Error("unexpected invokeRun"); }, requestIssues() { throw new Error("unexpected GitHub request"); },
    };
    const output = join(f.root, "classify"); await classifyRuns(output, dependencies);
    assert.equal(verified, 0);
    const lines = readFileSync(output, "utf8"); assert.match(lines, /^children=\[\]\nactions=\[\]\n/);
    if (invalid) { assert.match(lines, /retirement evidence is unreadable or malformed/); assert.ok(errors.some(line => line.startsWith("reconcile-failure"))); }
    else { assert.match(lines, /failures=\[\]/); assert.equal(errors.some(line => line.startsWith("reconcile-failure")), false); }
  });
}

test("native discovery filters retirement before repository lookup and its read-only probe rejects mismatched evidence", async t => {
  const f = retirementFixture(t); await f.retire();
  await reconcile(["is-retired", f.primary, f.run]); assert.equal(f.output.at(-1), true);
  const dag = parseAllDocuments(readFileSync(new URL("../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8"))[0]!.toJSON();
  const script = dag.steps.find((step: { id: string }) => step.id === "discover").run as string;
  assert.ok(script.indexOf('reconcile is-retired "$primary" "$run"') < script.indexOf('repo=$(bounded gh repo view'));
  assert.match(script, /retired=\$\("\$A4S_BIN" reconcile is-retired[^\n]+\)\n\s+if \[\[ "\$retired" == "true" \]\]; then\n\s+skipped=.+\n\s+continue/);
  writeFileSync(f.evidencePath, JSON.stringify({ ...f.evidence(), run: "different-run" }));
  await assert.rejects(reconcile(["is-retired", f.primary, f.run]), /retirement evidence binding is invalid/);
});

for (const invalid of [false, true]) {
  test(`tick ${invalid ? "fails closed for mismatched retirement" : "does not select a retired terminal legacy run"}`, async t => {
    const f = retirementFixture(t); await f.retire("succeeded");
    if (invalid) writeFileSync(f.evidencePath, JSON.stringify({ ...f.evidence(), dag: "poc" }));
    const launcher = join(f.home, "bin", "a4s-launch"), payload = join(f.home, "cached-payload");
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n"); chmodSync(launcher, 0o755); symlinkSync(launcher, join(f.home, "bin", "a4s"));
    Object.assign(process.env, { DAG_RUN_ID: "retirement-tick", A4S_BIN: payload,
      A4S_ARTIFACT: `r498@${"a".repeat(40)}#${"1".repeat(64)}` });
    const calls: string[][] = [], errors: string[] = [];
    t.mock.method(console, "error", (line: string) => errors.push(line));
    const spawn = t.mock.method(childProcess, "spawnSync", (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === launcher) return { status: 0, stdout: "" };
      if (command === payload) { assert.deepEqual(args, ["stale-recovery", "recover-scheduled"]); return { status: 0 }; }
      assert.equal(command, "bash");
      return { status: 0, stdout: JSON.stringify([{ PRIMARY: f.primary, RUN: f.run, ISSUE: "922" }]), stderr: "" };
    });
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
    if (invalid) await assert.rejects(tick([]), /Tick actions failed:.*retirement evidence binding is invalid/);
    else await tick([]);
    assert.deepEqual(calls.map(call => call.slice(0, 3)), [
      [launcher, "station", "promote"], [payload, "stale-recovery", "recover-scheduled"], ["bash", "-euo", "pipefail"],
      ...(invalid ? [] : [[launcher, "station", "gc"]]),
    ]);
    assert.equal(errors.some(line => line.startsWith("reconcile-failure")), invalid);
  });
}
