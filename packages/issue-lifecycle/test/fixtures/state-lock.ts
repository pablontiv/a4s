import type { withFileLockAsync } from "@a4s/launcher/file-lock";

// The launcher targets ES2022, which has no Promise.withResolvers declaration.
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Serialize each lock path in process, with the same deadline contract as flock. */
export function inProcessLock(timeoutMs = 100): typeof withFileLockAsync {
  const queues = new Map<string, Promise<void>>();
  return async (path, body, options = {}) => {
    const previous = queues.get(path) ?? Promise.resolve(), next = deferred();
    queues.set(path, next.promise);
    let acquired = false, timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Lock acquisition timed out: ${path}`), { code: "ETIMEDOUT" })), options.timeoutMs ?? timeoutMs);
      })]);
      acquired = true;
      return await body();
    } finally {
      clearTimeout(timer);
      if (acquired) next.resolve(); else void previous.then(next.resolve);
      if (queues.get(path) === next.promise) {
        void next.promise.then(() => { if (queues.get(path) === next.promise) queues.delete(path); });
      }
    }
  };
}
