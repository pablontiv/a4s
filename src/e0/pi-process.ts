import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

const TRACE_PREFIX = "A4S_E0_EVENT\t";
const STOP_DEADLINE_MS = 5_000;

export interface PiLaunchContext {
  endpoint: string;
  ownerId: string;
  bindingRevision: 1;
  sessionDir: string;
  extensionPath: string;
  onTrace(event: Record<string, unknown>): void;
}

export interface PiProcessHandle {
  readonly pid: number;
  stop(): Promise<void>;
}

export interface PiLauncher {
  start(context: PiLaunchContext): Promise<PiProcessHandle>;
}

export class RealPiLauncher implements PiLauncher {
  constructor(private readonly piBin = process.env.PI_BIN ?? "pi") {}

  async start(context: PiLaunchContext): Promise<PiProcessHandle> {
    const args = [
      "--mode", "rpc",
      "--approve",
      "--session-dir", context.sessionDir,
      "--no-builtin-tools",
      "-e", context.extensionPath,
    ];
    const env = {
      ...process.env,
      A4S_ENDPOINT: context.endpoint,
      A4S_OWNER_ID: context.ownerId,
      A4S_BINDING_REVISION: "1",
      A4S_E0_TRACE: "stderr",
    };

    const child = spawn(this.piBin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", () => undefined);
    forwardStderrTrace(child, context.onTrace);

    await waitForSpawn(child);
    if (typeof child.pid !== "number") {
      throw new Error("Pi process spawned without a pid");
    }

    return new RealPiProcessHandle(child);
  }
}

class RealPiProcessHandle implements PiProcessHandle {
  readonly pid: number;
  private stopped = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.pid = child.pid ?? -1;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.child.exitCode !== null || this.child.signalCode !== null || this.child.killed) {
      await waitForExitIfNeeded(this.child);
      return;
    }

    const exited = waitForExitIfNeeded(this.child);
    this.child.kill("SIGTERM");

    const exitedBeforeDeadline = await withTimeout(exited, STOP_DEADLINE_MS);
    if (exitedBeforeDeadline) return;

    if (process.platform === "win32") {
      this.child.kill();
    } else {
      this.child.kill("SIGKILL");
    }
    await exited;
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("exit", onExitBeforeSpawn);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExitBeforeSpawn = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Pi process exited before spawn was observed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExitBeforeSpawn);
  });
}

async function waitForExitIfNeeded(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit").then(() => undefined);
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function forwardStderrTrace(child: ChildProcessWithoutNullStreams, onTrace: (event: Record<string, unknown>) => void): void {
  let buffered = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    buffered += chunk;
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
      buffered = buffered.slice(newlineIndex + 1);
      forwardStderrLine(line, onTrace);
      newlineIndex = buffered.indexOf("\n");
    }
  });
  child.stderr.once("end", () => {
    if (buffered.length > 0) {
      forwardStderrLine(buffered.replace(/\r$/, ""), onTrace);
      buffered = "";
    }
  });
}

function forwardStderrLine(line: string, onTrace: (event: Record<string, unknown>) => void): void {
  if (line.startsWith(TRACE_PREFIX)) {
    const payload = line.slice(TRACE_PREFIX.length);
    try {
      const value = JSON.parse(payload) as unknown;
      if (isRecord(value)) {
        onTrace(value);
      } else {
        onTrace({ component: "pi-process", event: "invalid_trace", detail: "trace payload was not an object" });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onTrace({ component: "pi-process", event: "invalid_trace", detail });
    }
    return;
  }

  if (line.length > 0) {
    onTrace({ component: "pi-process", event: "stderr", detail: line });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
