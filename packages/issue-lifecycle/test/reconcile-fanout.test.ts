import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { classifyRuns } from "../src/reconcile-classify.ts";
import { classifyFixture, context, routed } from "./fixtures/reconcile-bench-classify.ts";

// Real compiled/bash equivalence and persisted-byte benchmarks live in test/live/.
test("classification fans protected PR runs out and batches issue observations by repository", async () => {
  const rows = [
    { RUN: "wait-ci", PRIMARY: "/alpha", ISSUE: "1", REPO: "example/alpha", BRANCH: "dagu/issue-1", PR_NUMBER: "101" },
    { RUN: "wait-merge", PRIMARY: "/alpha", ISSUE: "2", REPO: "example/alpha" },
    { RUN: "implement", PRIMARY: "/alpha", ISSUE: "3", REPO: "example/alpha" },
    { RUN: "triage", PRIMARY: "/alpha", ISSUE: "4", REPO: "example/alpha" },
    { RUN: "beta", PRIMARY: "/beta", ISSUE: "5", REPO: "example/beta" },
    { RUN: "unavailable", PRIMARY: "/alpha", ISSUE: "6", REPO: "example/alpha" },
    { RUN: "bad-primary", ISSUE: "7" },
  ];
  const f = classifyFixture(rows);
  const requests: string[] = [];
  f.dependencies.inspect = row => routed(row, row.RUN!.startsWith("wait-") ? "child" : row.RUN === "unavailable" ? "root" : "issue");
  f.dependencies.requestIssues = repo => {
    requests.push(repo);
    return { status: 0, stdout: JSON.stringify(repo === "example/alpha" ? [{ number: 3, state: "open" }, { number: 4, state: "closed", closed_at: "2026-01-02T00:00:00Z" }] : [{ number: 5, state: "open" }]) };
  };
  try {
    await classifyRuns(f.output, f.dependencies);
    assert.deepEqual(f.outputs(), { children: [
      { RUN: "wait-ci", ISSUE: "1", PRIMARY: "/alpha", BRANCH: "dagu/issue-1", PR_NUMBER: "101", REPO: "example/alpha" },
      { RUN: "wait-merge", ISSUE: "2", PRIMARY: "/alpha", BRANCH: "", PR_NUMBER: "", REPO: "example/alpha" },
    ], actions: [], failures: [{ run: "bad-primary", cause: "discovery row missing RUN or PRIMARY" }] });
    assert.deepEqual(requests, ["example/alpha", "example/beta"]);
    assert.deepEqual(f.finished.map(({ item, issue }) => [item.run, issue?.state ?? null]), [["implement", "open"], ["triage", "closed"], ["beta", "open"], ["unavailable", null]]);
    assert.deepEqual(f.verifications, ["wait-ci", "wait-merge", "implement", "triage", "beta", "unavailable", "implement", "triage", "beta", "unavailable"]);
  } finally { f.dispose(); }
});

test("classification rechecks receipts before writes without blocking independent runs", async () => {
  const f = classifyFixture(["changed", "compatible", "missing"].map(RUN => ({ RUN, PRIMARY: "/primary", ISSUE: "1", REPO: "example/repo" })));
  const counts = new Map<string, number>();
  f.dependencies.scope!.verify = async (primary, run) => {
    const count = (counts.get(run) ?? 0) + 1; counts.set(run, count);
    if (run === "missing" || run === "changed" && count > 1) throw new Error("Unsupported receipt job-store\nchanged");
    return context(primary, run);
  };
  f.dependencies.requestIssues = () => ({ status: 0, stdout: '[{"number":1,"state":"open"}]' });
  try {
    await classifyRuns(f.output, f.dependencies);
    assert.deepEqual(f.finished.map(({ item }) => item.run), ["compatible"]);
    assert.deepEqual(f.outputs().failures, [
      { run: "missing", cause: "artifact unavailable or unsupported; inspect rejected: Unsupported receipt job-store changed" },
      { run: "changed", cause: "artifact unavailable or unsupported; observation rejected: Unsupported receipt job-store changed" },
    ]);
    assert.equal(counts.get("compatible"), 2);
  } finally { f.dispose(); }
});

test("foreign artifacts dispatch by primary and run instead of station implementations", async () => {
  const f = classifyFixture([{ RUN: "foreign", PRIMARY: "/primary", ISSUE: "7", REPO: "example/repo" }]);
  const calls: string[][] = [];
  f.dependencies.scope!.locally = async () => ({ local: false });
  f.dependencies.inspect = () => { throw new Error("Station inspection must not run"); };
  f.dependencies.finish = () => { throw new Error("Station observation must not run"); };
  f.dependencies.requestIssues = () => ({ status: 0, stdout: '[{"number":7,"state":"closed"}]' });
  f.dependencies.invoke = async (primary, run, args, options) => {
    assert.equal(primary, "/primary"); assert.equal(run, "foreign");
    assert.equal(options?.capture, true);
    calls.push(args);
    return { status: 0, stderr: "", stdout: args[1] === "inspect" ? JSON.stringify(routed({ RUN: run, PRIMARY: primary, ISSUE: "7" })) : "ORPHAN example/repo#7 foreign implement issue=CLOSED" };
  };
  try {
    await classifyRuns(f.output, f.dependencies);
    assert.deepEqual(calls.map(args => args.slice(0, 2)), [["reconcile", "inspect"], ["reconcile", "finish"]]);
    assert.deepEqual(JSON.parse(calls[1]![3]!), { number: 7, state: "closed" });
    assert.deepEqual(f.outputs(), { children: [], actions: [], failures: [] });
  } finally { f.dispose(); }
});

test("empty discovery writes all declared outputs and cannot trigger either fanout", async () => {
  const documents = parseAllDocuments(readFileSync(new URL("../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8"));
  const root = documents[0]!.toJS() as { steps: Array<{ id: string; outputs?: Array<{ name: string }>; preconditions?: Array<{ expected: string }>; parallel?: { items: string; max_concurrent: number }; with?: { dag: string } }> };
  const classify = root.steps.find(step => step.id === "classify")!;
  const tick = root.steps.find(step => step.id === "tick")!;
  const act = root.steps.find(step => step.id === "act")!;
  assert.deepEqual(classify.outputs?.map(item => item.name), ["children", "actions", "failures"]);
  assert.equal(tick.parallel?.items, "${steps.classify.outputs.children}");
  assert.equal(tick.parallel?.max_concurrent, 4); assert.equal(tick.with?.dag, "reconcile-run");
  assert.equal(act.parallel?.items, "${steps.classify.outputs.actions}"); assert.equal(act.parallel?.max_concurrent, 4);
  assert.equal(tick.preconditions?.[0]?.expected, "re:^\\[.+\\]$");
  assert.equal(act.preconditions?.[0]?.expected, tick.preconditions?.[0]?.expected);
  const f = classifyFixture([]);
  try {
    await classifyRuns(f.output, f.dependencies);
    assert.deepEqual(f.outputs(), { children: [], actions: [], failures: [] });
    assert.doesNotMatch(JSON.stringify(f.outputs().children), /^\[.+\]$/);
    assert.doesNotMatch(JSON.stringify(f.outputs().actions), /^\[.+\]$/);
    assert.deepEqual(f.verifications, []);
  } finally { f.dispose(); }
});
