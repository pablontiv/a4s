import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit, EXIT, heldSinceLastRun, repoSlug, shouldClearCarry } from "../src/admit.mjs";
import { carrySection, finishRun, labelNames, markHeld, moveLabel, readAttempts, source, writeCarry } from "../src/labels.mjs";
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

test("a validate receipt finding is carried to the retry brief", () => {
  const f = fixture();
  run(f);
  writeFileSync(join(f.state, "9", "step-failure.json"), JSON.stringify({ run: "r", step: "validate", findings: ["selftest not run on this code: receipt stale"] }));
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "r", steps: "implement=succeeded,validate=failed" }).to, "ready");
  assert.match(carrySection(f.state, 9), /selftest not run on this code: receipt stale/);
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

test("carry-over: fail writes carry.json, the brief section lists it, success/needs-human/parked admission clear it", () => {
  const f = fixture();
  const carry = join(f.state, "9", "carry.json");
  const exists = () => { try { readFileSync(carry); return true; } catch { return false; } };
  assert.equal(carrySection(f.state, 9), "");
  seedImpl(f, "fail", { findings: ["collectCi drops the failed job", "second defect"] });
  assert.equal(run(f), EXIT.ADMITTED);
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "factory-issue-9-1", steps: "prepare=succeeded,implement=failed" }).to, "ready");
  assert.deepEqual((({ at, ...c }) => c)(JSON.parse(readFileSync(carry, "utf8"))), { run: "factory-issue-9-1", step: "implement", findings: ["collectCi drops the failed job", "second defect"] });
  const sec = carrySection(f.state, 9);
  assert.match(sec, /^\n## Previous run findings\n/);
  assert.match(sec, /factory-issue-9-1/);
  assert.match(sec, /Failed step: implement/);
  assert.match(sec, /- collectCi drops the failed job\n- second defect/);
  assert.equal(run(f), EXIT.ADMITTED);  // plain retry keeps it
  assert.ok(exists());
  // success clears it
  silent(() => spawnSync("node", [join(import.meta.dirname, "..", "src", "labels.mjs"), "success", "--issue", "9", "--state", f.state, "--issues-file", f.file]));
  assert.ok(!exists());
  // needs-human clears it
  writeCarry(f.state, 9, { run: "r", step: "implement", findings: ["x"] });
  moveLabel(f.src, 9, "running");
  seedImpl(f, "blocked", { question: "q?" });
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "r", steps: "implement=failed" }).to, "needs-human");
  assert.ok(!exists());
  // admission after a park (human put ready back) clears a stale carry
  writeCarry(f.state, 9, { run: "r", step: "implement", findings: ["x"] });
  moveLabel(f.src, 9, "ready");
  assert.equal(run(f), EXIT.ADMITTED);
  assert.ok(!exists());
});

test("carry-over: factory:hold clears it (hold -> ready -> admission starts fresh)", () => {
  const f = fixture();
  const carry = join(f.state, "9", "carry.json");
  const exists = () => { try { readFileSync(carry); return true; } catch { return false; } };
  seedImpl(f, "fail", { findings: ["old defect"] });
  assert.equal(run(f), EXIT.ADMITTED);
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "factory-issue-9-1", steps: "implement=failed" }).to, "ready");
  assert.ok(exists());
  // operator puts factory:hold: the admit step sees it and clears the carry
  const held = join(f.dir, "held.json");
  writeFileSync(held, JSON.stringify([{ number: 9, labels: [{ name: "factory:hold" }] }]));
  const r = spawnSync("node", [join(import.meta.dirname, "..", "src", "admit.mjs"), "--clear-held", held, "--state", f.state], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists());
  assert.equal(carrySection(f.state, 9), "");
  // later hold removed, ready added: admission stays clean
  moveLabel(f.src, 9, "ready");
  assert.equal(run(f), EXIT.ADMITTED);
  assert.ok(!exists());
});

test("prepare writes brief.md with the previous run's findings (executes src/prepare-brief.sh)", () => {
  const f = fixture();
  const src = join(f.dir, "brief-src.md");
  writeFileSync(src, "# Add mul\n\n## Goal\nx\n");
  const prepare = () => {
    const r = spawnSync("bash", [join(import.meta.dirname, "..", "src", "prepare-brief.sh")], { encoding: "utf8",
      env: { ...process.env, ISSUE: "9", PRIMARY: f.dir, FACTORY: join(import.meta.dirname, ".."), T3_HOME: f.dir, STATE: f.state, BRIEF_FILE: src } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(f.state, "9", "brief.md"), "utf8");
  };
  assert.doesNotMatch(prepare(), /Previous run findings/);
  seedImpl(f, "fail", { findings: ["FIRST-RUN-DEFECT"] });
  assert.equal(run(f), EXIT.ADMITTED);
  finishRun(f.src, { issue: 9, state: f.state, run: "factory-issue-9-1", steps: "implement=failed" });
  const brief = prepare();
  assert.match(brief, /^# Add mul/);
  assert.match(brief, /## Previous run findings[\s\S]*factory-issue-9-1[\s\S]*Failed step: implement[\s\S]*- FIRST-RUN-DEFECT/);
  assert.equal(prepare(), brief);  // idempotent: rewritten from the source, not appended twice
});

test("carry-over: hold placed and removed between cycles (label history) clears it at admission", () => {
  const f = fixture();
  const carry = join(f.state, "9", "carry.json");
  const exists = () => { try { readFileSync(carry); return true; } catch { return false; } };
  seedImpl(f, "fail", { findings: ["old defect"] });
  assert.equal(run(f), EXIT.ADMITTED);
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "factory-issue-9-1", steps: "implement=failed" }).to, "ready");
  const at = JSON.parse(readFileSync(carry, "utf8")).at;
  assert.ok(!Number.isNaN(Date.parse(at)));
  // a hold older than the carry does not count: the automatic retry keeps the findings
  const list = JSON.parse(readFileSync(f.file, "utf8"));
  list[0].events = [{ event: "labeled", label: { name: "factory:hold" }, created_at: "2000-01-01T00:00:00Z" }];
  writeFileSync(f.file, JSON.stringify(list));
  assert.equal(run(f), EXIT.ADMITTED);
  assert.ok(exists());
  // second failure, then the operator holds and releases (never seen by an admit step): fresh start
  seedImpl(f, "fail", { findings: ["old defect"] });
  assert.equal(finishRun(f.src, { issue: 9, state: f.state, run: "factory-issue-9-2", steps: "implement=failed" }).to, "ready");
  const l2 = JSON.parse(readFileSync(f.file, "utf8"));
  l2[0].events.push({ event: "labeled", label: { name: "factory:hold" }, created_at: new Date(Date.now() + 1000).toISOString() }, { event: "unlabeled", label: { name: "factory:hold" }, created_at: new Date(Date.now() + 2000).toISOString() });
  writeFileSync(f.file, JSON.stringify(l2));
  assert.equal(run(f), EXIT.ADMITTED);
  assert.ok(!exists());
  assert.equal(carrySection(f.state, 9), "");
});

test("carry-over: live admission reads factory:hold from the GitHub label history", () => {
  const carry = { run: "r", step: "implement", at: "2026-01-02T00:00:00Z", findings: ["x"] };
  const issue = { number: 9, labels: [{ name: "factory:ready" }] };
  const o = { issue: "9", repo: "https://github.com/acme/widgets.git", issuesFile: "/x", live: true };
  let called;
  const gh = (out, status = 0) => (args) => { called = args; return { status, stdout: out, stderr: "boom" }; };
  assert.equal(shouldClearCarry(o, issue, { parked: false }, carry, gh("2026-01-01T00:00:00Z\n")), false);
  assert.deepEqual(called.slice(0, 3), ["api", "--paginate", "repos/acme/widgets/issues/9/events"]);
  assert.equal(shouldClearCarry(o, issue, { parked: false }, carry, gh("2026-01-03T00:00:00Z\n")), true);
  assert.equal(silent(() => shouldClearCarry(o, issue, { parked: false }, carry, gh("", 1))), true); // unknown history: fresh start
  assert.equal(shouldClearCarry(o, issue, { parked: true }, carry, gh("")), true);
  assert.equal(shouldClearCarry(o, { labels: ["factory:hold", "factory:ready"] }, { parked: false }, carry, gh("")), true);
  assert.equal(shouldClearCarry(o, issue, { parked: false }, null, gh("")), false);
  assert.equal(repoSlug("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(repoSlug("acme/widgets"), "acme/widgets");
});

const failRun = (f, k) => { seedImpl(f, "fail"); assert.equal(run(f), EXIT.ADMITTED); return finishRun(f.src, { issue: 9, state: f.state, run: `factory-issue-9-${k}`, steps: "prepare=succeeded,implement=failed" }); };
const setLabels = (f, labels, extra = {}) => writeFileSync(f.file, JSON.stringify([{ number: 9, labels: labels.map((name) => ({ name })), body: BODY, ...extra }]));

test("run budget: fail, fail, hold -> ready -> fail stays retryable (streak 1, resetBy hold)", () => {
  const f = fixture();
  assert.equal(failRun(f, 1).to, "ready");
  assert.equal(failRun(f, 2).to, "ready");
  setLabels(f, ["factory:hold", "factory:ready"]); // held, then re-admitted with hold still seen by the admit step
  const r = failRun(f, 3);
  assert.equal(r.to, "ready");
  const at = readAttempts(f.state, 9);
  assert.equal(at.streak, 1);
  assert.equal(at.resetBy, "hold");
  assert.ok(at.resetAt);
});

test("run budget: hold seen by --clear-held (markHeld) or in the label history resets the streak", () => {
  const f = fixture();
  failRun(f, 1);
  markHeld(f.state, 9);
  failRun(f, 2);
  assert.deepEqual([readAttempts(f.state, 9).streak, readAttempts(f.state, 9).resetBy], [1, "hold"]);
  assert.equal(readAttempts(f.state, 9).held, undefined);
  failRun(f, 3);
  assert.equal(readAttempts(f.state, 9).streak, 2); // no human decision: keeps counting
  // history: hold labelled after the last run
  const o = { issue: "9", issuesFile: "/x" };
  const issue = { number: 9, labels: ["factory:ready"], events: [{ event: "labeled", label: { name: "factory:hold" }, created_at: "2026-01-03T00:00:00Z" }] };
  assert.equal(heldSinceLastRun(o, issue, { lastAt: "2026-01-02T00:00:00Z" }, null), true);
  assert.equal(heldSinceLastRun(o, issue, { lastAt: "2026-01-04T00:00:00Z" }, null), false);
});

test("run budget: an admission without a human decision keeps counting; needs-human at run 3 says since", () => {
  const f = fixture();
  for (let k = 1; k <= 3; k++) {
    const r = failRun(f, k);
    assert.equal(r.to, k < 3 ? "ready" : "needs-human");
    assert.equal(readAttempts(f.state, 9).streak, k);
  }
  const comment = JSON.parse(readFileSync(f.file, "utf8"))[0].comments.at(-1);
  assert.match(comment, /run 3 of 3 since the first run/);
  moveLabel(f.src, 9, "ready"); // park: needs-human path unchanged
  failRun(f, 4);
  const at = readAttempts(f.state, 9);
  assert.deepEqual([at.streak, at.resetBy], [1, "needs-human"]);
  assert.ok(at.resetAt);
});
