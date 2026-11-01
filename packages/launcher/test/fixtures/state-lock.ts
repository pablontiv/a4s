import type { StateDependencies } from "../../src/station-state.ts";

/** A deadline-aware keyed mutex: no flock helper, subprocess or live station. */
export function stateLock() {
  interface Waiter { grant: () => void }
  const locks = new Map<string, { held: boolean; queue: Waiter[] }>();
  const holds: Array<{ path: string; milliseconds: number }> = [];
  const withFileLock: NonNullable<StateDependencies["withFileLock"]> = async (path, body, options) => {
    const lock = locks.get(path) ?? { held: false, queue: [] };
    locks.set(path, lock);
    if (lock.held && options?.timeoutMs === 0) {
      throw Object.assign(new Error(`Timed out acquiring ${path} after 0ms`), { code: "ETIMEDOUT" });
    }
    if (lock.held) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timeoutMs = options?.timeoutMs ?? 10000;
      const waiter: Waiter = { grant() { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        lock.queue.splice(lock.queue.indexOf(waiter), 1);
        reject(Object.assign(new Error(`Timed out acquiring ${path} after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      lock.queue.push(waiter);
      await promise;
    }
    lock.held = true;
    const started = performance.now();
    try { return await body(); }
    finally {
      holds.push({ path, milliseconds: performance.now() - started });
      const next = lock.queue.shift();
      if (next) next.grant(); else lock.held = false;
    }
  };
  return { withFileLock, holds, held: (path: string) => locks.get(path)?.held === true };
}

export function barrier() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
}
