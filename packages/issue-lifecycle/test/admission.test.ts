import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { admissionFixture } from "./fixtures/admission.ts";
import { REQUIRED_DAGU_VERSION } from "../src/bundle.ts";

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
      { run: "planning-incompatible", contents: original.replaceAll("0.3.1", "0.2.0"), error: /planning.yaml observed=0\.2\.0/ },
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
