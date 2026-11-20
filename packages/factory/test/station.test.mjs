// Station-level regression tests: run src/station.mjs against a fake `t3` CLI and a local HTTP origin.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATION = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "station.mjs");
const LINES = { lines: { impl: { provider: "p", model: "m", escalate_to: "big" } } };
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_T3, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_T3 + ".log", JSON.stringify(args) + "\\n");
const input = args.includes("-") ? fs.readFileSync(0, "utf8") : "";
const [, cmd] = args;
if (cmd === "start") process.stdout.write(sc.start ?? JSON.stringify({ threadId: "T-new", runId: "R1" }));
else if (cmd === "send") { if (!fs.existsSync(process.env.FAKE_T3 + ".sent")) fs.writeFileSync(process.env.FAKE_T3 + ".sent", input); process.stdout.write(JSON.stringify({ runId: "R2" })); }
else if (cmd === "show") {
  const cf = process.env.FAKE_T3 + ".count";
  const n = fs.existsSync(cf) ? Number(fs.readFileSync(cf, "utf8")) : 0;
  fs.writeFileSync(cf, String(n + 1));
  const t = (status) => ({ status, model: "m", pendingRequestCount: 0, activeRunId: status === "running" ? "R1" : null });
  if (sc.tickUntil !== undefined) { // scripted activity: a new message on every poll, then a verdict
    process.stdout.write(JSON.stringify(n < sc.tickUntil
      ? { thread: t("running"), messages: [{ role: "assistant", text: "step " + n }] }
      : { thread: t("completed"), messages: [{ role: "assistant", text: '{"verdict":"fail","findings":["x"]}' }] }));
  } else process.stdout.write(fs.existsSync(process.env.FAKE_T3 + ".sent") && sc.showAfterSend ? sc.showAfterSend : sc.show);
}
`;

let server, origin;
before(async () => {
  server = createServer((_q, r) => r.end("ok"));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function fixture({ show, showAfterSend, start, state, reachable = true, tickUntil } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "station-"));
  const versions = join(dir, "versions"), home = join(dir, "t3home"), stateDir = join(dir, "state");
  mkdirSync(join(versions, "9.9.9"), { recursive: true });
  writeFileSync(join(versions, "9.9.9", "t3"), FAKE);
  chmodSync(join(versions, "9.9.9", "t3"), 0o755);
  mkdirSync(join(home, "userdata"), { recursive: true });
  writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ serverVersion: "9.9.9", origin: reachable ? origin : "http://127.0.0.1:1" }));
  writeFileSync(join(dir, "lines.json"), JSON.stringify(LINES));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ show, showAfterSend, start, tickUntil }));
  mkdirSync(join(stateDir, "7"), { recursive: true });
  if (state) writeFileSync(join(stateDir, "7", "impl.json"), JSON.stringify(state));
  return { dir, versions, home, stateDir, stFile: join(stateDir, "7", "impl.json"), scenario: join(dir, "scenario.json") };
}

function run(f, extra = []) {
  const args = [STATION, "--line", "impl", "--issue", "7", "--project", f.dir, "--t3-home", f.home, "--state", f.stateDir,
    "--lines", join(f.dir, "lines.json"), "--brief-text", "do it", "--stable-sec", "0", "--poll-sec", "0.1", ...extra];
  return new Promise((ok) => {
    execFile(process.execPath, args, { env: { ...process.env, T3_VERSIONS_DIR: f.versions, FAKE_T3: f.scenario, DAGU_OUTPUT_FILE: "" } },
      (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const state = (f) => JSON.parse(readFileSync(f.stFile, "utf8"));
const calls = (f) => existsSync(f.scenario + ".log") ? readFileSync(f.scenario + ".log", "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const snap = (status, extra = {}) => JSON.stringify({ thread: { status, model: "m", pendingRequestCount: 0, activeRunId: null, ...extra }, messages: [] });

test("terminal thread status cancelled is persisted as cancelled; the next attempt uses model", async (t) => {
  const f = fixture({ show: snap("cancelled") });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 143, r.stderr);
  assert.match(r.stdout, /^result=cancelled$/m);
  assert.equal(state(f).attempts.at(-1).outcome, "cancelled");
  writeFileSync(f.scenario, JSON.stringify({ show: snap("completed", { model: "m" }) }));
  await run(f);
  const starts = calls(f).filter((c) => c[1] === "start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1][starts[1].indexOf("--model") + 1], "m");
});

test("terminal status failed is persisted as fail; the next attempt uses escalate_to", async (t) => {
  const f = fixture({ show: snap("failed") });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 10, r.stderr);
  assert.equal(state(f).attempts.at(-1).outcome, "fail");
  await run(f);
  const starts = calls(f).filter((c) => c[1] === "start");
  assert.equal(starts[1][starts[1].indexOf("--model") + 1], "big");
});

test("malformed JSON from `t3 thread show` is persisted as infra, and the next run reattaches", async (t) => {
  const f = fixture({ show: "not json {" });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 30, r.stderr);
  assert.match(r.stdout, /^result=infra$/m);
  const at = state(f).attempts.at(-1);
  assert.equal(at.outcome, "infra");
  assert.equal(at.threadId, "T-new");
  writeFileSync(f.scenario, JSON.stringify({ show: snap("cancelled") }));
  await run(f);
  assert.equal(calls(f).filter((c) => c[1] === "start").length, 1, "reattached, no new thread");
  assert.equal(state(f).attempts.at(-1).outcome, "cancelled");
});

test("malformed JSON from `t3 thread start` is persisted as infra", async (t) => {
  const f = fixture({ start: "garbage", show: snap("completed") });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 30, r.stderr);
  assert.equal(state(f).attempts.at(-1).outcome, "infra");
});

test("preflight infra failure finalizes the in-flight attempt as infra", async (t) => {
  const f = fixture({ reachable: false, state: { attempts: [{ threadId: "T-old", model: "m", startedAt: 1 }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 30, r.stderr);
  assert.deepEqual(state(f).attempts.map((x) => x.outcome), ["infra"]);
  assert.equal(calls(f).length, 0);
});

test("preflight infra failure keeps a terminal outcome", async (t) => {
  const f = fixture({ reachable: false, state: { attempts: [{ threadId: "T-old", model: "big", outcome: "fail" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 30, r.stderr);
  assert.deepEqual(state(f).attempts.map((x) => x.outcome), ["fail"]);
});

test("previous blocked + answer continues the same thread", async (t) => {
  const f = fixture({ show: snap("completed"), state: { attempts: [{ threadId: "T-old", model: "m", outcome: "blocked", question: "which?" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  await run(f, ["--answer", "this one"]);
  const c = calls(f);
  assert.equal(c.filter((x) => x[1] === "start").length, 0);
  const send = c.find((x) => x[1] === "send");
  assert.ok(send.includes("T-old"));
  assert.equal(readFileSync(f.scenario + ".sent", "utf8"), "this one");
  assert.equal(state(f).attempts.at(-1).threadId, "T-old");
});

test("previous blocked without answer stays on its own thread", async (t) => {
  const f = fixture({ show: snap("completed"), state: { attempts: [{ threadId: "T-old", model: "m", outcome: "blocked", question: "which?" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^result=blocked$/m);
  assert.match(r.stdout, /^thread_id=T-old$/m);
  assert.equal(calls(f).length, 0);
});

test("unknown outcome in the state file is an error", async (t) => {
  const f = fixture({ show: snap("completed"), state: { attempts: [{ threadId: "T-old", outcome: "waiting" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 40);
  assert.match(r.stderr, /unknown outcome "waiting"/);
  assert.equal(calls(f).length, 0);
});

test("stored pass is replayed while T3 is unreachable (stop before preflight)", async (t) => {
  const f = fixture({ reachable: false, state: { attempts: [{ threadId: "T-old", model: "m", outcome: "pass", commit: "", findings: ["ok"] }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^result=pass$/m);
  assert.match(r.stdout, /^thread_id=T-old$/m);
  assert.deepEqual(state(f).attempts.map((x) => x.outcome), ["pass"]);
  assert.equal(calls(f).length, 0);
});

test("stored pass is replayed without a T3 runtime file", async (t) => {
  const f = fixture({ state: { attempts: [{ threadId: "T-old", model: "m", outcome: "pass" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  rmSync(join(f.home, "userdata", "server-runtime.json"));
  const r = await run(f);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^result=pass$/m);
});

test("stored blocked without answer is replayed while T3 is unreachable", async (t) => {
  const f = fixture({ reachable: false, state: { attempts: [{ threadId: "T-old", model: "m", outcome: "blocked", question: "which?" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^result=blocked$/m);
  assert.match(r.stdout, /^question=which\?$/m);
  assert.deepEqual(state(f).attempts.map((x) => x.outcome), ["blocked"]);
});

test("stored blocked + answer with T3 unreachable is infra and keeps the blocked outcome", async (t) => {
  const f = fixture({ reachable: false, state: { attempts: [{ threadId: "T-old", model: "m", outcome: "blocked", question: "which?" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f, ["--answer", "this one"]);
  assert.equal(r.code, 30, r.stderr);
  assert.deepEqual(state(f).attempts.map((x) => x.outcome), ["blocked"]);
});

// ---- liveness: stuck after STALL_SEC without activity, timeout at the MAX_SEC cap ----
import { activitySig } from "../src/lib.mjs";
const busy = snap("running", { activeRunId: "R1" });

test("steady activity beyond STALL_SEC in total is not cut", async (t) => {
  const f = fixture({ tickUntil: 15 });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const t0 = Date.now();
  const r = await run(f, ["--stall-sec", "1", "--max-sec", "100", "--poll-sec", "0.2"]);
  assert.ok(Date.now() - t0 > 2500, "ran longer than 2 x STALL_SEC");
  assert.match(r.stdout, /^result=fail$/m, r.stderr); // reached the worker's own verdict
  assert.equal(state(f).attempts.at(-1).outcome, "fail");
});

test("silence for STALL_SEC ends the attempt as stuck, and the next attempt escalates", async (t) => {
  const f = fixture({ show: busy });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f, ["--stall-sec", "1", "--max-sec", "100"]);
  assert.equal(r.code, 10, r.stderr);
  assert.match(r.stdout, /^result=stuck$/m);
  assert.equal(state(f).attempts.at(-1).outcome, "stuck");
  writeFileSync(f.scenario, JSON.stringify({ show: snap("completed") }));
  await run(f);
  const starts = calls(f).filter((c) => c[1] === "start");
  assert.equal(starts[1][starts[1].indexOf("--model") + 1], "big");
});

test("the safety cap ends an always-active attempt as timeout, and the next attempt escalates", async (t) => {
  const f = fixture({ tickUntil: 1000 });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f, ["--stall-sec", "100", "--max-sec", "1", "--poll-sec", "0.2"]);
  assert.equal(r.code, 10, r.stderr);
  assert.match(r.stdout, /^result=timeout$/m);
  writeFileSync(f.scenario, JSON.stringify({ show: snap("completed") }));
  await run(f);
  const starts = calls(f).filter((c) => c[1] === "start");
  assert.equal(starts[1][starts[1].indexOf("--model") + 1], "big");
});

test("limits come from limits.json; the flag wins", async (t) => {
  const f = fixture({ show: busy });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  writeFileSync(join(f.dir, "limits.json"), JSON.stringify({ stallSec: 1, maxSec: 100 }));
  const r = await run(f, ["--limits", join(f.dir, "limits.json")]);
  assert.match(r.stdout, /^result=stuck$/m, r.stderr);
});

test("reattach keeps the clocks: last activity and startedAt are never reset", async (t) => {
  const old = Date.now() - 30_000;
  const f = fixture({ show: busy, state: { attempts: [{ threadId: "T-old", model: "m", startedAt: old, lastActivityAt: old, activitySig: activitySig(JSON.parse(busy)) }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f, ["--stall-sec", "20", "--max-sec", "100"]);
  assert.match(r.stdout, /^result=stuck$/m, r.stderr);
  const at = state(f).attempts;
  assert.equal(at.length, 1);
  assert.equal(at[0].startedAt, old);
  assert.equal(calls(f).filter((c) => c[1] === "start").length, 0);
});

test("reattach after infra keeps startedAt: the safety cap counts from the first start", async (t) => {
  const old = Date.now() - 30_000;
  const f = fixture({ show: busy, state: { attempts: [{ threadId: "T-old", model: "m", startedAt: old, lastActivityAt: Date.now(), outcome: "infra" }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f, ["--stall-sec", "100", "--max-sec", "20"]);
  assert.match(r.stdout, /^result=timeout$/m, r.stderr);
  assert.equal(state(f).attempts.at(-1).startedAt, old);
});

test("a finished thread reattached after a long silence is classified, not stuck", async (t) => {
  const old = Date.now() - 30_000;
  const f = fixture({ show: snap("failed"), state: { attempts: [{ threadId: "T-old", model: "m", startedAt: old, lastActivityAt: old }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f, ["--stall-sec", "5"]);
  assert.match(r.stdout, /^result=fail$/m, r.stderr);
});

test("metadata-only changes (updatedAt) are not activity", async (t) => {
  const old = Date.now() - 30_000;
  const a = JSON.parse(snap("running", { activeRunId: "R1", itemCount: 3, updatedAt: "t1" }));
  const b = JSON.parse(snap("running", { activeRunId: "R1", itemCount: 3, updatedAt: "t2" }));
  assert.equal(activitySig(a), activitySig(b));
  const f = fixture({ show: JSON.stringify(b), state: { attempts: [{ threadId: "T-old", model: "m", startedAt: old, lastActivityAt: old, activitySig: activitySig(a) }] } });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f, ["--stall-sec", "20", "--max-sec", "100"]);
  assert.match(r.stdout, /^result=stuck$/m, r.stderr);
  assert.notEqual(activitySig(a), activitySig(JSON.parse(snap("running", { itemCount: 4 }))));
});

const said = (text, extra = {}) => JSON.stringify({ thread: { status: "completed", model: "m", pendingRequestCount: 0, activeRunId: null }, messages: [{ role: "assistant", text }], ...extra });
const sends = (f) => calls(f).filter((c) => c[1] === "send");
const VERDICT = '{"verdict":"pass","criteria":[{"criterion":"c","evidence":"e","result":"pass"}],"findings":[],"commit":null,"question":null}';

test("prose answer, then a valid verdict on the follow-up: one send on the same thread, parsed", async (t) => {
  const f = fixture({ show: said("all done, nothing to add"), showAfterSend: said(VERDICT) });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^result=pass$/m);
  assert.equal(sends(f).length, 1);
  assert.equal(sends(f)[0][sends(f)[0].indexOf("--json") + 1], "T-new");
  assert.match(readFileSync(f.scenario + ".sent", "utf8"), /ONLY the verdict/);
  assert.equal(calls(f).filter((c) => c[1] === "start").length, 1);
  const at = state(f).attempts;
  assert.equal(at.length, 1);
  assert.equal(at[0].verdictRequested, true);
  assert.equal(at[0].outcome, "pass");
});

test("prose twice: malformed (exit 40) after exactly one follow-up", async (t) => {
  const f = fixture({ show: said("nothing was committed"), showAfterSend: said("still prose") });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 40, r.stderr);
  assert.match(r.stdout, /^result=malformed$/m);
  assert.equal(sends(f).length, 1);
  assert.equal(state(f).attempts.at(-1).verdictRequested, true);
  assert.equal(state(f).attempts.at(-1).outcome, "malformed");
});

test("a JSON line that is not a verdict stays malformed after the follow-up", async (t) => {
  const f = fixture({ show: said('{"foo":1}'), showAfterSend: said('{"foo":2}') });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 40, r.stderr);
  assert.equal(sends(f).length, 1);
});

test("blocked verdict with its question given only on the follow-up", async (t) => {
  const f = fixture({ show: said("I need to know"), showAfterSend: said('{"verdict":"blocked","findings":[],"commit":null,"question":"which db?"}') });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^question=which db\?$/m);
  assert.equal(state(f).attempts.at(-1).outcome, "blocked");
});

test("a valid verdict first: no follow-up", async (t) => {
  const f = fixture({ show: said(VERDICT) });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = await run(f);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sends(f).length, 0);
  assert.equal(state(f).attempts[0].verdictRequested, undefined);
});
