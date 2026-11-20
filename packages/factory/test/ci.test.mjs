import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, shouldRevert, parseWorkflows } from "../src/ci.mjs";
import { finishRun, readCarry, source, carrySection } from "../src/labels.mjs";

const run = (conclusion, workflowName = "CI", status = "completed") => ({ workflowName, status, conclusion, url: `u/${workflowName}`, createdAt: "1" });

test("success", () => { const c = classify([run("success")]); assert.equal(c.state, "success"); assert.equal(shouldRevert(c), false); });
test("failure and timed_out are red", () => {
  for (const k of ["failure", "timed_out"]) { const c = classify([run(k)]); assert.equal(c.state, "red"); assert.equal(c.conclusion, k); assert.ok(shouldRevert(c)); }
});
test("cancelled is not red; later commit decides", () => {
  const c = classify([run("cancelled")]);
  assert.equal(c.state, "cancelled"); assert.equal(shouldRevert(c), false);
  assert.equal(classify([run("success")]).state, "success"); // the later commit's runs
});
test("cancelled with no later commit times out red", () => {
  const c = classify([run("cancelled")], { timedOut: true });
  assert.equal(c.state, "red"); assert.equal(c.conclusion, "timeout");
});
test("no result before timeout is red", () => {
  assert.equal(classify([], { timedOut: true }).state, "red");
  assert.equal(classify([run(null, "CI", "in_progress")], { timedOut: true }).conclusion, "timeout");
});
test("skipped and neutral are not red", () => {
  for (const k of ["skipped", "neutral"]) assert.equal(shouldRevert(classify([run(k)])), false);
});
test("foreign workflow red while CI green: no revert; foreign green alone is no success", () => {
  assert.equal(classify([run("success"), run("failure", "Other")]).state, "success");
  assert.equal(classify([run("success", "Other")]).state, "running");
});
test("counted workflow not registered yet is running", () => {
  const c = classify([run("success")], { workflows: ["CI", "Lint"] });
  assert.equal(c.state, "running"); assert.equal(c.workflow, "Lint");
  assert.equal(classify([], {}).state, "running");
});
test("parseWorkflows default", () => { assert.deepEqual(parseWorkflows(""), ["CI"]); assert.deepEqual(parseWorkflows("CI, Lint"), ["CI", "Lint"]); });

test("failing ci step leaves findings in carry.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-"));
  const file = join(dir, "issues.json");
  writeFileSync(file, JSON.stringify([{ number: 9, labels: [{ name: "factory:running" }], body: "" }]));
  const state = join(dir, "state"); mkdirSync(join(state, "9"), { recursive: true });
  writeFileSync(join(state, "9", "step-failure.json"), JSON.stringify({ run: "r1", step: "ci", findings: ["ci: CI was 'failure' for abc (u)"] }));
  const r = finishRun(source({ issuesFile: file }), { issue: "9", state, run: "r1", steps: "ci=failed" });
  assert.equal(r.failed, "ci");
  assert.match(readCarry(state, "9").findings[0], /failure/);
  assert.doesNotMatch(carrySection(state, "9"), /none recorded/);
});

import { waitForCi } from "../src/ci.mjs";
const flow = (over) => waitForCi({
  sha: "A", deadline: 100, now: () => 100, sleep: async () => {}, pollMs: 0,
  runs: async (s) => over.runs[s] ?? [], tip: async () => over.tip ?? "A", contains: async () => over.contains ?? true,
});
test("flow: cancelled at the deadline with an already-green descendant -> success, no revert", async () => {
  const r = await flow({ runs: { A: [run("cancelled")], B: [run("success")] }, tip: "B" });
  assert.equal(r.state, "success"); assert.equal(r.target, "B"); assert.equal(shouldRevert(r), false);
});
test("flow: cancelled, descendant not containing the SHA is ignored -> timeout red", async () => {
  const r = await flow({ runs: { A: [run("cancelled")], B: [run("success")] }, tip: "B", contains: false });
  assert.equal(r.state, "red"); assert.equal(r.conclusion, "timeout");
});
test("flow: cancelled with no later commit at the deadline -> red timeout", async () => {
  const r = await flow({ runs: { A: [run("cancelled")] } });
  assert.equal(r.state, "red"); assert.equal(r.conclusion, "timeout");
});
test("flow: waits (before deadline) for the later commit to turn green", async () => {
  let t = 0, n = 0;
  const r = await waitForCi({ sha: "A", deadline: 1000, now: () => t, sleep: async () => { t += 10; }, pollMs: 0,
    runs: async (s) => s === "A" ? [run("cancelled")] : (++n < 3 ? [run(null, "CI", "in_progress")] : [run("success")]),
    tip: async () => "B", contains: async () => true });
  assert.equal(r.state, "success");
});
test("flow: red descendant after cancelled original is red", async () => {
  const r = await flow({ runs: { A: [run("cancelled")], B: [run("failure")] }, tip: "B" });
  assert.equal(r.state, "red"); assert.equal(r.conclusion, "failure");
});

test("flow: CI cancelled + Lint unregistered on A, B green on both -> success via descendant", async () => {
  const r = await waitForCi({
    sha: "A", deadline: 100, now: () => 100, sleep: async () => {}, pollMs: 0, workflows: ["CI", "Lint"],
    runs: async (s) => s === "A" ? [run("cancelled")] : [run("success"), run("success", "Lint")],
    tip: async () => "B", contains: async () => true,
  });
  assert.equal(r.state, "success"); assert.equal(shouldRevert(r), false);
});

import { revertBlocker } from "../src/ci.mjs";
test("revertBlocker: only the run's own commit, only while it is the tip", () => {
  const ok = { sha: "abc", head: "abc", tip: "abc", message: "t (#1)\n\nFactory-Run: run-1\n", run: "run-1" };
  assert.equal(revertBlocker(ok), null);
  assert.match(revertBlocker({ ...ok, tip: "def" }), /no longer the tip/);
  assert.match(revertBlocker({ ...ok, head: "def" }), /no longer the tip/);
  assert.match(revertBlocker({ ...ok, run: "run-2" }), /not a commit of run run-2/);
  assert.match(revertBlocker({ ...ok, run: "run-." }), /not a commit of run/);
  assert.match(revertBlocker({ ...ok, sha: "" }), /no merged commit/);
  // the remote tip cannot be read: fail closed, never trust a stale tracking ref
  assert.match(revertBlocker({ ...ok, remoteError: "git ls-remote origin exited 128: fatal" }), /cannot verify the current tip of the remote trunk/);
  assert.match(revertBlocker({ ...ok, tip: "" }), /cannot verify/);
});
