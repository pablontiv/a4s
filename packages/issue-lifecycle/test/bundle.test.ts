import assert from "node:assert/strict";
import test from "node:test";
import { deploymentFingerprint } from "../src/admission.ts";
import { admissionDecision } from "../src/triage/guard.ts";
import { bundleVersionFromLabels, classifyCompatibility, lifecycleProtocolToken } from "../src/bundle.ts";
import { main } from "../src/commands/bundle.ts";

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

test("protocol reporting prints declared contracts, without template inference", async t => {
  let stdout = "";
  t.mock.method(console, "log", (value: string) => { stdout += `${value}\n`; });
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await main(["protocols"]);
    assert.equal(process.exitCode, 0);
    assert.equal(stdout, `${lifecycleProtocolToken()}\n`);
  } finally { process.exitCode = previous; }
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
  const decision = admissionDecision({ toolName: "bash", toolCallId: "enqueue", input: { command: 'for n in 277; do dagu enqueue --run-id "issue-$n" .workspace/dagu/dags/feature.yaml -- ISSUE="$n"; done' } }, { transcriptRoot: "/session" });
  assert.ok(decision && "input" in decision);
  assert.match(decision.input.command, /dagu-feature-bundle.ts' 'enqueue' --run-id \"issue-\$n\"/);
  assert.match(decision.input.command, /extensionDigest/);
  const blocked = admissionDecision({ toolName: "eval", toolCallId: "enqueue", input: { code: 'exec("dagu enqueue --run-id issue-277 feature.yaml")' } });
  assert.ok(blocked && "block" in blocked);
});
