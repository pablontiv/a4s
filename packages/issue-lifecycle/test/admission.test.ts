import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { inProcessAdmissionFixture as admissionFixture } from "./fixtures/compiled-admission.ts";
import { runA4s } from "./fixtures/compiled-cli.ts";
import { CONFIG_PATH, POLICY_PARAMETERS } from "../src/config.ts";
import { admit, appendObservation, enqueueArguments, preflightAdmission } from "../src/admission.ts";
import { assertArtifactReceipt, assertExecutingArtifact } from "../src/artifact-receipt.ts";
import { roleAdmission } from "./role-job-fixtures.ts";
import { identity } from "../src/identity.ts";

const inputs = { dag: "feature", run: "admission", params: ["ISSUE=277", "OMP_SESSION_ID=owner-session"] };
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [[`${entry.name}/`, ""], ...Object.entries(snapshot(path)).map(([name, bytes]) => [`${entry.name}/${name}`, bytes])]
      : [[entry.name, readFileSync(path).toString("hex")]];
  }));
}
test("read-only admission flag preserves real admission arguments and rejects bypasses", () => {
  const args = ["--run-id", "sprint-admission-check", "feature", "--", ...inputs.params];
  assert.equal(enqueueArguments(args, "/consumer").check, undefined);
  assert.equal(enqueueArguments(["--check", ...args], "/consumer").check, true);
  assert.throws(() => enqueueArguments(["--check", "--check", ...args], "/consumer"), /Duplicate admission flag --check/);
  assert.throws(() => enqueueArguments(["--check", "--parent", "receipt.json", ...args], "/consumer"), /--check resolves committed uses/);
  const tuple = `0.6.0@${"a".repeat(40)}#${"b".repeat(64)}`;
  assert.throws(() => enqueueArguments(["--check", "--artifact", tuple, ...args], "/consumer"), /--check resolves committed uses/);
});
test("read-only admission rejects missing owner and dirty or missing committed policy without writes", async () => {
  const fixture = admissionFixture();
  try {
    const check = async (params: string[], reason: RegExp) => {
      const before = snapshot(fixture.root);
      const result = await runA4s(["admit", "--check", "--run-id", "sprint-admission-check", "feature", "--", ...params], { cwd: fixture.packageDir });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /admissible=no/);
      assert.match(result.stdout, reason);
      assert.deepEqual(snapshot(fixture.root), before);
    };
    await check(["ISSUE=277"], /OMP_SESSION_ID/);
    const config = readFileSync(fixture.configPath, "utf8");
    writeFileSync(fixture.configPath, `${config}\n`);
    await check(inputs.params, /uncommitted config file/);
    writeFileSync(fixture.configPath, config);
    for (const args of [["rm", "-q", CONFIG_PATH], ["commit", "-qm", "remove policy"]]) {
      const result = spawnSync("git", ["-C", fixture.packageDir, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    await check(inputs.params, /missing committed config file/);
  } finally { fixture.dispose(); }
});
test("admission validates the owner and committed policy before creating any engine state", async () => {
  const fixture = admissionFixture();
  try {
    for (const field of POLICY_PARAMETERS) {
      assert.throws(() => preflightAdmission({ cwd: fixture.packageDir, ...inputs, params: [...inputs.params, `${field}=override`] }), /admission rejected run parameter/);
    }
    for (const owner of [[], ["OMP_SESSION_ID="], ["OMP_SESSION_ID=one", "OMP_SESSION_ID=two"]]) {
      assert.throws(() => preflightAdmission({ cwd: fixture.packageDir, ...inputs, params: ["ISSUE=277", ...owner] }), /OMP_SESSION_ID/);
    }
    writeFileSync(fixture.configPath, `${readFileSync(fixture.configPath, "utf8")}\n`);
    assert.throws(() => preflightAdmission({ cwd: fixture.packageDir, ...inputs }), /uncommitted config file/);
    assert.equal(existsSync(fixture.receipt(inputs.run)), false);
    assert.equal(existsSync(join(fixture.home, "cache")), false);
    assert.equal(existsSync(join(fixture.home, "role-jobs.sqlite")), false);
    // The public CLI performs the same preflight before contacting GitHub.
    const rejected = await runA4s(["admit", "--run-id", inputs.run, "feature", "--", "ISSUE=277"], { cwd: fixture.packageDir });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /OMP_SESSION_ID/);
    assert.equal(existsSync(fixture.receipt(inputs.run)), false);
  } finally { fixture.dispose(); }
});
test("consumer configuration is required at HEAD, not reconstructed from a checkout", () => {
  const fixture = admissionFixture();
  try {
    const removed = spawnSync("git", ["-C", fixture.packageDir, "rm", "-q", CONFIG_PATH], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
    const committed = spawnSync("git", ["-C", fixture.packageDir, "commit", "-qm", "remove policy"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    assert.throws(() => preflightAdmission({ cwd: fixture.packageDir, ...inputs }), /missing committed config file/);
  } finally { fixture.dispose(); }
});
test("artifact flags are outside runtime parameters and cannot override the parent", () => {
  const tuple = `0.6.0@${"a".repeat(40)}#${"b".repeat(64)}`;
  const args = enqueueArguments(["--parent", "/parent/receipt.json", "--artifact", tuple, "--run-id", "child", "poc", "--", "ISSUE=277", "OMP_SESSION_ID=owner"], "/consumer");
  assert.equal(args.artifact, tuple);
  assert.equal(args.parent, "/parent/receipt.json");
  assert.deepEqual(args.params, ["ISSUE=277", "OMP_SESSION_ID=owner"]);
  assert.throws(() => enqueueArguments(["--artifact", tuple, "--artifact", tuple, "--run-id", "duplicate", "feature"], "/"), /Duplicate admission flag/);
});
test("explicit handoff rejects an executable identity mismatch before any receipt", async () => {
  const fixture = admissionFixture();
  try {
    const artifact = `999.0.0@${"a".repeat(40)}#${"b".repeat(64)}`;
    await assert.rejects(admit({ cwd: fixture.packageDir, ...inputs, artifact }), /identity mismatch/);
    assert.throws(() => assertExecutingArtifact({ version: identity.version, commit: "a".repeat(40), digest: "b".repeat(64) }), /identity mismatch/);
    assert.equal(existsSync(fixture.receipt(inputs.run)), false);
    assert.equal(existsSync(join(fixture.home, "cache")), false);
  } finally { fixture.dispose(); }
});
test("hard cutover rejects missing tuples, declarations, and unsupported contracts", () => {
  const fixture = admissionFixture();
  try {
    const valid = roleAdmission(fixture.packageDir, fixture.home, "bound", '"$A4S_BIN" role-jobs stage triage', { version: identity.version, commit: "a".repeat(40), digest: "b".repeat(64) });
    assertArtifactReceipt(valid, "fixture");
    const clone = () => JSON.parse(JSON.stringify(valid));
    for (const field of ["artifact", "artifactSupport", "contracts"]) {
      const invalid = clone(); delete invalid[field];
      assert.throws(() => assertArtifactReceipt(invalid, "fixture"), /artifact|support|contract|cutover/);
    }
    const legacy = clone(); legacy.schemaVersion = 1;
    assert.throws(() => assertArtifactReceipt(legacy, "fixture"), /cutover/);
    const unsupported = clone(); unsupported.contracts.protocols.triage = "retired/1";
    assert.throws(() => assertArtifactReceipt(unsupported, "fixture"), /protocol|contract/);
    const noBoundary = clone(); delete noBoundary.artifactSupport.dispatch; delete noBoundary.contracts.dispatch;
    assert.throws(() => assertArtifactReceipt(noBoundary, "fixture"), /dispatch boundary: required a4s-run\/1.*missing/);
    const futureBoundary = clone(); futureBoundary.artifactSupport.dispatch = "a4s-run/2";
    assert.throws(() => assertArtifactReceipt(futureBoundary, "fixture"), /dispatch boundary: required a4s-run\/1.*a4s-run\/2/);
    const config = clone(); delete config.initial.deployment.config.digest;
    assert.throws(() => assertArtifactReceipt(config, "fixture"), /config/);
  } finally { fixture.dispose(); }
});
test("read-only observations retain both legacy records and full immutable artifact fields", () => {
  const fixture = admissionFixture();
  try {
    for (const schema of [1, 2] as const) {
      const run = `observe-${schema}`;
      const receipt = roleAdmission(fixture.packageDir, fixture.home, run, '"$A4S_BIN" role-jobs stage triage', { version: identity.version, commit: "a".repeat(40), digest: "b".repeat(64) });
      receipt.schemaVersion = schema;
      if (schema === 1) { delete receipt.artifact; delete receipt.artifactSupport; delete receipt.contracts; }
      const path = fixture.receipt(run);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(receipt));
      appendObservation(path, { dag: "feature", run, attempt: 1, category: "execution", kind: "read-only-report", data: { state: "retained" } });
      const observed = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(observed.initial, receipt.initial);
      assert.deepEqual(observed.artifact, receipt.artifact);
      assert.deepEqual(observed.artifactSupport, receipt.artifactSupport);
      assert.deepEqual(observed.contracts, receipt.contracts);
      assert.equal(observed.schemaVersion, schema);
      assert.equal(observed.runReceipt.observations.length, 1);
    }
  } finally { fixture.dispose(); }
});
