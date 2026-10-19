import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deploymentFingerprint, observeRunReceipt } from "../src/admission.ts";
import { admissionDecision } from "../src/triage/guard.ts";
import { admissionFixture, isolatedDagu } from "./fixtures/admission.ts";
import {
  BUNDLE_NAME,
  BUNDLE_VERSION,
  bundleVersionFromLabels,
  classifyCompatibility,
  parseBundleStamp,
  REQUIRED_DAGU_VERSION,
} from "../src/bundle.ts";

test("package metadata is the bundle compatibility authority", () => {
  assert.equal(BUNDLE_NAME, "@a4s/omp-dagu");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(BUNDLE_VERSION, manifest.version);
  assert.equal(REQUIRED_DAGU_VERSION, "2.20.1");
});

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

test("labels and exact line-one stamps are parsed", () => {
  assert.equal(bundleVersionFromLabels(["workspace=a4s", "dagu-feature-bundle=0.2.4"]), "0.2.4");
  assert.equal(bundleVersionFromLabels(["workspace=a4s"]), undefined);
  assert.deepEqual(
    parseBundleStamp(
      "# dagu-feature-bundle: @a4s/omp-dagu@0.2.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-a4s-0.2.0 dagu=2.20.1\nlabels:\n",
    ),
    {
      version: "0.2.0",
      source: "pablontiv/a4s@0123456789012345678901234567890123456789",
      bootstrap: "bootstrap-a4s-0.2.0",
      dagu: "2.20.1",
    },
  );
  assert.equal(parseBundleStamp("labels:\n# dagu-feature-bundle: @a4s/omp-dagu@0.2.0 source=x@y bootstrap=z dagu=2.20.1\n"), undefined);
});

test("deployment fingerprints are key-order independent and detect effective identity changes", () => {
  assert.equal(deploymentFingerprint({ package: { version: "0.3.1", digest: "abc" }, dag: "a" }), deploymentFingerprint({ dag: "a", package: { digest: "abc", version: "0.3.1" } }));
  assert.notEqual(deploymentFingerprint({ package: { digest: "abc" } }), deploymentFingerprint({ package: { digest: "def" } }));
});

test("admission hook preserves effective shell arguments and requires bash for enqueue", () => {
  const decision = admissionDecision({ toolName: "bash", toolCallId: "enqueue", input: { command: 'for n in 277; do dagu enqueue --run-id \"issue-$n\" .workspace/dagu/dags/feature.yaml -- ISSUE=\"$n\"; done' } }, { transcriptRoot: "/session" });
  assert.ok(decision && "input" in decision);
  assert.match(decision.input.command, /dagu-feature-bundle.ts' enqueue --run-id \"issue-\$n\"/);
  assert.match(decision.input.command, /extensionDigest/);
  const blocked = admissionDecision({ toolName: "eval", toolCallId: "enqueue", input: { code: 'exec(\"dagu enqueue --run-id issue-277 feature.yaml\")' } });
  assert.ok(blocked && "block" in blocked);
});

test("runtime observations and incident snapshots link the admitted run and preserve initial identities", isolatedDagu, () => {
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
    assert.equal(after.runReceipt.observations.length, 2);
    assert.equal(after.runReceipt.observations[0].data.run.nodes[0].approvalIteration, 2);
    assert.equal(after.runReceipt.observations[1].kind, "incident:timeout");
    assert.equal(after.runReceipt.observations[1].run, "observed");
    assert.equal(after.runReceipt.observations[1].attempt, 1);
    const restart = fixture.observe("observed", { dag: "feature", run: "observed", attempt: 1, category: "eventsAndExternalState", kind: "runtime", data: { observerPid: -1 } });
    assert.equal(restart.status, 0, restart.stderr);
    observeRunReceipt({ ...run, receiptEvent: { id: "recovered-event", type: "dag.run.waiting", source: "dagu-persisted-event-log", cursorReset: true } }, fixture.packageDir, "persisted-transition");
    const recovered = JSON.parse(readFileSync(fixture.receipt("observed"), "utf8"));
    assert.equal(recovered.runReceipt.observations.at(-2).kind, "incident:observer-restart");
    assert.equal(recovered.runReceipt.observations.at(-1).kind, "incident:cursor-reset");
    assert.deepEqual(recovered.initial, before.initial);
    fixture.render("feature.yaml", fixture.dag, "0.2.0");
    const rejected = admissionDecision({ toolName: "bash", toolCallId: "incompatible", input: { command: `dagu enqueue --run-id blocked ${fixture.dag} -- ISSUE=277` } }, undefined, fixture.packageDir);
    assert.ok(rejected && "block" in rejected);
    assert.match(rejected.reason, /DAGU_ADMISSION_REJECTED.*observed=0.2.0/);
  } finally { fixture.dispose(); }
});
