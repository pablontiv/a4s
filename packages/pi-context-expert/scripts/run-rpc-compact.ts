#!/usr/bin/env -S npx tsx
/**
 * Reference RPC driver for `compact`: spawns `pi --mode rpc`, sends a
 * `compact` command, and only ends the child's stdin after the matching
 * response has arrived.
 *
 * This exists because pi's vendored RPC transport tears the session down
 * immediately and unconditionally when stdin closes, without waiting for
 * in-flight commands (see ../README.md, "RPC callers must hold stdin open
 * through compact"). Any script that writes its commands to a fixed input
 * (a file, `< input.jsonl`, or a writer that closes right after writing)
 * races a slow `compact` and gets back a fast, misleading
 * `{"success":false,"error":"Compaction cancelled"}`. This driver is the
 * PoC-correct alternative: it keeps the pipe open until the real response
 * arrives, then closes it.
 *
 * Usage:
 *   npx tsx scripts/run-rpc-compact.ts --pi <path-to-pi-binary> \
 *     [--extension <path>] [--fork <session.jsonl>] [--no-extensions] \
 *     [--custom-instructions <text>] [--timeout-ms <n>] \
 *     [-- <extra raw args passed through to pi>]
 *
 * Example (matching the a4s-6ak.7 diagnosis repro, but held open correctly):
 *   npx tsx scripts/run-rpc-compact.ts \
 *     --pi node_modules/.bin/pi \
 *     --fork /tmp/some-snapshot.jsonl \
 *     -- --no-extensions --extension packages/pi-context-expert/src/index.ts
 */
import { spawn } from "node:child_process";
import {
  createJsonlLineReader,
  sendCommandAndAwaitResponse,
  type JsonlTransport,
} from "../src/rpc-stdin-guard.ts";

interface ParsedArgs {
  piBinary: string;
  extraArgs: string[];
  customInstructions: string | undefined;
  timeoutMs: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let piBinary: string | undefined;
  let customInstructions: string | undefined;
  let timeoutMs = 120_000;
  const passthrough: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--pi") {
      piBinary = argv[++i];
    } else if (arg === "--custom-instructions") {
      customInstructions = argv[++i];
    } else if (arg === "--timeout-ms") {
      const raw = argv[++i];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new RangeError(`--timeout-ms must be a positive integer, got: ${raw}`);
      }
      timeoutMs = parsed;
    } else if (arg === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else {
      passthrough.push(arg);
    }
    i += 1;
  }

  if (!piBinary) throw new RangeError("--pi <path-to-pi-binary> is required");
  return { piBinary, extraArgs: passthrough, customInstructions, timeoutMs };
}

function createChildTransport(child: {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
}): JsonlTransport {
  return {
    write(line) {
      child.stdin.write(line);
    },
    onLine(handler) {
      const reader = createJsonlLineReader(handler);
      const onData = (chunk: Buffer | string) => {
        reader.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      };
      const onEnd = () => reader.end();
      child.stdout.on("data", onData);
      child.stdout.on("end", onEnd);
      return () => {
        child.stdout.off("data", onData);
        child.stdout.off("end", onEnd);
      };
    },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const { piBinary, extraArgs, customInstructions, timeoutMs } = parseArgs(argv);

  const child = spawn(piBinary, ["--mode", "rpc", ...extraArgs], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const transport = createChildTransport(child);

  // Best-effort visibility into everything streamed while we wait, since
  // the whole point of this driver is to observe the real (slow) lifecycle
  // instead of racing it.
  transport.onLine((line) => {
    process.stderr.write(`< ${line}\n`);
  });

  const id = `compact-${Date.now()}`;
  try {
    const response = await sendCommandAndAwaitResponse(
      transport,
      {
        type: "compact",
        id,
        ...(customInstructions !== undefined ? { customInstructions } : {}),
      },
      { timeoutMs },
    );
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return response.success ? 0 : 1;
  } finally {
    // Only end stdin now, after the compact response has actually arrived.
    // Ending it any earlier is exactly the race this driver exists to avoid.
    child.stdin.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

export { main, parseArgs };
