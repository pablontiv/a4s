import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admissionFixture } from "./fixtures/admission.ts";
import { liveDagu } from "./fixtures/live-dagu.ts";

import { BUNDLE_VERSION } from "../src/bundle.ts";
const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
const stamp = `# dagu-feature-bundle: @a4s/omp-dagu@${BUNDLE_VERSION} source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-probe dagu=2.20.1\nlabels:\n  - dagu-feature-bundle=${BUNDLE_VERSION}\n`;

test("CLI reports stamped repositories and the reconciler as compatible", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(repo, ".workspace", "dagu", "dags"), { recursive: true });
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "feature.yaml"), `${stamp}env:\n  - PRIMARY: "/canonical/repo"\n  - GATE: "npm test"\n  - REQUIRED_CHECK: "validate"\n`);
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "poc.yaml"), `${stamp}env:\n  - PRIMARY: "/canonical/repo"\n`);
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "discovery.yaml"), stamp);
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "planning.yaml"), stamp);
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), stamp);
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.20.1\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, [cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["feature", "poc", "discovery", "planning", "reconcile"]) {
      assert.ok(result.stdout.includes(`${name}.yaml `), result.stdout);
    }
    assert.equal((result.stdout.match(/compat=ok/g) ?? []).length, 6);
    assert.match(result.stdout, /dagu version="2\.20\.1" required=2\.20\.1 compat=ok/);
    assert.match(result.stdout, /feature.yaml policy PRIMARY="\/canonical\/repo" GATE="npm test" REQUIRED_CHECK="validate" BRANCH=dagu\/issue-\$\{ISSUE\}/);
    assert.match(result.stdout, /poc.yaml policy PRIMARY="\/canonical\/repo"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exits nonzero for unstamped repository DAGs", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(repo, ".workspace", "dagu", "dags"), { recursive: true });
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "feature.yaml"), "labels:\n");
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "poc.yaml"), "labels:\n");
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "discovery.yaml"), "labels:\n");
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "planning.yaml"), "labels:\n");
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), stamp);
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.20.1\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, [cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /feature\.yaml .*stamp=unstamped compat=unstamped/);
    assert.match(result.stdout, /poc\.yaml .*stamp=unstamped compat=unstamped/);
    assert.match(result.stdout, /discovery\.yaml .*stamp=unstamped compat=unstamped/);
    assert.match(result.stdout, /planning\.yaml .*stamp=unstamped compat=unstamped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission rejects adopted policy parameters before reserving a receipt", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    for (const parameter of ["GATE=true", "REBASE_RESOLVER=true", "REQUIRED_CHECK=arbitrary", "PRIMARY=/foreign/clone", "BRANCH=off-pattern"]) {
      const field = parameter.slice(0, parameter.indexOf("="));
      const run = `rejected-${field.toLowerCase()}`;
      const result = fixture.command("enqueue", run, {}, [parameter]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`admission rejected run parameter: ${field}`), result.stderr);
      assert.ok(result.stderr.includes(`"PRIMARY":${JSON.stringify(fixture.packageDir)}`), result.stderr);
      assert.match(result.stderr, /"BRANCH":"dagu\/issue-277"/);
      assert.equal(existsSync(join(fixture.packageDir, ".git", "dagu-feature", "runs", run)), false);
    }
    const accepted = fixture.command("admit", "operational-policy", {}, ["PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("operational-policy"), "utf8"));
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    assert.deepEqual(receipt.initial.execution.parameters, ["ISSUE=277", "PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
  } finally { fixture.dispose(); }
});

test("admission rejects package 0.3.1 / DAG 0.2.0 before Dagu creates a run", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    fixture.render("feature.yaml", fixture.dag, "0.2.0");
    const result = fixture.command("enqueue", "incompatible");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DAGU_ADMISSION_REJECTED.*feature.yaml observed=0.2.0.*package=0.3.1/);
    assert.match(result.stderr, /bootstrap.*adopt.*reload/);
    assert.equal(existsSync(fixture.receipt("incompatible")), false);
    const history = spawnSync("dagu", ["history", "feature", "--format", "json"], { env: { ...process.env, DAGU_HOME: fixture.home }, encoding: "utf8" });
    assert.doesNotMatch(history.stdout, /incompatible/);
  } finally { fixture.dispose(); }
});

test("admission admits renders sealed at an earlier patch release and rejects another minor", liveDagu, () => {
  for (const [version, admitted] of [["0.3.2", true], ["0.4.0", false]] as const) {
    const fixture = admissionFixture();
    try {
      const manifestPath = join(fixture.packageDir, "package.json");
      writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version }));
      spawnSync("git", ["-C", fixture.packageDir, "commit", "-qam", `package ${version}`], { encoding: "utf8" });
      const run = `patch-${version.replaceAll(".", "-")}`;
      const result = fixture.command("admit", run);
      if (admitted) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(readFileSync(fixture.receipt(run), "utf8")).initial.deployment.installedDAG.stamp.version, "0.3.1");
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`DAGU_ADMISSION_REJECTED.*feature.yaml observed=0\\.3\\.1.*package=${version.replaceAll(".", "\\.")}`));
      }
    } finally { fixture.dispose(); }
  }
});

test("compatible admission enqueues exact bytes and keeps historical receipt across redeployment", liveDagu, () => {
  const fixture = admissionFixture();
  const run = `compatible-${randomUUID()}`;
  const redeployedRun = `after-redeploy-${randomUUID()}`;
  try {
    const result = fixture.command("enqueue", run);
    assert.equal(result.status, 0, result.stderr);
    const path = fixture.receipt(run);
    const initialReceipt = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(initialReceipt.sourceVersion.version, "0.3.1");
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
    writeFileSync(join(fixture.packageDir, "agents", "triage-reviewer.md"), "Changed effective agent instructions\n");
    const next = fixture.command("enqueue", redeployedRun);
    assert.equal(next.status, 0, next.stderr);
    const nextReceipt = JSON.parse(readFileSync(fixture.receipt(redeployedRun), "utf8"));
    assert.notEqual(nextReceipt.deploymentFingerprint, initialReceipt.deploymentFingerprint);
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

test("admission rejects unreadable, ambiguous, forged render and stale loaded identities", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    rmSync(join(fixture.home, "dags", "reconcile.yaml"));
    const unreadable = fixture.command("enqueue", "unreadable");
    assert.notEqual(unreadable.status, 0);
    assert.match(unreadable.stderr, /DAGU_ADMISSION_REJECTED.*reconcile.yaml/);
    fixture.render("reconcile.yaml", join(fixture.home, "dags", "reconcile.yaml"));
    const original = readFileSync(fixture.dag, "utf8");
    writeFileSync(fixture.dag, `${original}\n  - dagu-feature-bundle=0.3.1\n`);
    const ambiguous = fixture.command("enqueue", "ambiguous");
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /ambiguous/);
    writeFileSync(fixture.dag, `${original}\n# injected code\n`);
    const forged = fixture.command("enqueue", "forged");
    assert.notEqual(forged.status, 0);
    assert.match(forged.stderr, /expected a render/);
    writeFileSync(fixture.dag, original);
    const stale = fixture.command("enqueue", "stale", { DAGU_ADMISSION_SESSION: JSON.stringify({ extensionDigest: "old-loaded-digest", transcriptRoot: "/session" }) });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /loaded extension digest=old-loaded-digest.*restart OMP/);
  } finally { fixture.dispose(); }
});
