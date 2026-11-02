import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { retirementFixture } from "../../issue-lifecycle/test/fixtures/station-retirement.ts";
import { assertArtifactReceipt } from "../../issue-lifecycle/src/artifact-receipt.ts";
import { main as launcher } from "../src/cli.ts";
import { readRunRetirement, retirementReceipt, retirementStatuses } from "../src/station-retirement.ts";
import { stationBinding } from "../src/station-binding.ts";
import { stationRecovery } from "../src/station-recovery.ts";

for (const nativeStatus of retirementStatuses) {
  test(`retire audits legacy ${nativeStatus} without current PATH, pin, cache restoration, native mutations or receipt writes`, async t => {
    const f = retirementFixture(t, nativeStatus === "succeeded" ? "poc" : "feature");
    const original = readFileSync(f.path), files = readdirSync(dirname(f.path));
    assert.throws(() => assertArtifactReceipt(f.receipt, f.path), /differs from admitted PATH/);
    let locks = 0;
    await f.retire(nativeStatus, { lock: async (path, body) => {
      assert.equal(path, join(dirname(f.path), "station-recovery.lock"));
      assert.equal(f.requests.length, 2, "native HTTP happens before the short per-run commit lock");
      locks++; return body();
    } });
    const evidence = readRunRetirement(f.primary, f.run, f.dag)!;
    assert.deepEqual(evidence, f.evidence());
    assert.equal(evidence.outcome, "retired"); assert.equal(evidence.nativeStatus, nativeStatus);
    assert.equal(evidence.primary, f.primary); assert.equal(evidence.run, f.run); assert.equal(evidence.dag, f.dag);
    assert.equal(evidence.receiptDigest, createHash("sha256").update(original).digest("hex"));
    assert.match(evidence.reason, /Operator abandons/);
    assert.ok(Number.isFinite(Date.parse(evidence.observedAt))); assert.ok(Number.isFinite(Date.parse(evidence.retiredAt)));
    assert.equal(locks, 1); assert.deepEqual(readFileSync(f.path), original);
    assert.deepEqual(readdirSync(dirname(f.path)).sort(), [...files, "station-retirement.json"].sort());
    assert.equal(existsSync(join(f.home, "cache", "a4s", ".state.lock")), false);
  });
}

test("repeating a completed retirement preserves the original reason and bytes without native observation or locking", async t => {
  const f = retirementFixture(t);
  await f.retire();
  const original = readFileSync(f.evidencePath);
  await f.retire("waiting", { fetch: async () => { throw new Error("no repeat native read"); },
    lock: async () => { throw new Error("no repeat lock"); } }, "A later reason must not rewrite the audit record");
  assert.deepEqual(readFileSync(f.evidencePath), original); assert.equal(f.requests.length, 2);
});

for (const mismatch of ["run", "primary", "snapshot", "native-run", "native-dag", "station-target"]) {
  test(`retirement refuses mismatched ${mismatch} evidence before publication`, async t => {
    const f = retirementFixture(t);
    if (mismatch === "run") f.receipt.runReceipt.run = "other-run";
    if (mismatch === "primary") f.receipt.initial.execution.primary = f.root;
    if (mismatch === "snapshot") f.receipt.initial.execution.dagSnapshot += "# other snapshot\n";
    if (mismatch === "station-target") (f.receipt.initial.runtimeAndModels.station as Record<string, unknown>).DAGU_URL = "http://127.0.0.1:18766";
    writeFileSync(f.path, JSON.stringify(f.receipt));
    const changes = mismatch === "native-run" ? { dagRunId: "other-run" } : mismatch === "native-dag" ? { name: "poc" } : {};
    await assert.rejects(f.retire("failed", { fetch: f.request("failed", changes) }), /binding is invalid|invalid DAG\/run binding|snapshot differs|target DAGU_URL mismatch/);
    assert.equal(existsSync(f.evidencePath), false);
  });
}

for (const nativeStatus of ["waiting", "running", "queued", "unknown"]) {
  test(`retirement rejects native ${nativeStatus} without an abort or resume`, async t => {
    const f = retirementFixture(t);
    await assert.rejects(f.retire(nativeStatus), /requires native Failed, Succeeded or Aborted.*Waiting cannot be retired.*verified CANCEL checkpoint/);
    assert.equal(existsSync(f.evidencePath), false); assert.equal(f.requests.length, 1);
  });
}

test("identity-bound retirement verifies only the original native target, not changed tool digests", async t => {
  const f = retirementFixture(t), binding = stationBinding();
  binding.tools.omp!.sha256 = "0".repeat(64);
  f.receipt.initial.runtimeAndModels.station = binding;
  writeFileSync(f.path, JSON.stringify(f.receipt));
  await f.retire(); assert.equal(f.evidence().nativeStatus, "failed");
});

test("retirement refuses identity-bound native retargeting even when tool verification is unnecessary", async t => {
  const f = retirementFixture(t), binding = stationBinding();
  binding.target.inode = "0"; f.receipt.initial.runtimeAndModels.station = binding;
  writeFileSync(f.path, JSON.stringify(f.receipt));
  await assert.rejects(f.retire(), /Station target inode differs from admitted identity/);
  assert.equal(f.requests.length, 0); assert.equal(existsSync(f.evidencePath), false);
});

test("absent retirement evidence does not read or verify a malformed receipt", t => {
  const f = retirementFixture(t); writeFileSync(f.path, "{");
  assert.equal(readRunRetirement(f.primary, f.run, f.dag), undefined);
  assert.throws(() => retirementReceipt(f.primary, f.run), SyntaxError);
});

for (const field of ["receiptDigest", "run", "dag", "primary", "nativeStatus", "reason", "observedAt", "retiredAt", "schemaVersion"]) {
  test(`invalid retirement ${field} is rejected rather than treated as absent`, async t => {
    const f = retirementFixture(t); await f.retire();
    writeFileSync(f.evidencePath, JSON.stringify({ ...f.evidence(), [field]: "invalid" }));
    if (field === "reason") writeFileSync(f.evidencePath, JSON.stringify({ ...f.evidence(), reason: " " }));
    await assert.rejects(f.retire(), /retirement evidence binding is invalid/);
    assert.throws(() => readRunRetirement(f.primary, f.run, f.dag), /retirement evidence binding is invalid/);
    assert.equal(f.requests.length, 2);
  });
}

test("retirement evidence binds exact receipt bytes and the selected DAG and fails closed for malformed JSON", async t => {
  const f = retirementFixture(t); await f.retire();
  assert.throws(() => readRunRetirement(f.primary, f.run, "poc"), /DAG differs/);
  const original = readFileSync(f.path);
  writeFileSync(f.path, Buffer.concat([original, Buffer.from("\n")]));
  assert.throws(() => readRunRetirement(f.primary, f.run), /differs from the receipt bytes/);
  writeFileSync(f.path, original); writeFileSync(f.evidencePath, "{");
  assert.throws(() => readRunRetirement(f.primary, f.run), /unreadable or malformed/);
});

test("retirement rejects receipt changes between native observation and audit publication", async t => {
  const f = retirementFixture(t);
  await assert.rejects(f.retire("failed", { lock: async (_path, body) => {
    writeFileSync(f.path, `${readFileSync(f.path, "utf8")}\n`); return body();
  } }), /receipt bytes changed during observation/);
  assert.equal(existsSync(f.evidencePath), false);
});

test("retirement without a reason is rejected and the stable launcher routes the action without a payload handoff", async t => {
  const f = retirementFixture(t);
  await assert.rejects(stationRecovery(["retire", "--primary", f.primary, "--run", f.run]), /retire: --reason/);
  await f.retire();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("completed retirement must not contact native state"); });
  await launcher(["station-recovery", "retire", "--primary", f.primary, "--run", f.run, "--reason", "Operator abandons this run"]);
  assert.equal(f.evidence().outcome, "retired");
  assert.equal(retirementReceipt(f.primary, f.run).receiptDigest, f.evidence().receiptDigest);
});
