import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deploymentFingerprint, observeRunReceipt } from "../src/admission.ts";
import { admissionDecision } from "../src/triage/guard.ts";
import { admissionFixture } from "./fixtures/admission.ts";
import { liveDagu } from "./fixtures/live-dagu.ts";
import {
  BUNDLE_VERSION,
  REQUIRED_DAGU_VERSION,
  RETIRED_PROTOCOL_BUNDLES,
  bundleVersionFromLabels,
  classifyCompatibility,
  formatProtocolRejection,
  inferLifecycleProtocols,
  lifecycleProtocolToken,
  LIFECYCLE_PROTOCOLS,
  missingLifecycleProtocols,
  parseBundleStamp,
} from "../src/bundle.ts";

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

test("admission uses served checkpoint protocols instead of version distance", () => {
  assert.equal(classifyCompatibility("0.4.0", "0.5.0"), "incompatible");
  assert.deepEqual(missingLifecycleProtocols(LIFECYCLE_PROTOCOLS), []);
  assert.deepEqual(missingLifecycleProtocols({ ...LIFECYCLE_PROTOCOLS, triage: "role-job/1" }), []);
  const retired = missingLifecycleProtocols({ ...LIFECYCLE_PROTOCOLS, triage: "marker-agent/1" });
  assert.equal(formatProtocolRejection("feature.yaml", retired), `feature.yaml missing protocol triage=marker-agent/1; served by bundle ${RETIRED_PROTOCOL_BUNDLES["triage=marker-agent/1"]}`);
  const humanTask = missingLifecycleProtocols({ ...LIFECYCLE_PROTOCOLS, triage: "human-task/1" });
  assert.equal(formatProtocolRejection("feature.yaml", humanTask), `feature.yaml missing protocol triage=human-task/1; served by bundle ${RETIRED_PROTOCOL_BUNDLES["triage=human-task/1"]}`);
  const unknown = missingLifecycleProtocols({ ...LIFECYCLE_PROTOCOLS, publication: "legacy/1" });
  assert.equal(formatProtocolRejection("feature.yaml", unknown), `feature.yaml missing protocol publication=legacy/1; bundle ${BUNDLE_VERSION} serves publication=${LIFECYCLE_PROTOCOLS.publication}`);
  const feature = readFileSync(fileURLToPath(new URL("../skills/issue-execution/feature.yaml", import.meta.url)), "utf8");
  assert.deepEqual(inferLifecycleProtocols("feature.yaml", feature), LIFECYCLE_PROTOCOLS);
  const legacyHumanTask = feature.replace(
    "  - id: triage\n    depends: admit\n    run: |\n      set -euo pipefail\n      dagu-feature-bundle escalation route\n      dagu-role-jobs stage triage\n",
    "  - id: triage\n    depends: admit\n    action: human.task\n    with:\n      prompt: triage\n",
  );
  assert.equal(inferLifecycleProtocols("feature.yaml", legacyHumanTask).triage, "human-task/1");
  assert.equal(inferLifecycleProtocols("feature.yaml", feature.replace("dagu-role-jobs verify-triage", "TRIAGE_REVIEW AGENT=triage-reviewer")).triage, "marker-agent/1");
  assert.deepEqual(inferLifecycleProtocols("reconcile.yaml", "steps:\n"), LIFECYCLE_PROTOCOLS);
  const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
  const printed = spawnSync(process.execPath, [cli, "protocols"], { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${lifecycleProtocolToken()}\n`);
});

test("labels and exact line-one stamps are parsed", () => {
  assert.equal(bundleVersionFromLabels(["workspace=a4s", "dagu-feature-bundle=0.2.4"]), "0.2.4");
  assert.equal(bundleVersionFromLabels(["workspace=a4s"]), undefined);
  assert.deepEqual(
    parseBundleStamp(
      `# dagu-feature-bundle: @a4s/issue-lifecycle@0.2.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-a4s-0.2.0 dagu=${REQUIRED_DAGU_VERSION}\nlabels:\n`,
    ),
    {
      version: "0.2.0",
      source: "pablontiv/a4s@0123456789012345678901234567890123456789",
      bootstrap: "bootstrap-a4s-0.2.0",
      dagu: REQUIRED_DAGU_VERSION,
    },
  );
  assert.deepEqual(
    parseBundleStamp(
      `# dagu-feature-bundle: @a4s/issue-lifecycle@0.4.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-a4s-0.4.0 dagu=${REQUIRED_DAGU_VERSION} protocols=${lifecycleProtocolToken()}\n`,
    )?.protocols,
    LIFECYCLE_PROTOCOLS,
  );
  assert.equal(parseBundleStamp(`# dagu-feature-bundle: @a4s/issue-lifecycle@0.4.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-a4s-0.4.0 dagu=${REQUIRED_DAGU_VERSION} protocols=triage=role-job/1\n`), undefined);
  assert.equal(parseBundleStamp(`labels:\n# dagu-feature-bundle: @a4s/issue-lifecycle@0.2.0 source=x@y bootstrap=z dagu=${REQUIRED_DAGU_VERSION}\n`), undefined);
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

test("retired triage protocol is rejected after the isolated home resolves PRIMARY", () => {
  const fixture = admissionFixture();
  try {
    const durable = readFileSync(fixture.dag, "utf8");
    assert.match(durable, /PRIMARY: "\$\{A4S_PRIMARY\}"/);
    assert.equal(durable.includes(fixture.packageDir), false);
    writeFileSync(fixture.dag, durable.replace("triage=role-job/1", "triage=marker-agent/1"));
    const rejected = admissionDecision({ toolName: "bash", toolCallId: "incompatible", input: { command: `dagu enqueue --run-id blocked ${fixture.dag} -- ISSUE=277` } }, undefined, fixture.packageDir);
    assert.ok(rejected && "block" in rejected);
    assert.match(rejected.reason, /DAGU_ADMISSION_REJECTED.*missing protocol triage=marker-agent\/1; served by bundle 0\.3\.102/);
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
    writeFileSync(fixture.dag, readFileSync(fixture.dag, "utf8").replace("triage=role-job/1", "triage=marker-agent/1"));
    const rejected = admissionDecision({ toolName: "bash", toolCallId: "incompatible", input: { command: `dagu enqueue --run-id blocked ${fixture.dag} -- ISSUE=277` } }, undefined, fixture.packageDir);
    assert.ok(rejected && "block" in rejected);
    assert.match(rejected.reason, /DAGU_ADMISSION_REJECTED.*missing protocol triage=marker-agent\/1; served by bundle 0\.3\.102/);
  } finally { fixture.dispose(); }
});
