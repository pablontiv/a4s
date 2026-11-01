import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { observeLocks } from "../../src/health-locks.ts";

// Separate from the no-spawn default gate: only isolated scratch locks, never station locks.
for (const runtime of ["bun", "node"]) {
  test(`${runtime}: exact native kernel identity, inherited Node lock, denied contender and descriptor closure`, { timeout: 30000 }, async t => {
    const parent = process.env.HEALTH_PROBE_ROOT ?? tmpdir();
    if (process.platform !== "linux" || statfsSync(parent).type !== 0xef53) return t.skip("Requires the demonstrated Linux ext4 mapping");
    const directory = mkdtempSync(join(parent, "health-native-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, `${runtime}.lock`), helper = resolve("packages/launcher/src/file-lock.ts");
    const source = `import {openLock,acquireLock} from ${JSON.stringify(helper)}; import {closeSync} from 'node:fs';import {once} from 'node:events';
const fd=openLock(${JSON.stringify(path)});if(!acquireLock(fd,true))throw Error('uncontended acquisition failed');
console.log(JSON.stringify({pid:process.pid,fd}));process.stdin.resume();await once(process.stdin,'data');process.stdin.pause();closeSync(fd);`;
    const args = runtime === "node" ? ["--import", "tsx", "--input-type=module", "-e", source] : ["--eval", source];
    const child = spawn(runtime, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", data => { stderr += data.toString(); });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const [data] = await once(child.stdout, "data", { signal: AbortSignal.timeout(10000) });
    const ready = JSON.parse(String(data)) as { pid: number; fd: number };
    const held = observeLocks([path])[0]!;
    assert.equal(held.held.value, true, JSON.stringify(held));
    assert.equal(held.holders.value?.length, 1);
    const holder = held.holders.value![0]!;
    if (runtime === "bun") {
      assert.equal(holder.reportedPid, ready.pid); assert.equal(holder.alive.value, true);
      assert.equal(holder.matchingFds.value?.some(fd => fd.target === path), true);
    } else {
      assert.notEqual(holder.reportedPid, ready.pid, "Node helper row records the exited Python acquiring child");
      assert.equal(holder.alive.value, null, "Absent reported PID is uncertainty, never absence of the kernel lock");
      assert.ok(holder.alive.reason);
    }
    const contender = spawnSync("bun", ["--eval", `import {openLock,acquireLock} from ${JSON.stringify(helper)};import {closeSync} from 'node:fs';const fd=openLock(${JSON.stringify(path)});console.log(acquireLock(fd,true));closeSync(fd);`], { encoding: "utf8", timeout: 10000 });
    assert.equal(contender.status, 0, contender.stderr); assert.equal(contender.stdout.trim(), "false");
    assert.equal(observeLocks([path])[0]?.held.value, true);
    const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) }); child.stdin.end("\n");
    const [code] = await exited; assert.equal(code, 0, stderr);
    assert.equal(observeLocks([path])[0]?.held.value, false);
    console.log(JSON.stringify({ runtime, acquiringProcess: ready.pid, heldSnapshot: held, contenderDenied: true, rowRemovedAfterClosure: true }));
  });
}
