import assert from "node:assert/strict";
import test from "node:test";
import { classifyRuns } from "../src/reconcile-classify.ts";
import { classifyFixture } from "./fixtures/reconcile-bench-classify.ts";

// Wall-clock, overlap, real HTTP, compiled and Dagu benchmarks remain in test/live/.
const page = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, state: "open" }));
function fixture() { return classifyFixture([{ RUN: "waiting", PRIMARY: "/primary", ISSUE: "1", REPO: "example/repo" }]); }

test("a repeated issue page never authorizes a partial issue observation", async () => {
  const f = fixture(); const requests: number[] = [];
  f.dependencies.requestIssues = (_repo, number) => { requests.push(number); return { status: 0, stdout: JSON.stringify(page) }; };
  try {
    await classifyRuns(f.output, f.dependencies);
    assert.deepEqual(requests, [1, 2]);
    assert.equal(f.finished.length, 1); assert.equal(f.finished[0]!.issue, null);
    assert.deepEqual(f.outputs(), { children: [], actions: [], failures: [] });
  } finally { f.dispose(); }
});

test("pagination collects complete pages and resolves the repository only once", async () => {
  const f = classifyFixture([1, 101].map(issue => ({ RUN: `run-${issue}`, PRIMARY: "/primary", ISSUE: String(issue), REPO: "example/repo" })));
  const requests: Array<[string, number, number]> = [];
  f.dependencies.now = () => 0;
  f.dependencies.requestIssues = (repo, number, timeout) => {
    requests.push([repo, number, timeout]);
    return { status: 0, stdout: JSON.stringify(number === 1 ? page : [{ number: 101, state: "closed" }]) };
  };
  try {
    await classifyRuns(f.output, f.dependencies);
    assert.deepEqual(requests, [["example/repo", 1, 8000], ["example/repo", 2, 8000]]);
    assert.deepEqual(f.finished.map(({ issue }) => issue?.state), ["open", "closed"]);
  } finally { f.dispose(); }
});

test("request timeouts respect the remaining budget without sleeps or retries", async () => {
  const f = fixture(); const timeouts: number[] = [];
  let now = 0;
  f.dependencies.now = () => now;
  f.dependencies.requestIssues = (_repo, _number, timeout) => {
    timeouts.push(timeout); now = timeouts.length === 1 ? 19_750 : 20_001;
    return { status: 0, stdout: JSON.stringify(page.map(issue => ({ ...issue, number: issue.number + 100 * timeouts.length }))) };
  };
  try {
    await classifyRuns(f.output, f.dependencies);
    assert.deepEqual(timeouts, [8000, 250]);
    assert.equal(f.finished[0]!.issue, null);
  } finally { f.dispose(); }
});

for (const response of [
  { name: "unavailable", status: 1, stdout: "" },
  { name: "invalid JSON", status: 0, stdout: "not-json" },
  { name: "invalid page shape", status: 0, stdout: '{"number":1}' },
]) {
  test(`${response.name} is one bounded request and cannot emit a partial issue observation`, async () => {
    const f = fixture(); let calls = 0;
    f.dependencies.requestIssues = (_repo, _page, timeout) => { calls++; assert.ok(timeout > 0 && timeout <= 8000); return response; };
    try {
      await classifyRuns(f.output, f.dependencies);
      assert.equal(calls, 1); assert.equal(f.finished[0]!.issue, null);
    } finally { f.dispose(); }
  });
}

test("an invalid discovery shape fails before executing any artifact or GitHub call", async () => {
  const f = fixture(); process.env.RUNS = '{}';
  try {
    await assert.rejects(classifyRuns(f.output, f.dependencies), /discovery output is not a JSON array/);
    assert.deepEqual(f.verifications, []);
  } finally { f.dispose(); }
});
