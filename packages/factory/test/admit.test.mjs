import test from "node:test";
import assert from "node:assert/strict";
import { isAdmissible, isDuplicate, runIdFor, labelNames } from "../src/admit.mjs";

test("only factory:ready admits; plain factory never does", () => {
  assert.equal(isAdmissible({ labels: [{ name: "factory:ready" }] }), true);
  assert.equal(isAdmissible({ labels: ["factory:ready"] }), true);
  assert.equal(isAdmissible({ labels: [{ name: "factory" }] }), false);
  assert.equal(isAdmissible({}), false);
  assert.deepEqual(labelNames({ labels: [{ name: "a" }, "b"] }), ["a", "b"]);
});
test("run-id carries the attempt number", () => {
  assert.equal(runIdFor(5), "factory-issue-5-1");
  assert.equal(runIdFor(5, 2), "factory-issue-5-2");
});
test("duplicate detection", () => {
  assert.equal(isDuplicate('Error: DAG "cycle" with ID "x" already exists'), true);
  assert.equal(isDuplicate("boom"), false);
});
