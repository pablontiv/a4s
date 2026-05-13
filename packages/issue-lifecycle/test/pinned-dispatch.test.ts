import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import type { Receipt } from "../src/admission.ts";
import { artifactToken } from "../../launcher/src/release.ts";
import { RunArtifactScope, verifiedRun } from "../src/run-artifact.ts";
import { runMutationDecision } from "../src/triage/run-guard.ts";
import { cachedArtifact, context, receipt, tuple } from "./fixtures/reconcile-bench-classify.ts";

// Cross-release executable dispatch, rendering and native mutations run in test/live/.
const root = realpathSync(mkdtempSync(join(tmpdir(), "pinned-dispatch-unit-")));
const primary = join(root, "primary"), home = join(root, "station");
mkdirSync(primary); mkdirSync(home);
execFileSync("git", ["init", "--quiet", primary]);
after(() => rmSync(root, { recursive: true, force: true }));
function save(run: string) {
  const path = join(primary, ".git/dagu-feature/runs", run, "receipt.json");
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(receipt(primary, home, run)));
  return path;
}

test("plugin mutations select the run's verified artifact rather than ambient station executable", async () => {
  const previous = process.env;
  process.env = { ...previous, A4S_BIN: "/station/version-b/a4s", A4S_ARTIFACT: "station-sentinel" };
  const verified: Array<[string, string]> = [];
  const verify: typeof verifiedRun = async (location, run) => { verified.push([location, run]); return context(location, run, home); };
  const quote = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;
  try {
    for (const [action, args] of [
      ["dagu human-task complete feature --run-id version-a --step validation --expected-iteration 0 --input APPROVE=yes", ["native", "human-task", "complete", "feature", "--run-id", "version-a", "--step", "validation", "--expected-iteration", "0", "--input", "APPROVE=yes"]],
      ["a4s protect release --decision complete", ["protect", "release", "--decision", "complete"]],
      ["a4s role-jobs stage triage", ["role-jobs", "stage", "triage"]],
      ["a4s run --primary '" + primary + "' --run version-a -- escalation ci", ["escalation", "ci"]],
    ] as const) {
      const decision = await runMutationDecision({ toolName: "bash", toolCallId: "dispatch", input: {
        command: `PRIMARY='${primary}' RUN=version-a A4S_BIN=/ambient/a4s A4S_ARTIFACT=ambient KEEP='operator value' ${action}`, cwd: primary,
      } }, primary, verify);
      assert.ok(decision && "input" in decision);
      assert.equal(decision.input.command, "KEEP='operator value' " + [cachedArtifact(home).executable, "run", "--primary", primary, "--run", "version-a", "--artifact", artifactToken(tuple), "--", ...args].map(quote).join(" "));
      assert.equal(decision.input.cwd, primary);
    }
    assert.deepEqual(verified, Array.from({ length: 4 }, () => [primary, "version-a"]));
    assert.equal(process.env.A4S_ARTIFACT, "station-sentinel");
  } finally { process.env = previous; }
});

test("unsupported receipts block every mutation without changing caller input", async () => {
  const verify: typeof verifiedRun = async () => { throw new Error("Unsupported receipt config/receipt/protocol/job-store contracts"); };
  for (const action of ["dagu retry feature --run-id unsupported", "a4s protect release --decision denied", "a4s role-jobs stage triage"]) {
    const input = { command: `PRIMARY='${primary}' RUN=unsupported ${action}` };
    const original = structuredClone(input);
    const decision = await runMutationDecision({ toolName: "bash", toolCallId: "reject", input }, primary, verify);
    assert.ok(decision && "block" in decision);
    assert.match(decision.reason, /A4S_RUN_UNSUPPORTED:.*contracts/);
    assert.deepEqual(input, original);
  }
});

test("non-mutating commands bypass verification and ambiguous shell mutations fail closed", async () => {
  const verify: typeof verifiedRun = async () => { throw new Error("Verification must not be reached"); };
  for (const command of ["git status", "a4s protect status", "a4s role-jobs capacity", "a4s role-jobs detect"]) {
    assert.equal(await runMutationDecision({ toolName: "bash", toolCallId: "read", input: { command } }, primary, verify), undefined);
  }
  for (const [toolName, input] of [
    ["eval", { code: "dagu retry feature --run-id version-a" }],
    ["bash", { command: "dagu retry feature --run-id $(cat run)" }],
    ["bash", { command: "a4s run --primary /primary --run version-a" }],
  ] as const) {
    const decision = await runMutationDecision({ toolName, toolCallId: "syntax", input }, primary, verify);
    assert.ok(decision && "block" in decision);
    assert.match(decision.reason, /literal|requires --/);
    assert.doesNotMatch(decision.reason, /Verification must not be reached/);
  }
});

test("tick scope shares artifact evidence but rereads every receipt and expires with the tick", async () => {
  const previous = process.env; process.env = { ...previous, DAGU_HOME: home };
  const firstPath = save("first"), secondPath = save("second");
  const cached = cachedArtifact(home); let inspections = 0; let modified = false;
  const inspect = async (station: string, artifact: typeof tuple) => {
    inspections++; assert.equal(station, home); assert.deepEqual(artifact, tuple);
    if (modified) throw new Error("Modified artifact payload");
    return cached;
  };
  try {
    const scope = new RunArtifactScope(inspect);
    const first = await scope.verify(primary, "first"), second = await scope.verify(primary, "second");
    assert.equal(first.cached, second.cached); assert.equal(inspections, 1); assert.equal(scope.artifactVerifications, 1);
    const changed = JSON.parse(readFileSync(secondPath, "utf8")); changed.contracts.roleJobStore = 999;
    writeFileSync(secondPath, JSON.stringify(changed));
    await assert.rejects(scope.verify(primary, "second"), /Unsupported receipt roleJobStore contract: /);
    assert.equal(inspections, 1); assert.equal((await scope.verify(primary, "first")).cached, first.cached);
    modified = true;
    await assert.rejects(new RunArtifactScope(inspect).verify(primary, "first"), /Modified artifact payload/);
    assert.equal(inspections, 2);
    assert.deepEqual(readdirSync(dirname(firstPath)), ["receipt.json"]);
    assert.deepEqual(readdirSync(dirname(secondPath)), ["receipt.json"]);
  } finally { process.env = previous; }
});

test("verified dispatch binds receipt run, primary and station before accepting cached evidence", async () => {
  const previous = process.env; process.env = { ...previous, DAGU_HOME: home };
  const path = save("identity-mismatch");
  try {
    for (const patch of [
      (value: Receipt) => { value.runReceipt.run = "another-run"; },
      (value: Receipt) => { value.initial.execution.primary = "/another-primary"; },
      (value: Receipt) => { value.initial.runtimeAndModels.daguHome = "/another-station"; },
    ]) {
      const value = receipt(primary, home, "identity-mismatch"); patch(value); writeFileSync(path, JSON.stringify(value));
      await assert.rejects(verifiedRun(primary, "identity-mismatch", async () => cachedArtifact(home)), /location\/identity mismatch/);
    }
    await assert.rejects(verifiedRun(primary, "../ambiguous", async () => cachedArtifact(home)), /unambiguous run ID/);
  } finally { process.env = previous; }
});
