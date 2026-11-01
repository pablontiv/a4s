import { spawnSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readServiceEnvironment } from "./service-environment.ts";

const EXCLUSIVE = 2;
const NONBLOCKING = 4;
const UNLOCK = 8;
interface Libc {
  flock(fd: number, operation: number): number;
  errno(): number;
}
let libc: Libc | undefined;
function bunLibc(): Libc {
  if (libc) return libc;
  // Keep Bun's native module out of Node/tsx's module loader. The library stays
  // open for the process lifetime; flock locks the actual open file description.
  const ffi = createRequire(import.meta.url)("bun:ffi") as {
    dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): { symbols: Record<string, (...args: number[]) => number> };
    read: { i32(pointer: number): number };
  };
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  const library = ffi.dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    [errnoSymbol]: { args: [], returns: "ptr" },
  });
  libc = { flock: (fd, operation) => library.symbols.flock!(fd, operation), errno: () => ffi.read.i32(library.symbols[errnoSymbol]!()) };
  return libc;
}

/** Node tooling uses standard-library fcntl on an inherited duplicate of fd.
 * The parent's descriptor retains the same kernel lock after that child exits.
 * Released Bun engines use libc directly and never execute this Python branch.
 * Node-hosted users require python3 on the declared service PATH, checked by
 * service-environment.ts before execution; core tool identities, not PATH, are pinned.
 */
function flock(fd: number, operation: number): boolean {
  if (process.versions.bun) {
    const native = bunLibc();
    for (;;) {
      if (native.flock(fd, operation) === 0) return true;
      const errno = native.errno();
      if (errno === 4) continue; // EINTR
      if (operation & NONBLOCKING && errno === (process.platform === "darwin" ? 35 : 11)) return false;
      throw new Error(`flock failed: errno=${errno}`);
    }
  }
  const result = spawnSync("python3", ["-c", "import fcntl,sys\ntry: fcntl.flock(3,int(sys.argv[1]))\nexcept BlockingIOError: sys.exit(73)", String(operation)], {
    stdio: ["ignore", "ignore", "pipe", fd],
    env: { ...process.env, ...readServiceEnvironment() },
  });
  if (result.status === 73 && operation & NONBLOCKING) return false;
  if (result.status !== 0) throw new Error(`flock failed: ${result.error?.message || result.stderr?.toString().trim() || result.status}`);
  return true;
}
export function openLock(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  return openSync(path, "a+", 0o600);
}
export function acquireLock(fd: number, nonblocking = false): boolean {
  if (!flock(fd, EXCLUSIVE | (nonblocking ? NONBLOCKING : 0))) return false;
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), command: process.argv, acquiredAt: new Date().toISOString() })}\n`);
    return true;
  } catch (error) { flock(fd, UNLOCK); throw error; }
}
export function releaseLock(fd: number): void { flock(fd, UNLOCK); }
export function withFileLock<T>(path: string, body: () => T): T {
  const fd = openLock(path);
  try { acquireLock(fd); return body(); }
  finally { closeSync(fd); }
}
export interface LockOptions { timeoutMs?: number }
export async function withFileLockAsync<T>(path: string, body: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Lock timeout must be nonnegative");
  const deadline = performance.now() + timeoutMs;
  const fd = openLock(path);
  let attempted = false;
  try {
    for (;;) {
      if (attempted && performance.now() >= deadline) {
        let holder: string;
        try { holder = readFileSync(path, "utf8").trim() || "unknown (no holder metadata)"; }
        catch { holder = "unknown (holder metadata unreadable)"; }
        throw Object.assign(new Error(`Lock acquisition timed out after ${timeoutMs}ms: ${path}; holder=${holder}`), { code: "ETIMEDOUT" });
      }
      attempted = true;
      if (acquireLock(fd, true)) break;
      const remaining = deadline - performance.now();
      if (remaining > 0) await delay(Math.min(25, remaining));
    }
    return await body();
  }
  finally { closeSync(fd); }
}
