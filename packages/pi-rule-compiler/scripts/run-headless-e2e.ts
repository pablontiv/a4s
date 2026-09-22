#!/usr/bin/env -S npx tsx
/**
 * Product E2E for the Pi Rule Compiler extension.
 *
 * This intentionally uses the locally configured Pi model and TypeSafe/Jev
 * credential. It neither supplies a model nor writes RPC output/transcripts;
 * Pi's session files remain in the evidence directory for inspection.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonlLineReader } from "../src/rpc-stdin-guard.ts";

const COMMAND_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const CORPUS_ENTRY_TYPE = "a4s.pi-rule-compiler.corpus.v1";

interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
}

interface CorpusEntryIds {
  chunkIds: Set<string>;
  receiptIds: Set<string>;
}

interface ResponseWaiter {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  eventType: string;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class HeadlessPi {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #responseWaiters = new Map<string, ResponseWaiter>();
  readonly #eventWaiters = new Set<EventWaiter>();
  readonly #closed: Promise<number | null>;

  constructor(args: readonly string[]) {
    this.#child = spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"] });
    // Keep stderr drained without exposing provider diagnostics or credentials.
    this.#child.stderr.on("data", () => undefined);
    const reader = createJsonlLineReader((line) => this.#receiveLine(line));
    this.#child.stdout.on("data", (chunk: Buffer) => reader.feed(chunk.toString("utf8")));
    this.#child.stdout.on("end", () => reader.end());
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", (code) => {
        const error = new Error("Pi process closed before the E2E completed");
        for (const waiter of this.#responseWaiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.#responseWaiters.clear();
        for (const waiter of this.#eventWaiters) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.#eventWaiters.clear();
        resolve(code);
      });
    });
    this.#child.once("error", () => {
      const error = new Error("Pi process could not start");
      for (const waiter of this.#responseWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.#responseWaiters.clear();
      for (const waiter of this.#eventWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.#eventWaiters.clear();
    });
  }

  request(type: string, data: Record<string, unknown> = {}): Promise<RpcResponse> {
    const id = `e2e-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#responseWaiters.delete(id);
        reject(new Error(`Timed out waiting for the ${type} response`));
      }, COMMAND_TIMEOUT_MS);
      this.#responseWaiters.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ type, id, ...data })}\n`, (error) => {
        if (!error) return;
        const waiter = this.#responseWaiters.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.#responseWaiters.delete(id);
        waiter.reject(new Error("Unable to write an RPC command to Pi"));
      });
    });
  }

  waitForEvent(eventType: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: EventWaiter = {
        eventType,
        resolve: () => resolve(),
        reject,
        timer: setTimeout(() => {
          this.#eventWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for the ${eventType} event`));
        }, COMMAND_TIMEOUT_MS),
      };
      this.#eventWaiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    const code = await Promise.race([
      this.#closed,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (code === "timeout") {
      this.#child.kill("SIGTERM");
      await this.#closed;
      return;
    }
    if (code !== 0) throw new Error("Pi exited unsuccessfully");
  }

  #receiveLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "response" && typeof value.id === "string" && typeof value.command === "string" && typeof value.success === "boolean") {
      const waiter = this.#responseWaiters.get(value.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.#responseWaiters.delete(value.id);
      waiter.resolve({
        type: "response",
        command: value.command,
        success: value.success,
        ...(typeof value.id === "string" ? { id: value.id } : {}),
        ...("data" in value ? { data: value.data } : {}),
      });
      return;
    }
    if (typeof value.type !== "string") return;
    for (const waiter of [...this.#eventWaiters]) {
      if (waiter.eventType !== value.type) continue;
      clearTimeout(waiter.timer);
      this.#eventWaiters.delete(waiter);
      waiter.resolve();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSuccess(response: RpcResponse, command: string): unknown {
  if (!response.success || response.command !== command) {
    throw new Error(`${command} was not successful`);
  }
  return response.data;
}

function requireConfiguredModel(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.model)) {
    throw new Error("Pi has no configured model");
  }
  const sessionFile = data.sessionFile;
  if (typeof sessionFile !== "string" || sessionFile.length === 0) {
    throw new Error("Pi did not provide a session artifact");
  }
  return sessionFile;
}

function collectCorpusEntryIds(data: unknown): CorpusEntryIds {
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw new Error("Pi did not return session entries");
  }
  const chunkIds = new Set<string>();
  const receiptIds = new Set<string>();
  for (const entry of data.entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CORPUS_ENTRY_TYPE || !isRecord(entry.data)) continue;
    if (entry.data.schema === "a4s.corpus-chunk/v1" && typeof entry.data.id === "string") {
      if (chunkIds.has(entry.data.id)) throw new Error("Pi persisted duplicate corpus chunks");
      chunkIds.add(entry.data.id);
    }
    if (entry.data.schema === "a4s.corpus-receipt/v1" && typeof entry.data.idempotencyKey === "string") {
      if (receiptIds.has(entry.data.idempotencyKey)) throw new Error("Pi persisted duplicate corpus receipts");
      receiptIds.add(entry.data.idempotencyKey);
    }
  }
  if (chunkIds.size === 0 || receiptIds.size === 0) {
    throw new Error("Pi did not persist the required corpus entries");
  }
  return { chunkIds, receiptIds };
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function piArgs(extensionPath: string, sessionDir: string, sessionFile?: string): string[] {
  return [
    "--mode", "rpc",
    "--approve",
    "--no-extensions",
    "--no-builtin-tools",
    "--session-dir", sessionDir,
    "-e", extensionPath,
    ...(sessionFile === undefined ? [] : ["--session", sessionFile]),
  ];
}

async function runFirstSession(extensionPath: string, sessionDir: string): Promise<{ sessionFile: string; ids: CorpusEntryIds }> {
  const pi = new HeadlessPi(piArgs(extensionPath, sessionDir));
  try {
    const state = requireSuccess(await pi.request("get_state"), "get_state");
    const sessionFile = requireConfiguredModel(state);
    for (const message of ["Reply with the single word ready.", "Reply with the single word acknowledged."]) {
      const settled = pi.waitForEvent("agent_settled");
      requireSuccess(await pi.request("prompt", { message }), "prompt");
      await settled;
    }
    requireSuccess(await pi.request("compact"), "compact");
    const ids = collectCorpusEntryIds(requireSuccess(await pi.request("get_entries"), "get_entries"));
    return { sessionFile, ids };
  } finally {
    await pi.close();
  }
}

async function runReloadedSession(extensionPath: string, sessionDir: string, sessionFile: string): Promise<CorpusEntryIds> {
  const pi = new HeadlessPi(piArgs(extensionPath, sessionDir, sessionFile));
  try {
    return collectCorpusEntryIds(requireSuccess(await pi.request("get_entries"), "get_entries"));
  } finally {
    await pi.close();
  }
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(scriptDir, "..");
  const repositoryDir = resolve(packageDir, "..", "..");
  const runDir = resolve(
    repositoryDir,
    "artifacts",
    "pi-rule-compiler-e2e",
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`,
  );
  const sessionDir = resolve(runDir, "sessions");
  await mkdir(sessionDir, { recursive: true });

  try {
    const extensionPath = resolve(packageDir, "src", "index.ts");
    const first = await runFirstSession(extensionPath, sessionDir);
    const reloaded = await runReloadedSession(extensionPath, sessionDir, first.sessionFile);
    if (!sameIds(first.ids.chunkIds, reloaded.chunkIds) || !sameIds(first.ids.receiptIds, reloaded.receiptIds)) {
      throw new Error("Pi reload did not preserve the corpus entry ids");
    }
    process.stdout.write(`Pi Rule Compiler E2E passed. Evidence: ${runDir}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unexpected E2E failure";
    process.stderr.write(`Pi Rule Compiler E2E failed: ${reason}. Evidence preserved: ${runDir}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { main };
