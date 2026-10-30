import assert from "node:assert/strict";
import { idFromCount, publicationPlan, assertPublishedDigest } from "../../../scripts/release-identity.mjs";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HELPER_API_VERSION } from "@a4s/hot-reload";
import { parse } from "yaml";
import { identity } from "../src/identity.ts";
import { assertReadCoverage, formatSupport } from "../../launcher/src/artifact-support.ts";
import { canonicalJson, registrationHash } from "../../launcher/src/contracts.ts";
import { registrationManifest } from "../src/registration.ts";
import status from "../src/status/index.ts";

const sha = "a".repeat(40);
const eligible = { validated: true, headSha: sha, checkoutSha: sha, version: "r123", tagSha: undefined, lastSha: undefined, firstParent: true, changed: true, exists: false };

test("first-parent counts map to stable IDs without lossy numeric conversion", () => {
  for (const count of ["0", "1", "123", "9007199254740993"]) assert.equal(idFromCount(count), `r${count}`);
  for (const count of ["01", "-1", "1.0", "NaN", ""]) assert.throws(() => idFromCount(count));
});
test("only the same validated head can publish; ID/SHA conflicts and reversed completion fail closed", () => {
  assert.equal(publicationPlan(eligible), true);
  assert.equal(publicationPlan({ ...eligible, validated: false }), false);
  assert.equal(publicationPlan({ ...eligible, changed: false }), false);
  assert.equal(publicationPlan({ ...eligible, changed: false, exists: true, tagSha: sha }), true);
  assert.throws(() => publicationPlan({ ...eligible, checkoutSha: "b".repeat(40) }), /validated head_sha/);
  assert.throws(() => publicationPlan({ ...eligible, tagSha: "b".repeat(40) }), /ID\/SHA conflict/);
  assert.throws(() => publicationPlan({ ...eligible, lastSha: "b".repeat(40), firstParent: false }), /first-parent descendant/);
});
test("same-SHA reruns require identical published digests", () => {
  assertPublishedDigest("archive", "a".repeat(64), "a".repeat(64));
  assert.throws(() => assertPublishedDigest("archive", "a".repeat(64), "b".repeat(64)), /Rerun digest mismatch/);
});
test("shared formats declare read/write support and retain every historical writer", () => {
  assert.deepEqual(Object.keys(identity.support).sort(), ["config", "prCheckpoint", "receipt", "roleJobPayload", "roleJobStore", "runState"]);
  const bridge = structuredClone(formatSupport(identity.support));
  bridge.receipt = { read: [1, 2, 3], write: 2 };
  const writer = { ...bridge, receipt: { read: [1, 2, 3], write: 3 } };
  assertReadCoverage(bridge, { receipt: [1, 2] }, writer);
  assertReadCoverage(writer, { receipt: [1, 2, 3] });
  assert.throws(() => assertReadCoverage(identity.support, { receipt: [1, 2, 3] }), /receipt\/3/);
  assert.throws(() => assertReadCoverage(identity.support, { receipt: [1, 2] }, writer), /receipt\/3/);
});
test("registration manifest is canonical and matches real host registrations", () => {
  assert.equal(canonicalJson({ z: { b: 2, a: 1 }, a: [2, 1] }), '{"a":[2,1],"z":{"a":1,"b":2}}');
  assert.equal(identity.registrationManifestHash, registrationHash(registrationManifest));
  const commands: unknown[] = [], tools: unknown[] = [];
  status({ on() {}, sendMessage() {}, registerCommand(name, command) {
    commands.push({ name, description: command.description, completions: command.getArgumentCompletions?.("")?.map(item => item.value) });
  }, registerTool(tool) { const { execute: _, ...metadata } = tool; tools.push(metadata); } });
  assert.deepEqual(commands, registrationManifest.commands);
  assert.deepEqual(tools, registrationManifest.tools);
  assert.equal(identity.requiredLauncherProtocol, 1);
  assert.equal(registrationManifest.loaderHelperApi, HELPER_API_VERSION);
});

test("release workflow consumes only same-repository validated main runs with full history and explicit shipped inputs", () => {
  const workflow = parse(readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_run"]);
  assert.deepEqual(workflow.on.workflow_run, { workflows: ["CI"], types: ["completed"], branches: ["main"] });
  const job = workflow.jobs.release;
  for (const condition of ["conclusion == 'success'", "event == 'push'", "head_branch == 'main'", "head_repository.full_name == github.repository"]) assert.ok(job.if.includes(condition), condition);
  const checkout = job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with.ref, "${{ github.event.workflow_run.head_sha }}");
  assert.deepEqual(JSON.parse(workflow.env.A4S_SHIPPED_INPUTS), ["packages/issue-lifecycle/**", "packages/hot-reload/**", "packages/loader/**", "packages/launcher/**", "scripts/build-a4s.mjs", "scripts/build-launcher.mjs", "package.json", "package-lock.json"]);
  for (const step of job.steps.filter((step: { run?: string }) => /build:a4s|publish-a4s.mjs publish/.test(step.run ?? ""))) assert.equal(step.if, "steps.publication.outputs.publish == 'true'");
});
