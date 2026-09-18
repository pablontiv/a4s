export class DeadlineExceededError extends Error {
  readonly code = "timeout" as const;

  constructor() {
    super("operation deadline exceeded");
    this.name = "DeadlineExceededError";
  }
}

export class OperationAbortedError extends Error {
  readonly code = "aborted" as const;

  constructor() {
    super("operation aborted");
    this.name = "OperationAbortedError";
  }
}

export function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive integer");
  }
  if (parentSignal?.aborted) return Promise.reject(new OperationAbortedError());

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineExceededError();
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  const parentAbort = new Promise<never>((_resolve, reject) => {
    if (!parentSignal) return;
    onParentAbort = () => {
      const error = new OperationAbortedError();
      reject(error);
      controller.abort(error);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  });

  let pending: Promise<T>;
  try {
    pending = operation(controller.signal);
  } catch (error) {
    cleanup();
    return Promise.reject(error);
  }

  return Promise.race([pending, timeout, parentAbort]).finally(cleanup);

  function cleanup(): void {
    if (timer) clearTimeout(timer);
    if (parentSignal && onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
  }
}
