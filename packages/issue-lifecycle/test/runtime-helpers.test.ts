import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const prefix = ["--import", import.meta.resolve("tsx"), cli];
function run(args: string[], env = process.env) {
  return spawnSync(process.execPath, [...prefix, ...args], { env, encoding: "utf8" });
}

test("reconcile timing, hashing and bounded commands preserve their outputs and statuses", () => {
  const now = run(["reconcile", "now"]);
  assert.equal(now.status, 0, now.stderr);
  assert.ok(Math.abs(Date.now() - Number(now.stdout)) < 1000);
  const exhausted = run(["reconcile", "bounded", "discover", "10", String(Date.now() - 11_000), "2", process.execPath, "-e", 'console.log("unexpected");process.exit(99)']);
  assert.equal(exhausted.status, 124, exhausted.stderr);
  assert.equal(exhausted.stdout, "");
  assert.equal(exhausted.stderr, "discover deadline exceeded\n");
  const hashed = spawnSync(process.execPath, [...prefix, "reconcile", "sha256"], { input: "repo\n123\n", encoding: "utf8" });
  assert.equal(hashed.stdout, `${createHash("sha256").update("repo\n123\n").digest("hex")}\n`);
  const completed = run(["reconcile", "bounded", "transition", "3", String(Date.now()), "3", process.execPath, "-e", 'console.log("called");process.exit(7)']);
  assert.equal(completed.status, 7, completed.stderr);
  assert.equal(completed.stdout, "called\n");
  // A fake clock cannot exercise the subprocess helper's real OS timeout.
  const expired = run(["reconcile", "bounded", "discover", "3", String(Date.now()), "0.05", process.execPath, "-e", "setTimeout(()=>{},10000)"]);
  assert.equal(expired.status, 124, expired.stderr);
  assert.equal(expired.stderr, "discover deadline exceeded\n");
});

test("CI no-progress uses the existing fingerprint, idempotent observation count and durable request", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-no-progress-"));
  try {
    const observation = { run: "one", sha: "abc", check: "CI", cause: "déferred", class: "BLOCKED", action: "WAIT" };
    const path = join(root, "ci-observation.json");
    writeFileSync(path, JSON.stringify(observation));
    for (const id of ["first", "first", "second", "third"]) {
      const result = run(["reconcile", "ci-no-progress", root, id, "2"]);
      assert.equal(result.status, 0, result.stderr);
    }
    const expected = createHash("sha256").update('["one","abc","CI","d\\u00e9ferred"]').digest("hex");
    const state = JSON.parse(readFileSync(join(root, "ci-no-progress.json"), "utf8"));
    assert.equal(state.fingerprint, expected);
    assert.equal(state.observations, 3);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).decisionRequest, { id: expected, observations: 2 });
    writeFileSync(path, JSON.stringify({ ...observation, class: "PASS", action: "AUTO_MERGE" }));
    assert.equal(run(["reconcile", "ci-no-progress", root, "fourth", "2"]).status, 0);
    assert.equal(JSON.parse(readFileSync(join(root, "ci-no-progress.json"), "utf8")).observations, 0);
    assert.equal(run(["reconcile", "ci-no-progress", root, "fifth", "0"]).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heavy-slot blocks on the Python-owned kernel lock and retains the reentry marker", async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-slot-port-"));
  const directory = join(home, "a4s");
  mkdirSync(directory);
  const lock = join(directory, "heavy-slot.lock");
  const holder = spawn("python3", ["-c", 'import fcntl,sys; lock=open(sys.argv[1],"a+"); fcntl.flock(lock,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', lock], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    await once(holder.stdout!, "data");
    const journal = join(home, "journal");
    let settled = false;
    const pending = execute(process.execPath, [...prefix, "heavy-slot", "--gate", "one", process.execPath, "-e", 'console.log(process.env.A4S_HEAVY_SLOT_HELD)'], {
      env: { ...process.env, DAGU_HOME: home, A4S_HEAVY_SLOT_HELD: "", A4S_GATE_JOURNAL: journal },
    });
    const child = pending.finally(() => { settled = true; });
    let resolve!: () => void;
    const waiting = new Promise<void>(ready => { resolve = ready; });
    pending.child.stderr!.on("data", chunk => { if (String(chunk).includes("gate: waiting lock=")) resolve(); });
    await Promise.race([waiting, child.then(() => assert.fail("heavy-slot did not contend for the existing flock"))]);
    assert.equal(settled, false);
    assert.equal(existsSync(journal), false);
    holder.stdin!.end();
    const result = await child;
    assert.equal(result.stdout, "1\n");
    assert.match(result.stderr, /gate: waiting lock=/);
    assert.match(result.stderr, /gate: acquired lock=/);
    const records = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => [record.id, record.exitCode]), [["lock_wait", 0]]);
    const reentered = run(["heavy-slot", process.execPath, "-e", "process.exit(9)"], { ...process.env, A4S_HEAVY_SLOT_HELD: "1", DAGU_HOME: home });
    assert.equal(reentered.status, 9);
    assert.match(reentered.stderr, /slot: reenter marker=A4S_HEAVY_SLOT_HELD/);
  } finally { holder.kill(); rmSync(home, { recursive: true, force: true }); }
});

test("the ported gate releases its flock on integration hold and reacquires for the retry", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-slot-hold-"));
  try {
    const attempt = join(home, "attempt");
    const body = `const fs=require("node:fs"); const path=${JSON.stringify(attempt)}; if(!fs.existsSync(path)){fs.writeFileSync(path,"retry");process.exit(86)}console.log("retried")`;
    const result = run(["heavy-slot", "--gate", "hold", process.execPath, "-e", body], {
      ...process.env, DAGU_HOME: home, A4S_HEAVY_SLOT_HELD: "", A4S_INTEGRATION_POLL_SEC: "0",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "retried\n");
    assert.equal(result.stderr.match(/gate: acquired lock=/g)?.length, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("reconcile locks deduplicate paths, block interoperably and retain locks across the child", async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-reconcile-lock-"));
  const lock = join(root, "\u{10000}.lock");
  const first = join(root, "\uE000.lock");
  const holder = spawn("python3", ["-c", 'import fcntl,sys; lock=open(sys.argv[1],"a"); fcntl.flock(lock,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', lock], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    await once(holder.stdout!, "data");
    let settled = false;
    const probe = 'import fcntl,sys\nfor path in sys.argv[1:]:\n f=open(path,"a")\n try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n except BlockingIOError: continue\n sys.exit(4)\nprint("held")';
    const child = execute(process.execPath, [...prefix, "reconcile", "lock", "python3", "-c", probe, first, lock], {
      env: { ...process.env, RECONCILE_LOCKS: `${lock}\n${first}\n${lock}\n` },
    }).finally(() => { settled = true; });
    // This Python peer probes the OS locks, outside fake timers. The BMP path
    // must be acquired before the non-BMP path even while the latter is held.
    const acquiredFirst = spawnSync("python3", ["-c", 'import fcntl,sys,time\nend=time.monotonic()+10\nwhile time.monotonic()<end:\n f=open(sys.argv[1],"a")\n try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n except BlockingIOError: sys.exit(0)\n f.close()\n time.sleep(0.01)\nsys.exit(4)', first], { timeout: 11_000 });
    assert.equal(acquiredFirst.status, 0, acquiredFirst.stderr?.toString());
    assert.equal(settled, false);
    holder.stdin!.end();
    assert.equal((await child).stdout, "held\n");
    const released = spawnSync("python3", ["-c", 'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', first]);
    assert.equal(released.status, 0);
  } finally { holder.kill(); rmSync(root, { recursive: true, force: true }); }
});
