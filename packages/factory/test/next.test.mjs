import test from "node:test";
import assert from "node:assert/strict";
import { analyze, pickNext, validateLimits, daguInFlight, fetchIssues } from "../src/next.mjs";
import { checkIssue } from "../src/issue-contract.mjs";

const body = (blocked) => `## Goal\ng\n\n## Acceptance criteria\n- [ ] a\n\n## Out of scope\nno\n${blocked ? `\n## Blocked by\n${blocked}\n` : ""}`;
const mk = (number, ms, blocked, extra = {}) => ({ number, state: "open", labels: ["factory", ms], body: body(blocked), ...extra });
const closed = (number, stateReason = "completed") => ({ number, state: "closed", stateReason, labels: ["factory"], body: "" });
const nums = (l) => l.map((i) => i.number);

test("no free slot: empty list", () => {
  assert.deepEqual(pickNext([mk(1, "M0")], [{ number: 9 }], { maxActiveRuns: 1 }), []);
});
test("one free slot", () => {
  assert.deepEqual(nums(pickNext([mk(2, "M0"), mk(1, "M0")], [], { maxActiveRuns: 1 })), [1]);
});
test("maxActiveRuns 3 with one in flight picks two", () => {
  assert.deepEqual(nums(pickNext([mk(1, "M0"), mk(2, "M0"), mk(3, "M0")], [{ number: 9 }], { maxActiveRuns: 3 })), [1, 2]);
});
test("ordered by milestone, then number", () => {
  assert.deepEqual(nums(pickNext([mk(1, "M2"), mk(5, "M1"), mk(3, "M1"), mk(9, "M0")], [], { maxActiveRuns: 4 })), [9, 3, 5, 1]);
});
test("a conflicting candidate is skipped, also against one picked in the same call", () => {
  const c = (a, b) => a.number === 1 && b.number === 9 || a.number === 2 && b.number === 3 || a.number === 3 && b.number === 2;
  assert.deepEqual(nums(pickNext([mk(1, "M0"), mk(2, "M0"), mk(3, "M0"), mk(4, "M0")], [{ number: 9 }], { maxActiveRuns: 3 }, c)), [2, 4]);
});
test("blocked by an open issue is never picked; completed blocker unblocks", () => {
  const issues = [mk(1, "M0", "- #7"), mk(2, "M0", "#8"), { ...mk(7, "M0"), labels: ["factory", "M0", "factory:hold"] }, closed(8)];
  assert.deepEqual(nums(pickNext(issues, [], { maxActiveRuns: 5 })), [2]);
});
test("excluded: ready, hold, no milestone, contract", () => {
  const issues = [{ ...mk(1, "M0"), labels: ["factory", "M0", "factory:ready"] }, { ...mk(2, "M0"), labels: ["factory", "M0", "factory:hold"] },
    { number: 3, state: "open", labels: ["factory"], body: body() }, { ...mk(4, "M0"), body: "x" }, { ...mk(5, "M0"), labels: ["M0"] }];
  const r = analyze(issues, [], { maxActiveRuns: 5 });
  assert.deepEqual(r.picked, []);
  assert.equal(r.log.filter((l) => /rejected #3/.test(l)).length, 1);
  assert.equal(r.log.filter((l) => /rejected #4/.test(l)).length, 1);
});
test("blocker closed as not planned puts the issue on hold", () => {
  const r = analyze([mk(1, "M0", "#8"), closed(8, "not_planned")], [], { maxActiveRuns: 2 });
  assert.deepEqual(r.picked, []);
  assert.deepEqual(r.holds, [{ number: 1, blocker: 8 }]);
});
test("cycles: nobody picked, one comment each, not repeated", () => {
  const issues = [mk(1, "M0", "#2"), mk(2, "M0", "#3"), mk(3, "M0", "#1"), mk(4, "M0")];
  const r = analyze(issues, [], { maxActiveRuns: 5 });
  assert.deepEqual(nums(r.picked), [4]);
  assert.deepEqual(r.cycles[0].members, [1, 2, 3]);
  assert.deepEqual(r.cycles[0].notify, [1, 2, 3]);
  issues[0].comments = [{ body: r.cycles[0].comment }];
  assert.deepEqual(analyze(issues, [], { maxActiveRuns: 5 }).cycles[0].notify, [2, 3]);
});
test("Blocked by in the issue contract", () => {
  assert.equal(checkIssue(body("#1\n- #2, #3")).ok, true);
  const r = checkIssue(body("#1\nsoon"));
  assert.match(r.problems[0], /malformed entry "soon"/);
});
test("limits validation names field, expected and observed", () => {
  assert.throws(() => validateLimits({ version: 1, maxActiveRuns: 0 }), /maxActiveRuns.*integer >= 1.*0/);
  assert.throws(() => validateLimits({ version: 2, maxActiveRuns: 1 }), /version.*expected 1.*2/);
  assert.throws(() => validateLimits({ version: 1, maxActiveRuns: 1.5 }), /1\.5/);
  assert.equal(validateLimits({ version: 1, maxActiveRuns: 3 }).maxActiveRuns, 3);
});
test("capacity skips are logged, also with no free slot", () => {
  const r = analyze([mk(1, "M0"), mk(2, "M0")], [], { maxActiveRuns: 1 });
  assert.ok(r.log.some((l) => /skipped #2.*no free slot/.test(l)));
  const r0 = analyze([mk(1, "M0")], [{ number: 9 }], { maxActiveRuns: 1 });
  assert.ok(r0.log.some((l) => /skipped #1.*no free slot/.test(l)));
});
test("a closed blocker without an explicit completed reason keeps the issue blocked", () => {
  const unknown = { number: 8, state: "closed", labels: ["factory"], body: "" };
  const r = analyze([mk(1, "M0", "#8"), unknown], [], { maxActiveRuns: 2 });
  assert.deepEqual(r.picked, []);
  assert.ok(r.log.some((l) => /skipped #1.*#8/.test(l)));
});

test("admit.yaml reads issues with pagination to exhaustion (no fixed --limit)", async () => {
  const { readFileSync } = await import("node:fs");
  const y = readFileSync(new URL("../dags/admit.yaml", import.meta.url), "utf8");
  const tail = y.slice(y.indexOf("mechanical ordering"));
  assert.ok(!/--limit(?!s)/.test(tail));
  assert.ok(/--fetch-issues/.test(tail));
});

test("fetchIssues: an eligible issue past the first page is picked; a blocker state past the first page is honoured", () => {
  const body = mk(1, "M0").body;
  const pages = [];
  for (let i = 0; i < 100; i++) pages.push({ number: 1000 + i, state: "closed", stateReason: "completed", labels: [], body: "" });
  pages.push({ number: 2000, state: "closed", stateReason: "not_planned", labels: [], body: "" });
  pages.push({ number: 5, state: "open", stateReason: null, labels: ["factory", "M0"], body });
  pages.push({ number: 6, state: "open", stateReason: null, labels: ["factory", "M1"], body: mk(6, "M1", "#2000").body });
  const calls = [];
  const gh = (args) => { calls.push(args); return pages.map((p) => JSON.stringify(p)).join("\n") + "\n"; };
  const issues = fetchIssues("https://github.com/o/r.git", gh);
  assert.ok(calls[0].includes("--paginate") && !calls[0].some((x) => /limit/.test(x)));
  const r = analyze(issues, [], { maxActiveRuns: 2 });
  assert.deepEqual(r.picked.map((i) => i.number), [5]);
  assert.deepEqual(r.holds, [{ number: 6, blocker: 2000 }]);
});

test("daguInFlight with a run past the first page blocks picking at maxActiveRuns 1; fromDate is explicit", async () => {
  const page1 = Array.from({ length: 500 }, (_, i) => ({ name: "cycle", dagRunId: `factory-issue-${2000 + i}-1`, statusLabel: "succeeded" }));
  const urls = [];
  const fetchFn = async (u) => { urls.push(u); return { ok: true, json: async () => (u.includes("cursor=c2") ? { dagRuns: [{ name: "cycle", dagRunId: "factory-issue-7-1", statusLabel: "running" }] } : { dagRuns: page1, nextCursor: "c2" }) }; };
  const inFlight = await daguInFlight({ url: "http://x", fetchFn });
  assert.ok(urls.every((u) => /fromDate=\d+/.test(u)));
  assert.deepEqual(pickNext([mk(1, "M0")], inFlight, { maxActiveRuns: 1 }), []);
});

test("daguInFlight follows nextCursor to find an active run beyond the first page", async () => {
  const page1 = Array.from({ length: 500 }, (_, i) => ({ name: "cycle", dagRunId: `factory-issue-${2000 + i}-1`, statusLabel: "succeeded" }));
  const page2 = [{ name: "cycle", dagRunId: "factory-issue-7-1", statusLabel: "running" }];
  const urls = [];
  const fetchFn = async (u) => { urls.push(u); const second = u.includes("cursor=c2"); return { ok: true, json: async () => (second ? { dagRuns: page2 } : { dagRuns: page1, nextCursor: "c2" }) }; };
  const r = await daguInFlight({ url: "http://x", fetchFn });
  assert.deepEqual(r.map((x) => x.number), [7]);
  assert.equal(urls.length, 2);
});
