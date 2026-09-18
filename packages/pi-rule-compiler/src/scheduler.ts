import { OperationAbortedError } from "./deadline.ts";
import { JevApiError } from "./jev.ts";
import type {
  JevClient,
  JevRequest,
  JevRequestSchedulerStats,
} from "./types.ts";

export interface JevRequestSchedulerOptions {
  maxConcurrency?: number;
  maxRetries?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  maxRetryAfterMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface ScheduledJob {
  request: JevRequest;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

interface ResolvedSchedulerOptions {
  maxConcurrency: number;
  maxRetries: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  maxRetryAfterMs: number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class ScheduledJevClient implements JevClient {
  private readonly queue: ScheduledJob[] = [];
  private readonly resolved: ResolvedSchedulerOptions;
  private active = 0;
  private logicalRequests = 0;
  private attempts = 0;
  private retries = 0;
  private maxObservedConcurrency = 0;

  constructor(
    private readonly delegate: JevClient,
    options: JevRequestSchedulerOptions = {},
  ) {
    const backoffInitialMs = nonNegativeInteger(options.backoffInitialMs ?? 500, "backoffInitialMs");
    const backoffMaxMs = nonNegativeInteger(options.backoffMaxMs ?? 5_000, "backoffMaxMs");
    if (backoffInitialMs > backoffMaxMs) {
      throw new RangeError("backoffInitialMs cannot exceed backoffMaxMs");
    }
    this.resolved = {
      maxConcurrency: positiveInteger(options.maxConcurrency ?? 1, "maxConcurrency"),
      maxRetries: nonNegativeInteger(options.maxRetries ?? 3, "maxRetries"),
      backoffInitialMs,
      backoffMaxMs,
      maxRetryAfterMs: nonNegativeInteger(options.maxRetryAfterMs ?? 30_000, "maxRetryAfterMs"),
      sleep: options.sleep ?? abortableSleep,
    };
  }

  evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown> {
    if (options.signal.aborted) return Promise.reject(new OperationAbortedError());
    this.logicalRequests += 1;
    return new Promise<unknown>((resolve, reject) => {
      const job: ScheduledJob = {
        request,
        signal: options.signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new OperationAbortedError());
        },
      };
      options.signal.addEventListener("abort", job.onAbort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  getStats(): JevRequestSchedulerStats {
    return {
      maxConcurrency: this.resolved.maxConcurrency,
      maxRetries: this.resolved.maxRetries,
      logicalRequests: this.logicalRequests,
      attempts: this.attempts,
      retries: this.retries,
      maxObservedConcurrency: this.maxObservedConcurrency,
    };
  }

  private drain(): void {
    while (this.active < this.resolved.maxConcurrency) {
      const job = this.queue.shift();
      if (!job) return;
      job.signal.removeEventListener("abort", job.onAbort);
      if (job.signal.aborted) {
        job.reject(new OperationAbortedError());
        continue;
      }
      this.active += 1;
      this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.active);
      void this.run(job).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async run(job: ScheduledJob): Promise<void> {
    let retryIndex = 0;
    try {
      while (true) {
        if (job.signal.aborted) throw new OperationAbortedError();
        this.attempts += 1;
        try {
          job.resolve(await this.delegate.evaluate(job.request, { signal: job.signal }));
          return;
        } catch (error) {
          if (job.signal.aborted) throw new OperationAbortedError();
          if (!isRetryableRateError(error) || retryIndex >= this.resolved.maxRetries) throw error;
          const delay = retryDelay(error, retryIndex, this.resolved);
          retryIndex += 1;
          this.retries += 1;
          await this.resolved.sleep(delay, job.signal);
        }
      }
    } catch (error) {
      job.reject(error);
    }
  }
}

function isRetryableRateError(error: unknown): error is JevApiError {
  return error instanceof JevApiError && (error.status === 429 || error.status === 529);
}

function retryDelay(
  error: JevApiError,
  retryIndex: number,
  options: ResolvedSchedulerOptions,
): number {
  if (error.retryAfterMs !== undefined && error.retryAfterMs <= options.maxRetryAfterMs) {
    return error.retryAfterMs;
  }
  return Math.min(options.backoffInitialMs * 2 ** retryIndex, options.backoffMaxMs);
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new OperationAbortedError());
  if (milliseconds === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });

    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      reject(new OperationAbortedError());
    }
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}
