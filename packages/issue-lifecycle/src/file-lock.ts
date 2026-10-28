import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  return flock(fd, EXCLUSIVE | (nonblocking ? NONBLOCKING : 0));
}
export function releaseLock(fd: number): void { flock(fd, UNLOCK); }
export function withFileLock<T>(path: string, body: () => T): T {
  const fd = openLock(path);
  try { acquireLock(fd); return body(); }
  finally { closeSync(fd); }
}
export async function withFileLockAsync<T>(path: string, body: () => Promise<T>): Promise<T> {
  const fd = openLock(path);
  try {
    while (!acquireLock(fd, true)) await delay(25);
    return await body();
  }
  finally { closeSync(fd); }
}
