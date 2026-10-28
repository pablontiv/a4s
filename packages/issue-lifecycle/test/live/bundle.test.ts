import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deploymentFingerprint, observeRunReceipt } from "../../src/admission.ts";
import { admissionDecision } from "../../src/triage/guard.ts";
import { admissionFixture } from "../fixtures/admission.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { bundleVersionFromLabels, classifyCompatibility, lifecycleProtocolToken } from "../../src/bundle.ts";


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
