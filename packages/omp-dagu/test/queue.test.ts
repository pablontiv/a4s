import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admissionFixture } from "./fixtures/admission.ts";

const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
const command = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("admission rejects queue overrides and invalid declarations before creating receipts for every lifecycle", () => {
  const f = admissionFixture();
  try {
    for (const lifecycle of ["feature", "poc", "discovery", "planning"]) {
      const dag = join(f.packageDir, ".workspace/dagu/dags", `${lifecycle}.yaml`);
      f.render(`${lifecycle}.yaml`, dag);
      const original = readFileSync(dag, "utf8");
      const validation = spawnSync(process.execPath, [f.cli, "queue-validate", dag, "fixture"], { encoding: "utf8" });
      assert.equal(validation.status, 0, validation.stderr);
      for (const [index, flags] of [["--queue", "a4s-v1"], ["--queue=other-repository"], ["--queue", "arbitrary"]].entries()) {
        const run = `${lifecycle}-override-${index}`;
        const result = spawnSync(process.execPath, [f.cli, "enqueue", "--run-id", run, ...flags, dag], { cwd: f.packageDir, encoding: "utf8", env: { ...process.env, DAGU_HOME: f.home } });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /QUEUE_REJECTED.*unsupported --queue/);
        assert.equal(existsSync(f.receipt(run)), false);
      }
      for (const [index, contents] of [original.replace(/^queue:.*\n/m, ""), original.replace(/^queue:.*$/m, 'queue: "fixture"\nqueue: "fixture"'), original.replace(/^queue:.*$/m, 'queue: "foreign"'), original.replaceAll('"fixture"', '"foreign"')].entries()) {
        writeFileSync(dag, contents);
        const invalid = spawnSync(process.execPath, [f.cli, "queue-validate", dag, "fixture"], { encoding: "utf8" });
        assert.notEqual(invalid.status, 0);
        assert.match(invalid.stderr, /QUEUE_REJECTED/);
        const run = `${lifecycle}-declaration-${index}`;
        const result = spawnSync(process.execPath, [f.cli, "enqueue", "--run-id", run, dag], { cwd: f.packageDir, encoding: "utf8", env: { ...process.env, DAGU_HOME: f.home } });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /QUEUE_REJECTED/);
        assert.equal(existsSync(f.receipt(run)), false);
      }
      writeFileSync(dag, original);
      for (const key of ["QUEUE", "ADOPTED_QUEUE", "LANE", "LANE_MAPPING"]) {
        const run = `${lifecycle}-parameter-${key}`;
        const result = spawnSync(process.execPath, [f.cli, "enqueue", "--run-id", run, dag, "--", `${key}=foreign`], { cwd: f.packageDir, encoding: "utf8", env: { ...process.env, DAGU_HOME: f.home } });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /QUEUE_REJECTED.*replacement via parameters/);
        assert.equal(existsSync(f.receipt(run)), false);
      }
    }
  } finally { f.dispose(); }
});

test("queue gate fails closed on missing, ambiguous or foreign attempt evidence and uses the exact UTC attempt", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "queue-identity-")));
  const runDir = "dag-run_20261023_012917Z_identity";
  const log = join(root, "logs/feature", runDir);
  const data = join(root, "data/dag-runs/feature/dag-runs/2026/10/23", runDir);
  const attempt = join(data, "a_20261023_012918_123Z_new123");
  const env = { DAGU_HOME: root, DAG_NAME: "feature", DAG_RUN_ID: "identity", DAG_RUN_LOG_FILE: join(log, "run.log"), DAG_RUN_STEP_STDOUT_FILE: join(log, "run_20261023_012919Z_new123/gate.out"), DAG_RUN_STEP_STDERR_FILE: join(log, "run_20261023_012919Z_new123/gate.err"), DAGU_OUTPUT_FILE: join(root, "outputs"), QUEUE: "foreign", ADOPTED_QUEUE: "foreign", LANE: "foreign", DAGU_PARAMS_JSON: "{}" };
  const gate = (extra: NodeJS.ProcessEnv = {}) => command(["queue-gate", "a4s"], { ...env, ...extra });
  const rejected = (extra: NodeJS.ProcessEnv = {}, cause?: RegExp) => {
    const result = gate(extra);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /QUEUE_REJECTED.*expected=a4s/);
    if (cause) assert.match(result.stderr, cause);
    assert.equal(existsSync(env.DAGU_OUTPUT_FILE), false);
  };
  const status = (run = "identity", id = "new123", queue = "a4s") => writeFileSync(join(attempt, "status.jsonl"), JSON.stringify({ dagRunId: run, attemptId: id, procGroup: queue }) + "\n");
  try {
    rejected({ DAG_RUN_LOG_FILE: "" }, /missing DAG_RUN_LOG_FILE/);
    rejected({ DAG_RUN_ID: "foreign" }, /run log identity mismatch/);
    rejected({ DAG_RUN_STEP_STDERR_FILE: join(log, "run_other/gate.err") }, /attempt log identity mismatch/);
    mkdirSync(attempt, { recursive: true });
    rejected({}, /ENOENT/);
    writeFileSync(join(attempt, "dag.json"), JSON.stringify({ name: "feature", queue: "a4s" }));
    status("foreign"); rejected({}, /persisted run\/attempt identity mismatch/);
    status("identity", "old123"); rejected({}, /persisted run\/attempt identity mismatch/);
    status("identity", "new123", "foreign"); rejected({}, /procGroup/);
    status();
    const ambiguous = join(data, "a_20261023_012920_123Z_new123");
    mkdirSync(ambiguous); rejected({}, /observed=2/); rmSync(ambiguous, { recursive: true });
    const old = join(data, "a_20261023_012917_123Z_old123");
    mkdirSync(old);
    writeFileSync(join(old, "dag.json"), JSON.stringify({ name: "feature", queue: "foreign" }));
    rejected({ DAGU_PARAMS_JSON: '{"QUEUE":"foreign"}' }, /replacement via parameters/);
    writeFileSync(join(attempt, "dag.json"), JSON.stringify({ name: "feature", queue: "a4s-v1" }));
    status("identity", "new123", "a4s-v1"); rejected({}, /queue=a4s-v1 expected=a4s/);
    writeFileSync(join(attempt, "dag.json"), JSON.stringify({ name: "feature", queue: "a4s" })); status();
    const result = gate();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /QUEUE_ACCEPTED dag=feature run=identity attempt=new123 lane=main queue=a4s expected=a4s/);
    assert.equal(readFileSync(env.DAGU_OUTPUT_FILE, "utf8"), "QUEUE_VERIFIED=yes\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
