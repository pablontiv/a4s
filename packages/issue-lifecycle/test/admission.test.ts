import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { admissionFixture } from "./fixtures/admission.ts";
import { lifecycleProtocolToken } from "../src/bundle.ts";
import { CONFIG_PATH, POLICY_PARAMETERS } from "../src/config.ts";
import { admit, appendObservation, enqueue, observeRunReceipt } from "../src/admission.ts";
import { runBundle } from "../src/station-executors.ts";
import { dispatchStage } from "../src/role-dispatch.ts";
import { roleAdmission } from "./role-job-fixtures.ts";

function fakeDagu(bin: string, calls: string): void {
  mkdirSync(bin);
  const dagu = join(bin, "dagu");
  writeFileSync(dagu, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "version") {
  console.log("2.24.0");
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
    const params = [`UNITS_FROM=${join(fixture.root, "units.jsonl")}`, "SOURCE=refine", "OMP_SESSION_ID=planning-owner"];
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
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.sourceVersion.version, "0.3.1");
    assert.match(receipt.deploymentFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(receipt.runReceipt.dag, "planning");
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    assert.deepEqual(receipt.initial.execution.parameters, params);
    assert.equal(receipt.initial.deployment.installedDAG.relationship, "materialized-from-config");
    assert.equal(receipt.initial.deployment.installedDAG.version, "0.3.1");
    assert.equal(receipt.initial.deployment.installedDAG.template.path, "skills/issue-execution/planning.yaml");
    assert.equal(receipt.initial.deployment.installedDAG.dagu, "2.24.0");
    assert.equal(receipt.initial.runtimeAndModels.dagu.version, "2.24.0");
    assert.equal(receipt.initial.deployment.config.path, CONFIG_PATH);
    assert.equal(receipt.initial.deployment.config.schemaVersion, 1);
    assert.match(receipt.initial.deployment.config.digest, /^[a-f0-9]{64}$/);
    assert.equal(receipt.initial.deployment.installedDAG.configDigest, receipt.initial.deployment.config.digest);
    assert.equal(receipt.initial.deployment.generatedDagDigest, receipt.initial.deployment.installedDAG.generatedDigest);
    assert.match(receipt.initial.execution.dagSnapshot, /PRIMARY: "\//);
    assert.match(receipt.initial.deployment.installedDAG.snapshot, /PRIMARY: "\$\{A4S_PRIMARY\}"/);
    assert.match(receipt.initial.execution.dagSnapshot, /queue: fixture/);
    assert.equal(receipt.initial.deployment.relationships.installedToSource, "materialized-from-config");
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

test("a package release with unchanged config admits and a corrupt template does not", () => {
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
    const configDigest = before.initial.deployment.config.digest;

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
    assert.equal(receipt.initial.deployment.config.digest, configDigest);
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

test("admission rejects missing, invalid and overridden config before enqueue", () => {
  const fixture = admissionFixture();
  try {
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
    fakeDagu(bin, calls);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls };
    const git = (...args: string[]) => spawnSync("git", ["-C", fixture.packageDir, ...args], { encoding: "utf8" });

    writeFileSync(fixture.configPath, `${readFileSync(fixture.configPath, "utf8")}\n`);
    const dirty = fixture.command("admit", "dirty-config", env);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /uncommitted config file/);
    git("checkout", "--", CONFIG_PATH);

    writeFileSync(fixture.configPath, "{}\n");
    git("add", CONFIG_PATH);
    git("commit", "-qm", "invalid config");
    const invalid = fixture.command("admit", "invalid-config", env);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /config file is missing|rejected unknown field|schemaVersion/);
    git("rm", "-q", CONFIG_PATH);
    git("commit", "-qm", "remove config");
    const missing = fixture.command("admit", "missing-config", env);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing committed config file.*config\.json/);
    assert.equal(existsSync(calls) && readFileSync(calls, "utf8").length > 0, false);
  } finally { fixture.dispose(); }
});

test("every lifecycle admission rejects all policy overrides before writes or enqueue", () => {
  const fixture = admissionFixture();
  try {
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
    fakeDagu(bin, calls);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls };
    const before = { git: readdirSync(join(fixture.packageDir, ".git")), home: readdirSync(fixture.home) };
    for (const dag of ["feature", "poc", "discovery", "planning"]) {
      for (const field of [...POLICY_PARAMETERS, "ESCALATION_PUSHBACKS", "ESCALATION_FINDINGS", "ESCALATION_SECONDS", "ESCALATION_CI_BLOCKED", "ESCALATION_POC_INCONCLUSIVE"]) {
        for (const command of ["admit", "enqueue"]) {
          const run = `rejected-${dag}-${command}-${field.toLowerCase()}`;
          const params = ["ISSUE=277", "OMP_SESSION_ID=owner-session", `${field}=override`];
          assert.throws(() => command === "admit"
            ? admit({ cwd: fixture.packageDir, dag, run, params })
            : enqueue(["--run-id", run, dag, "--", ...params], fixture.packageDir),
          new RegExp(`admission rejected run parameter: ${field}`), `${dag} ${command} ${field}`);
          assert.equal(existsSync(fixture.receipt(run)), false);
        }
      }
    }
    assert.deepEqual({ git: readdirSync(join(fixture.packageDir, ".git")), home: readdirSync(fixture.home) }, before);
    const accepted = fixture.command("admit", "operational-policy", env, ["PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("operational-policy"), "utf8"));
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    assert.equal(receipt.initial.execution.ompSession, "owner-session");
    assert.match(receipt.initial.execution.dagSnapshot, /BASE_BRANCH: "main"/);
    assert.deepEqual(receipt.initial.execution.parameters, ["ISSUE=277", "PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
    assert.equal(readFileSync(calls, "utf8"), "");
  } finally { fixture.dispose(); }
});

test("missing, malformed and duplicate owners fail before receipts, stores or enqueue", () => {
  const fixture = admissionFixture();
  try {
    const before = { git: readdirSync(join(fixture.packageDir, ".git")), home: readdirSync(fixture.home) };
    for (const dag of ["feature", "poc", "discovery", "planning"]) {
      for (const owner of [[], ["OMP_SESSION_ID="], ["OMP_SESSION_ID=bad session"], ["OMP_SESSION_ID=bad\nsession"], [`OMP_SESSION_ID=${"x".repeat(201)}`], ["OMP_SESSION_ID=one", "OMP_SESSION_ID=two"]]) {
        for (const command of ["admit", "enqueue"]) {
          const run = `invalid-owner-${dag}-${command}`;
          const params = ["ISSUE=277", ...owner];
          assert.throws(() => command === "admit"
            ? admit({ cwd: fixture.packageDir, dag, run, params })
            : enqueue(["--run-id", run, dag, "--", ...params], fixture.packageDir), owner.length > 1 ? /OMP_SESSION_ID requires a valid owning session|Ambiguous admission parameters/ : /OMP_SESSION_ID requires a valid owning session/);
          assert.equal(existsSync(fixture.receipt(run)), false);
        }
      }
    }
    for (const command of ["admit", "enqueue"]) {
      const result = fixture.command(command, `owner-cli-${command}`, {}, [], "feature", "");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /OMP_SESSION_ID requires a valid owning session/);
    }
    assert.deepEqual({ git: readdirSync(join(fixture.packageDir, ".git")), home: readdirSync(fixture.home) }, before);
  } finally { fixture.dispose(); }
});

test("receipt readers preserve supported historical versions and reject unsupported versions before effects", async () => {
  const fixture = admissionFixture();
  const run = "receipt-versions";
  const path = fixture.receipt(run);
  const saved = { PRIMARY: process.env.PRIMARY, RUN: process.env.RUN, ISSUE: process.env.ISSUE };
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const receipt = roleAdmission(fixture.packageDir, fixture.home, run, "dagu-role-jobs stage triage");
    const observation = { dag: "feature", run, attempt: 1, category: "eventsAndExternalState" as const, kind: "test", data: {} };
    const details = { name: "feature", dagRunId: run, statusLabel: "running" };
    for (const version of [1, 2] as const) {
      writeFileSync(path, JSON.stringify({ ...receipt, schemaVersion: version }));
      assert.deepEqual(runBundle(fixture.packageDir, run), { version: receipt.sourceVersion.version, commit: receipt.sourceVersion.commit });
      appendObservation(path, observation);
      observeRunReceipt(details, fixture.packageDir);
      const observed = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(observed.schemaVersion, version);
      assert.deepEqual(observed.initial, receipt.initial);
      assert.equal(observed.runReceipt.observations.length, 2);
    }
    Object.assign(process.env, { PRIMARY: fixture.packageDir, RUN: run, ISSUE: "189" });
    for (const version of [0, 3, "2", null, undefined]) {
      const bytes = JSON.stringify({ ...receipt, schemaVersion: version });
      writeFileSync(path, bytes);
      assert.throws(() => runBundle(fixture.packageDir, run), /Unsupported admission receipt schemaVersion=.*supported versions: 1, 2/);
      assert.throws(() => appendObservation(path, observation), /Unsupported admission receipt schemaVersion=/);
      assert.throws(() => observeRunReceipt(details, fixture.packageDir), /Unsupported admission receipt schemaVersion=/);
      await assert.rejects(dispatchStage("triage", () => assert.fail("must not emit"), async () => { throw new Error("must not execute"); }), /Unsupported admission receipt schemaVersion=/);
      assert.equal(readFileSync(path, "utf8"), bytes);
      assert.equal(existsSync(`${path}.lock`), false);
      assert.equal(existsSync(join(path, "..", "role-jobs")), false);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fixture.dispose();
  }
});
