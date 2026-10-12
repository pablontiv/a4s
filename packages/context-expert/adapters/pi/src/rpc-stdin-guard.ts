/**
 * Reference helper for RPC callers that invoke slow commands like `compact`.
 *
 * Pi's vendored RPC transport (`rpc-mode.js`) tears the session down
 * unconditionally and immediately when stdin closes ("end"), without
 * waiting for any in-flight command: it unsubscribes the event forwarder,
 * disposes the runtime, then exits. A real Jev-backed `compact` takes
 * 15-50+ seconds; a caller that writes its commands to a file or pipe and
 * lets stdin close right after writing races that teardown and gets back a
 * fast, generic `{"success":false,"error":"Compaction cancelled"}` with no
 * diagnostic subcode. See this package's README, "RPC callers must hold
 * stdin open through compact".
 *
 * This module has no dependency on a live `pi` process: it operates over an
 * injected transport so the id-correlation and framing logic is unit
 * testable without spawning anything. `scripts/run-rpc-compact.ts` wires it
 * to a real `pi --mode rpc` child process.
 */

export interface JsonlTransport {
  write(line: string): void;
  onLine(handler: (line: string) => void): () => void;
}

export interface RpcCommand {
  readonly type: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface RpcResponse {
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly id?: string;
  readonly error?: string;
  readonly data?: unknown;
}

export class RpcResponseTimeoutError extends Error {
  constructor(
    readonly commandType: string,
    readonly id: string,
  ) {
    super(`RPC response timed out for "${commandType}" (id=${id})`);
    this.name = "RpcResponseTimeoutError";
  }
}

function isRpcResponse(value: unknown): value is RpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "response" &&
    typeof (value as { command?: unknown }).command === "string" &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

/**
 * Writes `command` to `transport` and resolves only once a matching
 * `{type:"response", id}` line arrives. The actual fix for the stdin-hold
 * race is structural: a caller that `await`s this before ending the child
 * process's stdin keeps that transport open through the full lifetime of a
 * slow command instead of racing it.
 */
export function sendCommandAndAwaitResponse(
  transport: JsonlTransport,
  command: RpcCommand,
  options: { timeoutMs?: number } = {},
): Promise<RpcResponse> {
  if (!command.id) throw new RangeError("command.id is required to correlate its response");
  const { id } = command;

  return new Promise<RpcResponse>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const unsubscribe = transport.onLine((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRpcResponse(parsed) || parsed.id !== id) return;
      settle(() => resolve(parsed));
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle(() => reject(new RpcResponseTimeoutError(command.type, id)));
      }, options.timeoutMs);
    }

    transport.write(`${JSON.stringify(command)}\n`);

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      action();
    }
  });
}

/**
 * Strict JSONL line splitter matching pi's RPC framing contract: split on
 * `\n` only, tolerate a trailing `\r`, and never use a generic line reader.
 * Node's `readline` also splits on U+2028/U+2029, which are valid inside
 * JSON strings and would corrupt framing.
 */
export function createJsonlLineReader(onLine: (line: string) => void): {
  feed: (chunk: string) => void;
  end: () => void;
} {
  let buffer = "";
  return {
    feed(chunk: string): void {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    end(): void {
      if (buffer.length === 0) return;
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      onLine(line);
    },
  };
}
