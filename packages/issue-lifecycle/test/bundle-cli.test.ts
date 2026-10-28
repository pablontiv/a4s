import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { testRunId } from "./fixtures/run-id.ts";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admissionFixture } from "./fixtures/admission.ts";
import { liveDagu } from "./fixtures/live-dagu.ts";

import { exampleConfig, serializeConfig } from "../src/config.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";
const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));

function commitConfig(repo: string, text?: string): void {
  mkdirSync(join(repo, ".workspace", "dagu"), { recursive: true });
  if (text !== undefined) writeFileSync(join(repo, ".workspace", "dagu", "config.json"), text);
  spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "cli@example.test"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "CLI Test"]);
  if (text === undefined) spawnSync("git", ["-C", repo, "commit", "-qm", "empty", "--allow-empty"]);
  else {
    spawnSync("git", ["-C", repo, "add", "."]);
    const committed = spawnSync("git", ["-C", repo, "commit", "-qm", "config"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
  }
}

test("CLI reports committed config and the reconciler as compatible", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    commitConfig(repo, serializeConfig(exampleConfig({
      lane: "fixture", gate: "npm test", requiredCheck: "validate",
    })));
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), "steps:\n  - run: true\n");
    writeFileSync(join(daguHome, "config.yaml"), "queues:\n  enabled: true\n  config:\n    - name: fixture\n      max_concurrency: 6\n");
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.24.0\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, [cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /config path=\.workspace\/dagu\/config\.json schema=1 .*lane=fixture .*queue=fixture source=config.yaml max_concurrency=6 ready=yes/);
    assert.match(result.stdout, /config policy gate="npm test" requiredCheck="validate"/);
    assert.match(result.stdout, /reconcile\.yaml path=.* installed=yes/);
    assert.match(result.stdout, /dagu version="2\.24\.0"/);
    assert.doesNotMatch(result.stdout, /dagu version=.*(?:required=|compat=)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exits nonzero when committed config is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    commitConfig(repo);
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), "steps:\n  - run: true\n");
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.24.0\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, [cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /compat=invalid/);
    assert.match(result.stdout, /missing committed config file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission rejects adopted policy parameters before reserving a receipt", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    for (const parameter of ["GATE=true", "REBASE_RESOLVER=true", "REQUIRED_CHECK=arbitrary", "PRIMARY=/foreign/clone", "BRANCH=off-pattern"]) {
      const field = parameter.slice(0, parameter.indexOf("="));
      const run = testRunId(`rejected-${field.toLowerCase()}`);
      const result = fixture.command("enqueue", run, {}, [parameter]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`admission rejected run parameter: ${field}`), result.stderr);
      assert.equal(existsSync(join(fixture.packageDir, ".git", "dagu-feature", "runs", run)), false);
    }
    const accepted = fixture.command("admit", "operational-policy", {}, ["PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("operational-policy"), "utf8"));
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    assert.deepEqual(receipt.initial.execution.parameters, ["ISSUE=277", "PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
  } finally { fixture.dispose(); }
});

test("admission rejects modified cached payload before Dagu creates a run", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    const admitted = fixture.command("admit", "verified-cache");
    assert.equal(admitted.status, 0, admitted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("verified-cache"), "utf8"));
    const template = join(fixture.home, "cache", "a4s", receipt.artifact.version, "skills", "issue-execution", "feature.yaml");
    writeFileSync(template, `${readFileSync(template, "utf8")}\n# modified payload\n`);
    const run = testRunId("corrupt-cache");
    const result = fixture.command("enqueue", run);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Modified artifact payload/);
    assert.equal(existsSync(fixture.receipt(run)), false);
  } finally { fixture.dispose(); }
});

test("compatible admission enqueues exact bytes and keeps historical receipt across redeployment", liveDagu, () => {
  const fixture = admissionFixture();
  const run = testRunId("compatible");
  const redeployedRun = testRunId("after-redeploy");
  try {
    const result = fixture.command("enqueue", run);
    assert.equal(result.status, 0, result.stderr);
    const path = fixture.receipt(run);
    const initialReceipt = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(initialReceipt.sourceVersion.version, BUNDLE_VERSION);
    assert.match(initialReceipt.deploymentFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(initialReceipt.initial).sort(), ["admittedAt", "deployment", "eventsAndExternalState", "execution", "runtimeAndModels"]);
    assert.equal(initialReceipt.initial.runtimeAndModels.resolvedModel.state, "pending");
    assert.equal(initialReceipt.runReceipt.observations[0].kind, "enqueued");
    const history = spawnSync("dagu", ["history", "feature", "--format", "json"], { env: { ...process.env, DAGU_HOME: fixture.home }, encoding: "utf8" });
    assert.equal(history.status, 0, history.stderr);
    assert.ok(history.stdout.includes(run));
    assert.equal(readFileSync(join(path, "..", "snapshot", "feature.yaml"), "utf8"), initialReceipt.initial.execution.dagSnapshot);
    const event = { dag: "feature", run, attempt: 1, category: "runtimeAndModels", kind: "model-resolved", data: { resolvedModel: "test/model", resolvedModelIsFallback: false, crossFamilyDecision: { allowed: true, reason: "same family" } } };
    const observed = fixture.observe(run, event);
    assert.equal(observed.status, 0, observed.stderr);
    const afterEvent = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(afterEvent.initial, initialReceipt.initial);
    assert.deepEqual(afterEvent.runReceipt.observations.at(-1).data, event.data);
    const invalid = fixture.observe(run, { ...event, run: "other-run" });
    assert.notEqual(invalid.status, 0);
    const oldBytes = readFileSync(path, "utf8");
    writeFileSync(join(fixture.packageDir, "unrelated-checkout-file"), "This cannot change the cached artifact\n");
    const next = fixture.command("enqueue", redeployedRun);
    assert.equal(next.status, 0, next.stderr);
    const nextReceipt = JSON.parse(readFileSync(fixture.receipt(redeployedRun), "utf8"));
    assert.equal(nextReceipt.deploymentFingerprint, initialReceipt.deploymentFingerprint);
    assert.equal(readFileSync(path, "utf8"), oldBytes);
    const duplicate = fixture.command("enqueue", run);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /already has an immutable admission receipt; choose a new run ID/);
    assert.equal(readFileSync(path, "utf8"), oldBytes);
    const descriptor = openSync(path, "r");
    try { assert.equal(fstatSync(descriptor).mode & 0o777, 0o600); }
    finally { closeSync(descriptor); }
  } finally { fixture.dispose(); }
});

test("admission ignores station files, forged consumer templates, and notice-only plugin identity", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    assert.equal(existsSync(join(fixture.home, "dags", "reconcile.yaml")), false);
    const absentRun = testRunId("reconciler-absent");
    const absent = fixture.command("enqueue", absentRun);
    assert.equal(absent.status, 0, absent.stderr);
    const consumer = fixture.dag;
    mkdirSync(join(consumer, ".."), { recursive: true });
    writeFileSync(consumer, "# injected code\n");
    const forged = fixture.command("enqueue", testRunId("forged"));
    assert.equal(forged.status, 0, forged.stderr);
    const staleRun = testRunId("stale");
    const stale = fixture.command("enqueue", staleRun, { DAGU_ADMISSION_SESSION: JSON.stringify({ extensionDigest: "old-loaded-digest", transcriptRoot: "/session" }) });
    assert.equal(stale.status, 0, stale.stderr);
    assert.deepEqual(JSON.parse(readFileSync(fixture.receipt(absentRun), "utf8")).artifact, JSON.parse(readFileSync(fixture.receipt(staleRun), "utf8")).artifact);
  } finally { fixture.dispose(); }
});
