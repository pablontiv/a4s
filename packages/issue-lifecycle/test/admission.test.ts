import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { admissionFixture } from "./fixtures/admission.ts";
import { lifecycleProtocolToken, REQUIRED_DAGU_VERSION } from "../src/bundle.ts";
import { ANSWERS_PATH } from "../src/answers.ts";

function fakeDagu(bin: string, calls: string): void {
  mkdirSync(bin);
  const dagu = join(bin, "dagu");
  writeFileSync(dagu, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "version") {
  console.log(${JSON.stringify(REQUIRED_DAGU_VERSION)});
} else if (args[0] === "enqueue") {
  fs.appendFileSync(process.env.ADMISSION_ENQUEUE_CALLS, JSON.stringify(args) + "\\n");
  console.log("fixture dagu enqueue reached");
} else {
  console.error("Unexpected fixture Dagu command: " + JSON.stringify(args));
  process.exitCode = 1;
}
`);
  chmodSync(dagu, 0o755);
  writeFileSync(calls, "");
}

function retireTemplate(path: string): void {
  writeFileSync(path, `${readFileSync(path, "utf8")}\n# TRIAGE_REVIEW AGENT=retired\n`);
}

test("planning CLI admission materializes the installed template and enqueue submits that snapshot", () => {
  const fixture = admissionFixture();
  try {
    const dag = "planning";
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
    fakeDagu(bin, calls);
    const params = [`PRIMARY=${fixture.packageDir}`, `UNITS_FROM=${join(fixture.root, "units.jsonl")}`, "SOURCE=refine", "OMP_SESSION_ID=planning-owner"];
    const command = (subcommand: string, run: string) => spawnSync(process.execPath, [fixture.cli, subcommand, "--run-id", run, dag, "--", ...params], {
      cwd: fixture.packageDir,
      env: { ...process.env, DAGU_HOME: fixture.home, PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls, A4S_PRIMARY: fixture.packageDir },
      encoding: "utf8",
      timeout: 30000,
    });

    const admitted = command("admit", "planning-admitted");
    assert.equal(admitted.status, 0, admitted.stderr);
    const admission = JSON.parse(admitted.stdout);
    assert.equal(admission.path, fixture.receipt("planning-admitted"));
    const receipt = JSON.parse(readFileSync(admission.path, "utf8"));
    assert.deepEqual(admission.receipt, receipt);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.sourceVersion.version, "0.3.1");
    assert.match(receipt.deploymentFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(receipt.runReceipt.dag, "planning");
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    assert.deepEqual(receipt.initial.execution.parameters, params);
    assert.equal(receipt.initial.deployment.installedDAG.relationship, "materialized-from-answers");
    assert.equal(receipt.initial.deployment.installedDAG.version, "0.3.1");
    assert.equal(receipt.initial.deployment.installedDAG.template.path, "skills/issue-execution/planning.yaml");
    assert.equal(receipt.initial.deployment.answers.path, ANSWERS_PATH);
    assert.equal(receipt.initial.deployment.answers.schemaVersion, 1);
    assert.match(receipt.initial.deployment.answers.digest, /^[a-f0-9]{64}$/);
    assert.equal(receipt.initial.deployment.generatedDagDigest, receipt.initial.deployment.installedDAG.generatedDigest);
    assert.equal(receipt.initial.execution.dagSnapshot, receipt.initial.deployment.installedDAG.snapshot);
    assert.match(receipt.initial.execution.dagSnapshot, /queue: fixture/);
    assert.equal(receipt.initial.deployment.relationships.installedToSource, "materialized-from-answers");
    assert.equal(receipt.initial.deployment.relationships.compatibility, "installed-template");
    assert.equal(receipt.initial.deployment.relationships.protocols, lifecycleProtocolToken());
    assert.equal(receipt.initial.deployment.installedReconciler.state, "absent");
    assert.deepEqual(receipt.runReceipt.observations, []);
    assert.equal(existsSync(join(fixture.packageDir, ".workspace", "dagu", "dags", "planning.yaml")), false);

    const enqueued = command("enqueue", "planning-enqueued");
    assert.equal(enqueued.status, 0, enqueued.stderr);
    assert.match(enqueued.stdout, /fixture dagu enqueue reached/);
    assert.match(enqueued.stdout, /receipt=.*sourceVersion=0\.3\.1 deploymentFingerprint=[a-f0-9]{64}/);
    const snapshot = join(fixture.receipt("planning-enqueued"), "..", "snapshot", "planning.yaml");
    const expectedCall = ["enqueue", "--run-id", "planning-enqueued", snapshot, "--", ...params];
    assert.deepEqual(JSON.parse(readFileSync(calls, "utf8").trim()), expectedCall);
    assert.equal(readFileSync(snapshot, "utf8"), receipt.initial.execution.dagSnapshot);
    const enqueuedReceipt = JSON.parse(readFileSync(fixture.receipt("planning-enqueued"), "utf8"));
    assert.equal(enqueuedReceipt.runReceipt.observations[0].kind, "enqueued");
    assert.equal(enqueuedReceipt.runReceipt.observations[0].data.snapshot, snapshot);

    const consumer = join(fixture.packageDir, ".workspace", "dagu", "dags", "planning.yaml");
    mkdirSync(join(consumer, ".."), { recursive: true });
    writeFileSync(consumer, `${receipt.initial.execution.dagSnapshot}\n# injected content\n`);
    const forged = command("enqueue", "planning-forged");
    assert.equal(forged.status, 0, forged.stderr);
    assert.equal(readFileSync(join(fixture.receipt("planning-forged"), "..", "snapshot", "planning.yaml"), "utf8"), receipt.initial.execution.dagSnapshot);

    retireTemplate(join(fixture.packageDir, "skills", "issue-execution", "planning.yaml"));
    const rejected = command("enqueue", "planning-retired");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /DAGU_ADMISSION_REJECTED/);
    assert.match(rejected.stderr, /planning.yaml missing protocol triage=marker-agent\/1; served by bundle 0\.3\.102/);
    assert.equal(existsSync(fixture.receipt("planning-retired")), false);
  } finally {
    fixture.dispose();
  }
});

test("a package release with unchanged answers admits and a corrupt template does not", () => {
  const fixture = admissionFixture();
  try {
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
    fakeDagu(bin, calls);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls };
    const first = fixture.command("admit", "before-release", env);
    assert.equal(first.status, 0, first.stderr);
    const before = JSON.parse(readFileSync(fixture.receipt("before-release"), "utf8"));
    assert.equal(before.sourceVersion.version, "0.3.1");
    assert.equal(before.initial.deployment.installedDAG.version, "0.3.1");
    assert.equal(before.initial.deployment.relationships.compatibility, "installed-template");
    assert.match(before.initial.execution.dagSnapshot, /PRIMARY: "\//);
    assert.match(before.initial.deployment.installedDAG.snapshot, /PRIMARY: "\$\{A4S_PRIMARY\}"/);
    const answersDigest = before.initial.deployment.answers.digest;

    const manifestPath = join(fixture.packageDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "0.4.0" }));
    const committed = spawnSync("git", ["-C", fixture.packageDir, "commit", "-qam", "package 0.4.0"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    const admitted = fixture.command("admit", "after-release", env);
    assert.equal(admitted.status, 0, admitted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("after-release"), "utf8"));
    assert.equal(receipt.sourceVersion.version, "0.4.0");
    assert.equal(receipt.initial.deployment.installedDAG.version, "0.4.0");
    assert.equal(receipt.initial.deployment.answers.digest, answersDigest);
    assert.equal(receipt.initial.deployment.relationships.compatibility, "installed-template");
    assert.equal(receipt.initial.deployment.relationships.protocols, lifecycleProtocolToken());
    assert.equal(receipt.initial.deployment.installedReconciler.state, "absent");

    retireTemplate(join(fixture.packageDir, "skills", "issue-execution", "feature.yaml"));
    const rejected = fixture.command("enqueue", "retired-triage", env);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /DAGU_ADMISSION_REJECTED.*feature.yaml missing protocol triage=marker-agent\/1; served by bundle 0\.3\.102/);
    assert.equal(existsSync(fixture.receipt("retired-triage")), false);
    assert.equal(readFileSync(calls, "utf8"), "");
  } finally { fixture.dispose(); }
});

test("admission rejects missing, invalid and overridden answers before enqueue", () => {
  const fixture = admissionFixture();
  try {
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
    fakeDagu(bin, calls);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls };
    const git = (...args: string[]) => spawnSync("git", ["-C", fixture.packageDir, ...args], { encoding: "utf8" });

    writeFileSync(fixture.answersPath, `${readFileSync(fixture.answersPath, "utf8")}\n`);
    const dirty = fixture.command("admit", "dirty-answers", env);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /uncommitted answers file/);
    git("checkout", "--", ANSWERS_PATH);

    writeFileSync(fixture.answersPath, "{}\n");
    git("add", ANSWERS_PATH);
    git("commit", "-qm", "invalid answers");
    const invalid = fixture.command("admit", "invalid-answers", env);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /answers file is missing|rejected unknown field|schemaVersion/);
    git("rm", "-q", ANSWERS_PATH);
    git("commit", "-qm", "remove answers");
    const missing = fixture.command("admit", "missing-answers", env);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing committed answers file/);
    assert.equal(existsSync(calls) && readFileSync(calls, "utf8").length > 0, false);
  } finally { fixture.dispose(); }
});

test("feature admission rejects policy overrides and records the resolved primary", () => {
  const fixture = admissionFixture();
  try {
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
    fakeDagu(bin, calls);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls };
    for (const parameter of ["GATE=true", "TEST_PATHS=other", "VALIDATION=smoke", "QUEUE_CONCURRENCY=1", "LANE=other", "PRIMARY=/foreign"]) {
      const field = parameter.slice(0, parameter.indexOf("="));
      const result = fixture.command("enqueue", `rejected-${field.toLowerCase()}`, env, [parameter]);
      assert.notEqual(result.status, 0, parameter);
      assert.match(result.stderr, new RegExp(`admission rejected run parameter: ${field}`));
      assert.equal(existsSync(fixture.receipt(`rejected-${field.toLowerCase()}`)), false);
    }
    const accepted = fixture.command("admit", "operational-policy", env, ["PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("operational-policy"), "utf8"));
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    assert.deepEqual(receipt.initial.execution.parameters, ["ISSUE=277", "PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
    assert.equal(readFileSync(calls, "utf8"), "");
  } finally { fixture.dispose(); }
});
