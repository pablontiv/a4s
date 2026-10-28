import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deploymentFingerprint, observeRunReceipt } from "../src/admission.ts";
import { admissionDecision } from "../src/triage/guard.ts";
import { admissionFixture } from "./fixtures/admission.ts";
import { liveDagu } from "./fixtures/live-dagu.ts";
import { bundleVersionFromLabels, classifyCompatibility, lifecycleProtocolToken } from "../src/bundle.ts";

test("compatibility accepts patch drift and distinguishes incompatible and unstamped versions", () => {
  assert.equal(classifyCompatibility("0.2.0", "0.2.0"), "ok");
  assert.equal(classifyCompatibility("0.2.9", "0.2.0"), "ok");
  assert.equal(classifyCompatibility("0.3.8", "0.3.18"), "ok");
  assert.equal(classifyCompatibility("0.3.0", "0.2.0"), "incompatible");
  assert.equal(classifyCompatibility("1.2.0", "2.2.0"), "incompatible");
  assert.equal(classifyCompatibility(undefined, "0.2.0"), "unstamped");
  assert.equal(classifyCompatibility("1.9.0", "1.2.0"), "incompatible");
  assert.equal(classifyCompatibility("not-semver", "0.2.0"), "incompatible");
});

test("protocol reporting prints declared contracts, without template inference", () => {
  const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
  const printed = spawnSync(process.execPath, [cli, "protocols"], { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${lifecycleProtocolToken()}\n`);
});

test("observation can read version labels", () => {
  assert.equal(bundleVersionFromLabels(["workspace=a4s", "dagu-feature-bundle=0.2.4"]), "0.2.4");
  assert.equal(bundleVersionFromLabels(["workspace=a4s"]), undefined);
});

test("deployment fingerprints are key-order independent and detect effective identity changes", () => {
  assert.equal(deploymentFingerprint({ package: { version: "0.3.1", digest: "abc" }, dag: "a" }), deploymentFingerprint({ dag: "a", package: { digest: "abc", version: "0.3.1" } }));
  assert.notEqual(deploymentFingerprint({ package: { digest: "abc" } }), deploymentFingerprint({ package: { digest: "def" } }));
});

test("admission hook preserves effective shell arguments and requires bash for enqueue", () => {
  const decision = admissionDecision({ toolName: "bash", toolCallId: "enqueue", input: { command: 'for n in 277; do dagu enqueue --run-id \"issue-$n\" .workspace/dagu/dags/feature.yaml -- ISSUE=\"$n\"; done' } }, { transcriptRoot: "/session" });
  assert.ok(decision && "input" in decision);
  assert.match(decision.input.command, /dagu-feature-bundle.ts' 'enqueue' --run-id \"issue-\$n\"/);
  assert.match(decision.input.command, /extensionDigest/);
  const blocked = admissionDecision({ toolName: "eval", toolCallId: "enqueue", input: { code: 'exec(\"dagu enqueue --run-id issue-277 feature.yaml\")' } });
  assert.ok(blocked && "block" in blocked);
});

test("admission hook blocks enqueue when the committed config file is missing", () => {
  const fixture = admissionFixture();
  try {
    const removed = spawnSync("git", ["-C", fixture.packageDir, "rm", "-q", ".workspace/dagu/config.json"], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
    const committed = spawnSync("git", ["-C", fixture.packageDir, "commit", "-qm", "remove config"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    const rejected = admissionDecision({ toolName: "bash", toolCallId: "incompatible", input: { command: `dagu enqueue --run-id blocked feature -- ISSUE=277 OMP_SESSION_ID=owner-session` } }, undefined, fixture.packageDir);
    assert.ok(rejected && "block" in rejected);
    assert.match(rejected.reason, /missing committed config file/);
  } finally { fixture.dispose(); }
});

test("runtime observations and incident snapshots link the admitted run and preserve initial identities", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    const admitted = fixture.command("admit", "observed");
    assert.equal(admitted.status, 0, admitted.stderr);
    const before = JSON.parse(readFileSync(fixture.receipt("observed"), "utf8"));
    const run = { name: "feature", dagRunId: "observed", statusLabel: "waiting", params: `PRIMARY=${fixture.packageDir}`, nodes: [{ step: { name: "implement" }, statusLabel: "waiting", approvalIteration: 2 }] };
    observeRunReceipt(run, fixture.packageDir);
    observeRunReceipt(run, fixture.packageDir);
    observeRunReceipt({ ...run, statusLabel: "failed" }, fixture.packageDir, "timeout", "TimeoutError");
    const after = JSON.parse(readFileSync(fixture.receipt("observed"), "utf8"));
    assert.deepEqual(after.initial, before.initial);
    assert.equal(after.deploymentFingerprint, before.deploymentFingerprint);
    assert.equal(after.runReceipt.observations.length, before.runReceipt.observations.length + 2);
    assert.equal(after.runReceipt.observations.at(-2).data.run.nodes[0].approvalIteration, 2);
    assert.equal(after.runReceipt.observations.at(-1).kind, "incident:timeout");
    assert.equal(after.runReceipt.observations.at(-1).run, "observed");
    assert.equal(after.runReceipt.observations.at(-1).attempt, 1);
    const restart = fixture.observe("observed", { dag: "feature", run: "observed", attempt: 1, category: "eventsAndExternalState", kind: "runtime", data: { observerPid: -1 } });
    assert.equal(restart.status, 0, restart.stderr);
    observeRunReceipt({ ...run, receiptEvent: { id: "recovered-event", type: "dag.run.waiting", source: "dagu-persisted-event-log", cursorReset: true } }, fixture.packageDir, "persisted-transition");
    const recovered = JSON.parse(readFileSync(fixture.receipt("observed"), "utf8"));
    assert.equal(recovered.runReceipt.observations.at(-2).kind, "incident:observer-restart");
    assert.equal(recovered.runReceipt.observations.at(-1).kind, "incident:cursor-reset");
    assert.deepEqual(recovered.initial, before.initial);
  } finally { fixture.dispose(); }
});
