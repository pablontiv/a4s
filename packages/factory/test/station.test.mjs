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
else if (cmd === "send") { fs.writeFileSync(process.env.FAKE_T3 + ".sent", input); process.stdout.write(JSON.stringify({ runId: "R2" })); }
else if (cmd === "show") process.stdout.write(sc.show);
`;

let server, origin;
before(async () => {
  server = createServer((_q, r) => r.end("ok"));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function fixture({ show, start, state, reachable = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "station-"));
  const versions = join(dir, "versions"), home = join(dir, "t3home"), stateDir = join(dir, "state");
  mkdirSync(join(versions, "9.9.9"), { recursive: true });
  writeFileSync(join(versions, "9.9.9", "t3"), FAKE);
  chmodSync(join(versions, "9.9.9", "t3"), 0o755);
  mkdirSync(join(home, "userdata"), { recursive: true });
  writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ serverVersion: "9.9.9", origin: reachable ? origin : "http://127.0.0.1:1" }));
  writeFileSync(join(dir, "lines.json"), JSON.stringify(LINES));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ show, start }));
  mkdirSync(join(stateDir, "7"), { recursive: true });
  if (state) writeFileSync(join(stateDir, "7", "impl.json"), JSON.stringify(state));
  return { dir, versions, home, stateDir, stFile: join(stateDir, "7", "impl.json"), scenario: join(dir, "scenario.json") };
}

function run(f, extra = []) {
  const args = [STATION, "--line", "impl", "--issue", "7", "--project", f.dir, "--t3-home", f.home, "--state", f.stateDir,
    "--lines", join(f.dir, "lines.json"), "--brief-text", "do it", "--stable-sec", "0", "--timeout-sec", "30", ...extra];
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
