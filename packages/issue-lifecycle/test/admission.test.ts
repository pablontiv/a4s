import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { admissionFixture } from "./fixtures/admission.ts";
import { lifecycleProtocolToken, REQUIRED_DAGU_VERSION } from "../src/bundle.ts";

test("planning CLI admission seals provenance and enqueue submits the admitted snapshot", () => {
  const fixture = admissionFixture();
  try {
    const dag = join(fixture.packageDir, ".workspace", "dagu", "dags", "planning.yaml");
    fixture.render("planning.yaml", dag);
    const original = readFileSync(dag, "utf8");
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
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
    const params = [`PRIMARY=${fixture.packageDir}`, `UNITS_FROM=${join(fixture.root, "units.jsonl")}`, "SOURCE=refine", "OMP_SESSION_ID=planning-owner"];
    const command = (subcommand: string, run: string) => spawnSync(process.execPath, [fixture.cli, subcommand, "--run-id", run, dag, "--", ...params], {
      cwd: fixture.packageDir,
      env: { ...process.env, DAGU_HOME: fixture.home, PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls },
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
    assert.equal(receipt.initial.execution.dagSnapshot, original);
    assert.equal(receipt.initial.deployment.installedDAG.relationship, "verified-source-render");
    assert.equal(receipt.initial.deployment.installedDAG.stamp.version, "0.3.1");
    assert.equal(receipt.initial.deployment.installedDAG.sourceTemplate.path, "skills/issue-execution/planning.yaml");
    assert.deepEqual(receipt.runReceipt.observations, []);

    const enqueued = command("enqueue", "planning-enqueued");
    assert.equal(enqueued.status, 0, enqueued.stderr);
    assert.match(enqueued.stdout, /fixture dagu enqueue reached/);
    assert.match(enqueued.stdout, /receipt=.*sourceVersion=0\.3\.1 deploymentFingerprint=[a-f0-9]{64}/);
    const snapshot = join(fixture.receipt("planning-enqueued"), "..", "snapshot", "planning.yaml");
    const expectedCall = ["enqueue", "--run-id", "planning-enqueued", snapshot, "--", ...params];
    assert.deepEqual(JSON.parse(readFileSync(calls, "utf8").trim()), expectedCall);
    assert.equal(readFileSync(snapshot, "utf8"), original);
    const enqueuedReceipt = JSON.parse(readFileSync(fixture.receipt("planning-enqueued"), "utf8"));
    assert.equal(enqueuedReceipt.runReceipt.observations[0].kind, "enqueued");
    assert.equal(enqueuedReceipt.runReceipt.observations[0].data.snapshot, snapshot);

    const rejectedRenders = [
      { run: "planning-incompatible", contents: original.replace("triage=role-job/1", "triage=human-task/1"), error: /planning.yaml missing protocol triage=human-task\/1; served by bundle 0\.3\.108/ },
      { run: "planning-foreign-owner", contents: original.replaceAll("example/fixture@", "foreign/repository@"), error: /planning.yaml origin=foreign\/repository expected=example\/fixture/ },
      { run: "planning-false-version", contents: original.replaceAll("0.3.1", "0.3.2"), error: /planning.yaml declared=0\.3\.2 source package=0\.3\.1/ },
      { run: "planning-ambiguous-owner", contents: `${original}\n  - dagu-feature-bundle=0.3.1\n`, error: /source\/label ambiguous/ },
      { run: "planning-forged-render", contents: `${original}\n# injected content\n`, error: /expected a render/ },
    ];
    for (const rejected of rejectedRenders) {
      writeFileSync(dag, rejected.contents);
      const result = command("enqueue", rejected.run);
      assert.notEqual(result.status, 0, rejected.run);
      assert.match(result.stderr, /DAGU_ADMISSION_REJECTED/);
      assert.match(result.stderr, rejected.error);
      assert.equal(existsSync(fixture.receipt(rejected.run)), false);
      assert.deepEqual(JSON.parse(readFileSync(calls, "utf8").trim()), expectedCall);
    }
  } finally {
    fixture.dispose();
  }
});

test("admission admits a minor-behind served protocol and rejects a retired one before enqueue", () => {
  const fixture = admissionFixture();
  try {
    const feature = readFileSync(fixture.dag, "utf8");
    assert.match(feature.split("\n", 1)[0] ?? "", new RegExp(` protocols=${lifecycleProtocolToken()}$`));
    const bin = join(fixture.root, "bin");
    const calls = join(fixture.root, "enqueue-calls.jsonl");
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
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, ADMISSION_ENQUEUE_CALLS: calls };
    const manifestPath = join(fixture.packageDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "0.4.0" }));
    const committed = spawnSync("git", ["-C", fixture.packageDir, "commit", "-qam", "package 0.4.0"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    const admitted = fixture.command("admit", "minor-behind", env);
    assert.equal(admitted.status, 0, admitted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("minor-behind"), "utf8"));
    assert.equal(receipt.sourceVersion.version, "0.4.0");
    assert.equal(receipt.initial.deployment.installedDAG.stamp.version, "0.3.1");
    assert.equal(receipt.initial.deployment.installedDAG.stamp.protocols.triage, "role-job/1");
    assert.equal(receipt.initial.deployment.relationships.compatibility, "served-lifecycle-protocol");
    assert.equal(receipt.initial.deployment.relationships.protocols, lifecycleProtocolToken());

    const strip = (path: string): void => writeFileSync(path, readFileSync(path, "utf8").replace(/ protocols=\S+/, ""));
    strip(fixture.dag);
    strip(join(fixture.home, "dags", "reconcile.yaml"));
    const legacy = fixture.command("admit", "legacy-served", env);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(JSON.parse(readFileSync(fixture.receipt("legacy-served"), "utf8")).initial.deployment.installedDAG.stamp.protocols.implement, "role-job/1");

    writeFileSync(fixture.dag, readFileSync(fixture.dag, "utf8").replace(
      "  - id: triage\n    depends: admit\n    run: |\n      set -euo pipefail\n      dagu-feature-bundle escalation route\n      dagu-role-jobs stage triage\n",
      "  - id: triage\n    depends: admit\n    action: human.task\n    with:\n      prompt: triage\n",
    ));
    const rejected = fixture.command("enqueue", "retired-triage", env);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /DAGU_ADMISSION_REJECTED.*feature.yaml missing protocol triage=human-task\/1; served by bundle 0\.3\.108/);
    assert.equal(existsSync(fixture.receipt("retired-triage")), false);
    assert.equal(existsSync(calls), false);
  } finally { fixture.dispose(); }
});
