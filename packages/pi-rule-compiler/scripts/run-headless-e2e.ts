#!/usr/bin/env -S npx tsx
/**
 * Product E2E for the Pi Rule Compiler extension.
 *
 * This intentionally uses the locally configured Pi model and TypeSafe/Jev
 * credential. It neither supplies a model nor writes RPC output/transcripts;
 * Pi's session files remain in the evidence directory for inspection.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadGlobalCompactionConfiguration,
  PI_RULE_COMPILER_GLOBAL_CONFIG_PATH,
  resolveCompactionConfig,
} from "../src/config.ts";
import { stableDigest } from "../src/digest.ts";
import { LADDER_PROJECTION_RECEIPT_TYPE } from "../src/extension.ts";
import { createJsonlLineReader } from "../src/rpc-stdin-guard.ts";
import {
  collectEvidenceReceipts,
  collectRetroPendingMarkers,
  collectRuleProposalBatches,
  collectRuleSignalBatches,
} from "../src/storage.ts";
import {
  classifySafeCompactionNotification,
  type SafeCompactionDiagnosticCategory,
} from "./compaction-diagnostic.ts";
import {
  createCompactionE2ePrompts,
  createEvidenceE2ePrompts,
} from "./e2e-prompts.ts";

const COMMAND_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const CORPUS_ENTRY_TYPE = "a4s.pi-rule-compiler.corpus.v1";

type E2eMode = "basic" | "ladder" | "evidence";

export function parseE2eMode(args: readonly string[]): E2eMode {
  if (args.length === 0) return "basic";
  if (args[0] !== "--mode") throw new Error(`unknown E2E argument: ${args[0] ?? ""}`);
  if (
    args.length !== 2 ||
    (args[1] !== "basic" && args[1] !== "ladder" && args[1] !== "evidence")
  ) {
    throw new Error("--mode requires basic, ladder, or evidence");
  }
  return args[1];
}

export function assertE2eGlobalConfiguration(
  mode: E2eMode,
  raw: Readonly<Record<string, unknown>>,
): void {
  const configured = resolveCompactionConfig(raw);
  const requiredCompaction = mode === "basic" ? "basic" : "ladder";
  if (configured.compaction.strategy !== requiredCompaction) {
    throw new Error(
      `${PI_RULE_COMPILER_GLOBAL_CONFIG_PATH} must set compaction.strategy=${requiredCompaction} before starting the E2E`,
    );
  }
  if (mode !== "evidence") return;
  if (configured.evidence.strategy !== "ladder") {
    throw new Error(
      `${PI_RULE_COMPILER_GLOBAL_CONFIG_PATH} must set evidence.strategy=ladder before starting the Evidence E2E`,
    );
  }
  if (configured.trigger.mode === "auto") {
    throw new Error(
      `${PI_RULE_COMPILER_GLOBAL_CONFIG_PATH} must set trigger.mode=off or hint before starting the Evidence E2E`,
    );
  }
}

interface RpcResponse {
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly id?: string;
  readonly data?: unknown;
}

interface CorpusEntryIds {
  chunkIds: Set<string>;
  receiptIds: Set<string>;
}

export interface EvidenceArtifactIds {
  signalBatchIds: Set<string>;
  proposalIds: Set<string>;
  markerIds: Set<string>;
  receiptIds: Set<string>;
}

interface SessionArtifactIds {
  corpus: CorpusEntryIds;
  evidence?: EvidenceArtifactIds;
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
  #compactionDiagnostic: SafeCompactionDiagnosticCategory | undefined;

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

  get compactionDiagnostic(): SafeCompactionDiagnosticCategory | undefined {
    return this.#compactionDiagnostic;
  }

  clearCompactionDiagnostic(): void {
    this.#compactionDiagnostic = undefined;
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
    const compactionDiagnostic = classifySafeCompactionNotification(value);
    if (compactionDiagnostic !== undefined) {
      // Retain only the approved category, never the UI request or message.
      this.#compactionDiagnostic = compactionDiagnostic;
      return;
    }
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

function requireSuccessfulResponse(
  response: RpcResponse,
  command: string,
  diagnostic?: SafeCompactionDiagnosticCategory,
): void {
  if (response.success && response.command === command) return;
  const safeDiagnostic = diagnostic === undefined ? "" : ` (compaction diagnostic: ${diagnostic})`;
  throw new Error(`${command} was not successful${safeDiagnostic}`);
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

function collectEvidenceArtifactIds(data: unknown): EvidenceArtifactIds {
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw new Error("Pi did not return session entries");
  }
  const signalBatchIds = new Set(
    collectRuleSignalBatches(data.entries).map((batch) => stableDigest(batch)),
  );
  const proposalIds = new Set(
    collectRuleProposalBatches(data.entries).map((proposal) => proposal.idempotencyKey),
  );
  const markerIds = new Set(
    collectRetroPendingMarkers(data.entries).map((marker) => marker.attemptId),
  );
  const receiptIds = new Set(
    collectEvidenceReceipts(data.entries).map((receipt) => receipt.idempotencyKey),
  );
  const required: ReadonlyArray<[label: string, ids: ReadonlySet<string>]> = [
    ["signal batch", signalBatchIds],
    ["proposal", proposalIds],
    ["marker", markerIds],
    ["receipt", receiptIds],
  ];
  for (const [label, ids] of required) {
    if (ids.size === 0) throw new Error(`Pi did not persist Evidence ${label} artifacts`);
  }
  return { signalBatchIds, proposalIds, markerIds, receiptIds };
}

function requireRenderedLadderReceipt(data: unknown): void {
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw new Error("Pi did not return session entries");
  }
  const observed = data.entries.some((entry) => {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== LADDER_PROJECTION_RECEIPT_TYPE) return false;
    if (!isRecord(entry.data)) return false;
    return entry.data.schema === "a4s.ladder-projection-receipt/v1" &&
      entry.data.rendered === true &&
      typeof entry.data.selectedChunks === "number" &&
      entry.data.selectedChunks > 0;
  });
  if (!observed) throw new Error("Pi did not retain a rendered Ladder projection receipt");
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

export function assertReloadedEvidenceArtifacts(
  first: EvidenceArtifactIds,
  reloaded: EvidenceArtifactIds,
): void {
  const artifacts: ReadonlyArray<[
    label: string,
    firstIds: ReadonlySet<string>,
    reloadedIds: ReadonlySet<string>,
  ]> = [
    ["signal batch", first.signalBatchIds, reloaded.signalBatchIds],
    ["proposal", first.proposalIds, reloaded.proposalIds],
    ["marker", first.markerIds, reloaded.markerIds],
    ["receipt", first.receiptIds, reloaded.receiptIds],
  ];
  for (const [label, firstIds, reloadedIds] of artifacts) {
    if (!sameIds(firstIds, reloadedIds)) {
      throw new Error(`Pi reload did not preserve Evidence ${label} artifacts`);
    }
  }
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

async function runFirstSession(
  extensionPath: string,
  sessionDir: string,
  mode: E2eMode,
  runId: string,
): Promise<{ sessionFile: string; ids: SessionArtifactIds }> {
  const pi = new HeadlessPi(piArgs(extensionPath, sessionDir));
  try {
    const stateResponse = await pi.request("get_state");
    requireSuccessfulResponse(stateResponse, "get_state");
    const sessionFile = requireConfiguredModel(stateResponse.data);
    const prompts = mode === "evidence"
      ? createEvidenceE2ePrompts(runId)
      : createCompactionE2ePrompts(runId);
    for (const message of prompts) {
      const settled = pi.waitForEvent("agent_settled");
      const promptResponse = await pi.request("prompt", { message });
      requireSuccessfulResponse(promptResponse, "prompt");
      await settled;
    }
    pi.clearCompactionDiagnostic();
    const compactResponse = await pi.request("compact");
    requireSuccessfulResponse(compactResponse, "compact", pi.compactionDiagnostic);
    const entriesResponse = await pi.request("get_entries");
    requireSuccessfulResponse(entriesResponse, "get_entries");
    const corpus = collectCorpusEntryIds(entriesResponse.data);
    const evidence = mode === "evidence"
      ? collectEvidenceArtifactIds(entriesResponse.data)
      : undefined;
    return {
      sessionFile,
      ids: {
        corpus,
        ...(evidence === undefined ? {} : { evidence }),
      },
    };
  } finally {
    await pi.close();
  }
}

async function runReloadedSession(
  extensionPath: string,
  sessionDir: string,
  sessionFile: string,
  mode: E2eMode,
  runId: string,
): Promise<SessionArtifactIds> {
  const pi = new HeadlessPi(piArgs(extensionPath, sessionDir, sessionFile));
  try {
    const entriesResponse = await pi.request("get_entries");
    requireSuccessfulResponse(entriesResponse, "get_entries");
    const corpus = collectCorpusEntryIds(entriesResponse.data);
    const evidence = mode === "evidence"
      ? collectEvidenceArtifactIds(entriesResponse.data)
      : undefined;
    if (mode !== "basic") {
      const settled = pi.waitForEvent("agent_settled");
      const promptResponse = await pi.request("prompt", {
        message: `Retrieve the prior benign synthetic compaction input for E2E run ${runId} and reply only with acknowledged.`,
      });
      requireSuccessfulResponse(promptResponse, "prompt");
      await settled;
      const projectedEntriesResponse = await pi.request("get_entries");
      requireSuccessfulResponse(projectedEntriesResponse, "get_entries");
      requireRenderedLadderReceipt(projectedEntriesResponse.data);
    }
    return {
      corpus,
      ...(evidence === undefined ? {} : { evidence }),
    };
  } finally {
    await pi.close();
  }
}

async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const mode = parseE2eMode(args);
  assertE2eGlobalConfiguration(mode, loadGlobalCompactionConfiguration());
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
  const runId = randomUUID();
  await mkdir(sessionDir, { recursive: true });

  try {
    const extensionPath = resolve(packageDir, "src", "index.ts");
    const first = await runFirstSession(extensionPath, sessionDir, mode, runId);
    const reloaded = await runReloadedSession(
      extensionPath,
      sessionDir,
      first.sessionFile,
      mode,
      runId,
    );
    if (
      !sameIds(first.ids.corpus.chunkIds, reloaded.corpus.chunkIds) ||
      !sameIds(first.ids.corpus.receiptIds, reloaded.corpus.receiptIds)
    ) {
      throw new Error("Pi reload did not preserve the corpus entry ids");
    }
    if (mode === "evidence") {
      if (!first.ids.evidence || !reloaded.evidence) {
        throw new Error("Pi did not return Evidence artifacts for reload verification");
      }
      assertReloadedEvidenceArtifacts(first.ids.evidence, reloaded.evidence);
    }
    process.stdout.write(`Pi Rule Compiler E2E passed (${mode}). Evidence: ${runDir}\n`);
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
