import { spawnSync } from "node:child_process";
import { constants, homedir } from "node:os";
import { appendFileSync, closeSync, ftruncateSync, readSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireLock, openLock, releaseLock } from "./file-lock.ts";

function acquired(gate: boolean): void {
  if (gate && process.env.A4S_GATE_JOURNAL) appendFileSync(process.env.A4S_GATE_JOURNAL,
    `${JSON.stringify({ id: "lock_wait", endedAt: Date.now(), exitCode: 0 })}\n`);
}
export async function main(args: string[]): Promise<void> {
  const gate = args[0] === "--gate";
  const run = gate ? args[1] : process.env.RUN ?? "npm-test";
  const body = gate ? args.slice(2) : args;
  if (!body.length) throw new Error("heavy-slot: command required");
  if (process.env.A4S_HEAVY_SLOT_HELD === "1") {
    console.error("slot: reenter marker=A4S_HEAVY_SLOT_HELD");
    acquired(gate);
    const child = spawnSync(body[0]!, body.slice(1), { stdio: "inherit" });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? (128 + (constants.signals[child.signal!] ?? 0));
    return;
  }
  const path = join(resolve(process.env.DAGU_HOME || join(homedir(), ".dagu")), "a4s", "heavy-slot.lock");
  const fd = openLock(path);
  let buffer: Buffer | undefined;
  try {
    for (;;) {
      let previous: string | undefined;
      while (!acquireLock(fd, true)) {
        buffer ??= Buffer.allocUnsafe(4096);
        const count = readSync(fd, buffer, 0, buffer.length, 0);
        const holder = buffer.toString("utf8", 0, count) || "unknown";
        if (holder !== previous) {
          console.error(`gate: waiting lock=${path} run=${run} pid=${process.pid} holder=${holder}`);
          previous = holder;
        }
        await sleep(100);
      }
      const owner = `{"run": ${JSON.stringify(run)}, "role": "${gate ? "gate" : "npm-test"}", "pid": ${process.pid}}`;
      ftruncateSync(fd, 0);
      writeSync(fd, owner, 0, "utf8");
      acquired(gate);
      console.error(`gate: acquired lock=${path} holder=${owner}`);
      const child = spawnSync(body[0]!, body.slice(1), { stdio: ["inherit", "inherit", "inherit", fd], env: { ...process.env, A4S_HEAVY_SLOT_HELD: "1" } });
      if (child.error) throw child.error;
      const code = child.status ?? (128 + (constants.signals[child.signal!] ?? 0));
      if (!gate || code !== 86) { process.exitCode = code; return; }
      releaseLock(fd);
      const configured = Number(process.env.A4S_INTEGRATION_POLL_SEC ?? "1");
      await sleep((Number.isFinite(configured) && configured >= 0 ? configured : 1) * 1000);
    }
  } finally { closeSync(fd); }
}
