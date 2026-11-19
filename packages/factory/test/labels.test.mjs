import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit, EXIT } from "../src/admit.mjs";
import { finishRun, labelNames, moveLabel, readAttempts, source } from "../src/labels.mjs";
import { decideAfterFailure, isRetryable, OUTCOMES } from "../src/lib.mjs";

const BODY = "## Goal\nx\n\n## Acceptance criteria\n- [ ] y\n\n## Out of scope\nz\n";
function fixture(labels = ["factory:ready"]) {
  const dir = mkdtempSync(join(tmpdir(), "labels-"));
  const file = join(dir, "issues.json");
  writeFileSync(file, JSON.stringify([{ number: 9, labels: labels.map((name) => ({ name })), body: BODY }]));
  const fakeDagu = join(dir, "dagu");
  writeFileSync(fakeDagu, `#!/bin/sh\necho "$@" >> "${dir}/enqueued"\nexit \${FAKE_RC:-0}\n`);
  chmodSync(fakeDagu, 0o755);
  const state = join(dir, "state");
  const labels_ = () => labelNames(JSON.parse(readFileSync(file, "utf8"))[0]);
  const enq = () => { try { return readFileSync(join(dir, "enqueued"), "utf8"); } catch { return ""; } };
  return { dir, file, fakeDagu, state, labels: labels_, enq, src: source({ issuesFile: file }) };
}
const silent = (fn) => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return fn(); } finally { console.log = l; console.error = e; } };
const run = (f) => silent(() => admit({ issue: "9", issuesFile: f.file, state: f.state, dag: "/x/cycle.yaml", params: [] }, f.fakeDagu));
const seedImpl = (f, outcome, extra = {}) => { mkdirSync(join(f.state, "9"), { recursive: true }); writeFileSync(join(f.state, "9", "impl.json"), JSON.stringify({ attempts: [{ threadId: "t", outcome, ...extra }] })); };

test("moveLabel keeps exactly one state label and leaves the others", () => {
  const f = fixture(["factory", "factory:needs-human"]);
  moveLabel(f.src, 9, "ready");
  assert.deepEqual(f.labels(), ["factory", "factory:ready"]);
  moveLabel(f.src, 9, "running");
  assert.deepEqual(f.labels(), ["factory", "factory:running"]);
  moveLabel(f.src, 9, "done");
  assert.deepEqual(f.labels(), ["factory"]);
});

test("retry decision follows the policy table: only blocked/pass need no new run", () => {
  assert.deepEqual(OUTCOMES.filter(isRetryable), ["fail", "malformed", "timeout", "cancelled", "infra"]);
  for (const o of ["fail", "malformed", "timeout", "cancelled", "infra"]) { assert.equal(decideAfterFailure(o, 1), "ready"); assert.equal(decideAfterFailure(o, 2), "ready"); assert.equal(decideAfterFailure(o, 3), "needs-human"); }
  assert.equal(decideAfterFailure("blocked", 1), "needs-human");
  assert.equal(decideAfterFailure("weird", 1), "needs-human");
});

test("admission moves ready -> running and uses run-id -<k>", () => {
  const f = fixture();
  assert.equal(run(f), EXIT.ADMITTED);
  assert.deepEqual(f.labels(), ["factory:running"]);
  assert.match(f.enq(), /--run-id factory-issue-9-1 /);
  assert.equal(run(f), EXIT.NOT_LABELLED); // running is not admissible
});

test("a failure is retried as -2, then -3, then needs-human with a comment", () => {
  const f = fixture();
  const steps = "prepare=succeeded,implement=failed";
  for (let k = 1; k <= 3; k++) {
    seedImpl(f, "fail");
    assert.equal(run(f), EXIT.ADMITTED);
    assert.match(f.enq(), new RegExp(`--run-id factory-issue-9-${k} `));
    const r = finishRun(f.src, { issue: 9, state: f.state, run: `factory-issue-9-${k}`, steps });
    assert.equal(r.to, k < 3 ? "ready" : "needs-human");
  }
  assert.deepEqual(f.labels(), ["factory:needs-human"]);
  const comment = JSON.parse(readFileSync(f.file, "utf8"))[0].comments.at(-1);
  assert.match(comment, /Outcome: fail/);
  assert.match(comment, /Failed step: implement/);
  assert.match(comment, /Question:/);
  // a human puts ready back: a new attempt (-4) with a fresh budget
  moveLabel(f.src, 9, "ready");
  assert.equal(run(f), EXIT.ADMITTED);
  assert.match(f.enq(), /--run-id factory-issue-9-4 /);
  assert.equal(readAttempts(f.state, 9).streak, 1);
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "r", steps }).to, "ready");
});

test("blocked goes straight to needs-human with the question", () => {
  const f = fixture();
  assert.equal(run(f), EXIT.ADMITTED);
  seedImpl(f, "blocked", { question: "which db?" });
  const r = finishRun(f.src, { issue: 9, state: f.state, run: "factory-issue-9-1", steps: "implement=succeeded,require_pass=failed" });
  assert.deepEqual([r.to, r.outcome], ["needs-human", "blocked"]);
  assert.deepEqual(f.labels(), ["factory:needs-human"]);
  const comment = JSON.parse(readFileSync(f.file, "utf8"))[0].comments.at(-1);
  assert.match(comment, /Outcome: blocked/); assert.match(comment, /Failed step: require_pass/); assert.match(comment, /which db\?/);
  // human re-readies: the stale blocked state is archived, not replayed
  moveLabel(f.src, 9, "ready");
  assert.equal(run(f), EXIT.ADMITTED);
  assert.equal(JSON.parse(readFileSync(join(f.state, "9", "attempts.json"), "utf8")).last, 2);
  assert.throws(() => readFileSync(join(f.state, "9", "impl.json")));
});

test("a failed step outside the stations (validate) is a retryable fail", () => {
  const f = fixture();
  run(f);
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "r", steps: "implement=succeeded,validate=failed" }).to, "ready");
});

test("finish never touches an issue that is not running", () => {
  const f = fixture(["factory:needs-human"]);
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "r", steps: "implement=failed" }).to, null);
  assert.deepEqual(f.labels(), ["factory:needs-human"]);
});

test("an enqueue failure puts the issue back to ready and frees the attempt", () => {
  const f = fixture();
  process.env.FAKE_RC = "1";
  try { assert.equal(run(f), EXIT.INFRA); } finally { delete process.env.FAKE_RC; }
  assert.deepEqual(f.labels(), ["factory:ready"]);
  assert.equal(readAttempts(f.state, 9).last, 0);
  assert.equal(run(f), EXIT.ADMITTED);
  assert.match(f.enq().split("\n").at(-2), /factory-issue-9-1 /);
});

test("blocked implementation repair inside the qa step goes to needs-human with its question", () => {
  const f = fixture();
  run(f);
  seedImpl(f, "pass");
  writeFileSync(join(f.state, "9", "qa.json"), JSON.stringify({ attempts: [{ threadId: "q", outcome: "fail", startedAt: 100 }] }));
  writeFileSync(join(f.state, "9", "impl.json"), JSON.stringify({ attempts: [{ threadId: "t", outcome: "pass", startedAt: 50 }, { threadId: "t", continued: true, outcome: "blocked", question: "which db?", startedAt: 200 }] }));
  const r = finishRun(f.src, { issue: 9, state: f.state, run: "factory-issue-9-1", steps: "require_pass=succeeded,qa=failed" });
  assert.deepEqual([r.to, r.outcome, r.failed], ["needs-human", "blocked", "qa"]);
  assert.deepEqual(f.labels(), ["factory:needs-human"]);
  assert.match(JSON.parse(readFileSync(f.file, "utf8"))[0].comments.at(-1), /which db\?/);
});

test("a qa failure after a passing repair keeps the qa outcome", () => {
  const f = fixture();
  run(f);
  mkdirSync(join(f.state, "9"), { recursive: true });
  writeFileSync(join(f.state, "9", "qa.json"), JSON.stringify({ attempts: [{ outcome: "timeout", startedAt: 300 }] }));
  writeFileSync(join(f.state, "9", "impl.json"), JSON.stringify({ attempts: [{ outcome: "pass", startedAt: 200 }] }));
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "r", steps: "qa=failed" }).outcome, "timeout");
});
