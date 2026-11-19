import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { failedStep, formatMessage, issueUrl, parseSteps, INBOX_TITLE } from "../src/notify.mjs";

const NOTIFY = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "notify.mjs");

test("parseSteps drops handler steps; failedStep finds the first failure", () => {
  const s = parseSteps("prepare=succeeded,validate=failed,onFailure=running,integrate=not_started");
  assert.deepEqual(s.map((x) => x.id), ["prepare", "validate", "integrate"]);
  assert.equal(failedStep(s), "validate");
  assert.equal(failedStep(parseSteps("a=succeeded")), null);
});

test("issueUrl from ssh and https remotes", () => {
  assert.equal(issueUrl("git@github.com:o/r.git\n", "5"), "https://github.com/o/r/issues/5");
  assert.equal(issueUrl("https://github.com/o/r", "5"), "https://github.com/o/r/issues/5");
  assert.equal(issueUrl("", "5"), null);
});

test("message states run, issue, event, failed step and URL", () => {
  const m = formatMessage({ event: "failure", run: "r1", issue: "7", steps: parseSteps("validate=failed"), url: "https://github.com/o/r/issues/7" });
  for (const p of ["r1", "#7", "failure", "validate", "https://github.com/o/r/issues/7"]) assert.ok(m.includes(p), p);
});

// fixture: a stub t3cli that logs every call; `thread list` answers from LIST_FILE
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "notify-"));
  const calls = join(root, "calls.log");
  const stub = join(root, "t3stub.mjs");
  writeFileSync(stub, `import { appendFileSync, readFileSync, existsSync } from "node:fs";
const a = process.argv.slice(2); let input = ""; try { input = readFileSync(0, "utf8"); } catch {}
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ a, input }) + "\\n");
if (process.env.STUB_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_DELAY));
if (process.env.STUB_FAIL) { console.error("boom"); process.exit(1); }
if (a[0] === "thread" && a[1] === "start") console.log(JSON.stringify({ threadId: "T-NEW", runId: "r" }));
if (a[0] === "thread" && a[1] === "list") console.log(process.env.STUB_LIST ?? "[]");
`);
  const primary = join(root, "primary"); mkdirSync(primary);
  spawnSync("git", ["init", "-q", primary]);
  spawnSync("git", ["-C", primary, "remote", "add", "origin", "git@github.com:o/r.git"]);
  const state = join(root, "state");
  const run = (extra = [], env = {}, ev = "success", runId = "r1") => spawnSync("node", [NOTIFY, "--event", ev, "--run", runId, "--issue", "7",
    "--steps", "validate=failed", "--primary", primary, "--t3-home", root, "--state", state, ...extra],
  { encoding: "utf8", env: { ...process.env, NOTIFY_T3CLI: stub, ...env } });
  const runAsync = (extra, env, ev, runId, issue = "7") => new Promise((ok) => {
    const c = spawn("node", [NOTIFY, "--event", ev, "--run", runId, "--issue", issue, "--steps", "a=failed", "--primary", primary,
      "--t3-home", root, "--state", state, ...extra], { env: { ...process.env, NOTIFY_T3CLI: stub, STUB_DELAY: "400", ...env }, stdio: "ignore" });
    c.on("close", (code) => ok(code));
  });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { run, runAsync, log, state };
}

test("explicit thread: one send, and the same run/event is not sent twice", () => {
  const f = fixture();
  assert.equal(f.run(["--inbox", "T1"]).status, 0);
  assert.equal(f.run(["--inbox", "T1"]).status, 0);
  const sends = f.log().filter((c) => c.a[1] === "send");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].a.slice(0, 2), ["thread", "send"]);
  assert.ok(sends[0].a.includes("T1"));
  assert.ok(sends[0].input.includes("issues/7"));
  assert.ok(JSON.parse(readFileSync(join(f.state, "7", "notified.json"), "utf8"))["r1:success"]);
  // another event of the same run is a new notification
  f.run(["--inbox", "T1"], {}, "failure");
  assert.equal(f.log().filter((c) => c.a[1] === "send").length, 2);
});

test("no thread configured: the inbox is created once (isolated line, title) and reused", () => {
  const f = fixture();
  f.run();
  f.run([], {}, "failure", "r2");
  const calls = f.log();
  const starts = calls.filter((c) => c.a[0] === "thread" && c.a[1] === "start");
  assert.equal(starts.length, 1);
  assert.ok(starts[0].a.includes(INBOX_TITLE));
  assert.ok(starts[0].a.includes("pi-inbox"));
  assert.equal(JSON.parse(readFileSync(join(f.state, "inbox.json"), "utf8")).threadId, "T-NEW");
  const sends = calls.filter((c) => c.a[1] === "send");
  assert.equal(sends.length, 1);
  assert.ok(sends[0].a.includes("T-NEW"));
});

test("an existing inbox thread is adopted when inbox.json is lost", () => {
  const f = fixture();
  f.run([], { STUB_LIST: JSON.stringify([{ threadId: "T-OLD", title: INBOX_TITLE }]) });
  assert.equal(f.log().filter((c) => c.a[1] === "start").length, 0);
  assert.ok(f.log().some((c) => c.a[1] === "send" && c.a.includes("T-OLD")));
});

test("T3 failures never fail the run and are not recorded as notified", () => {
  const f = fixture();
  assert.equal(f.run(["--inbox", "T1"], { STUB_FAIL: "1" }).status, 0);
  assert.equal(f.run([], { STUB_FAIL: "1" }).status, 0);
  assert.equal(existsSync(join(f.state, "7", "notified.json")), false);
});

test("missing arguments: logged, exit 0", () => {
  const r = spawnSync("node", [NOTIFY, "--event", "success"], { encoding: "utf8" });
  assert.equal(r.status, 0);
});

test("concurrent first notifications of different issues create exactly one inbox", async () => {
  const f = fixture();
  const codes = await Promise.all(["1", "2", "3", "4"].map((i) => f.runAsync([], {}, "success", `r${i}`, i)));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const calls = f.log();
  assert.equal(calls.filter((c) => c.a[0] === "thread" && c.a[1] === "start").length, 1);
  assert.equal(calls.filter((c) => c.a[1] === "send").length, 3);
  assert.ok(calls.filter((c) => c.a[1] === "send").every((c) => c.a.includes("T-NEW")));
});

test("concurrent identical run/event notifications send once", async () => {
  const f = fixture();
  const codes = await Promise.all([1, 2, 3].map(() => f.runAsync(["--inbox", "T1"], {}, "failure", "same")));
  assert.deepEqual(codes, [0, 0, 0]);
  assert.equal(f.log().filter((c) => c.a[1] === "send").length, 1);
});
