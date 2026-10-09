import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

const INPUT = "Inspecciona package.json en modo read_only. Devuelve en esta misma respuesta el valor exacto de engines.node y cita la ruta. No modifiques archivos.";
const EXPECTED_NODE_ENGINE = ">=22.19.0";
const SCHEMA = "a4s.pi-atomic-e2e/v1";
const FAILURE_SCHEMA = "a4s.pi-atomic-e2e-failure/v1";
const PI_CLI = "/Users/pones/.local/bin/pi";
const DEFAULT_AGENT_DIR = "/Users/pones/.pi/agent";
const SUBJECT_PROVIDER = "openai-codex";
const SUBJECT_MODEL = "gpt-5.6-sol";
const JUDGE_PROVIDER = "openai-codex";
const JUDGE_MODEL = "gpt-5.6-terra";
const SUBJECT_TIMEOUT_MS = 300_000;
const JUDGE_TIMEOUT_SECONDS = 180;
const MAX_CAPTURED_EVENTS = 100;
const MAX_CAPTURED_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_WATCHER_EVENTS = 100;
const REQUIRED_WORKER_FIELDS = [
  "status",
  "summary",
  "result_or_artifacts",
  "evidence_or_validation",
  "risks_or_uncertainty",
] as const;

type JsonRecord = Record<string, unknown>;
type CapturedEvent = { streamIndex: number; event: JsonRecord };
type Inventory = { digest: string; entryCount: number };
type WatcherSnapshot = { eventCount: number; overflow: boolean };

type StructuralOracle = {
  unitCount: number;
  dispatchCount: number;
  workerResultCount: number;
  parentFinalCount: number;
  subjectSettledCount: number;
  laterDomainPhaseCount: number;
};

type Analysis = {
  oracle: StructuralOracle;
  unit: CapturedEvent;
  unitText: string;
  dispatchMessage: CapturedEvent;
  dispatchStart: CapturedEvent;
  dispatchCall: JsonRecord;
  workerResult: CapturedEvent;
  results: unknown[];
  workerInternalTrajectoryAvailable: boolean;
  final: CapturedEvent;
  finalText: string;
  settled: CapturedEvent;
  toolStartCount: number;
  toolEndCount: number;
  extensionErrorCount: number;
};

type DiagnosticState = {
  stage: string;
  counts?: StructuralOracle;
  rpcEventCount?: number;
  capturedEventCount?: number;
  watcherEventCount?: number;
  watcherOverflow?: boolean;
  inventoryBefore?: Inventory;
  inventoryAfter?: Inventory;
};

const diagnosticState: DiagnosticState = { stage: "preflight" };

class HarnessFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function fail(code: string): never {
  throw new HarnessFailure(code);
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value);
  if (item) {
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function messageText(message: unknown): string {
  const value = record(message);
  if (!value) return "";
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content.map((part) => {
    const block = record(part);
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
}

function assistantToolCalls(message: unknown): JsonRecord[] {
  const value = record(message);
  if (value?.role !== "assistant" || !Array.isArray(value.content)) return [];
  return value.content
    .map(record)
    .filter((block): block is JsonRecord => block?.type === "toolCall");
}

function workerContractComplete(result: string): boolean {
  const lines = result.split("\n");
  const normalized = lines.map((line) => line.trim().replace(/^#{1,6}\s+/, ""));
  const indices = REQUIRED_WORKER_FIELDS.map((field) => {
    const matches = normalized
      .map((line, index) => line === field || line.startsWith(`${field}:`) ? index : -1)
      .filter((index) => index >= 0);
    return matches.length === 1 ? matches[0]! : -1;
  });
  if (indices.some((index) => index < 0)) return false;
  if (indices.some((index, position) => position > 0 && index <= indices[position - 1]!)) return false;
  for (let position = 0; position < REQUIRED_WORKER_FIELDS.length; position += 1) {
    const start = indices[position]!;
    const end = indices[position + 1] ?? lines.length;
    const separator = normalized[start]!.indexOf(":");
    const firstValue = separator >= 0 ? normalized[start]!.slice(separator + 1) : "";
    const section = [firstValue, ...lines.slice(start + 1, end)].join("\n").trim();
    if (!section) return false;
    if (REQUIRED_WORKER_FIELDS[position] === "status" && section !== "completed") return false;
  }
  return result.includes(EXPECTED_NODE_ENGINE) && result.includes("package.json");
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function inventoryTree(root: string): Promise<Inventory> {
  const rows: string[] = [];
  const rootMetadata = await lstat(root);
  rows.push(JSON.stringify([
    ".",
    "directory",
    rootMetadata.mode,
    rootMetadata.mtimeMs,
    rootMetadata.ctimeMs,
  ]));
  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(absoluteDirectory, entry.name);
      const metadata = await lstat(absolutePath);
      if (entry.isDirectory()) {
        rows.push(JSON.stringify([
          relativePath,
          "directory",
          metadata.mode,
          metadata.mtimeMs,
          metadata.ctimeMs,
        ]));
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        rows.push(JSON.stringify([
          relativePath,
          "file",
          metadata.mode,
          metadata.size,
          metadata.mtimeMs,
          metadata.ctimeMs,
          await hashFile(absolutePath),
        ]));
      } else if (entry.isSymbolicLink()) {
        rows.push(JSON.stringify([
          relativePath,
          "symlink",
          metadata.mode,
          metadata.mtimeMs,
          metadata.ctimeMs,
          await readlink(absolutePath),
        ]));
      } else {
        rows.push(JSON.stringify([
          relativePath,
          "other",
          metadata.mode,
          metadata.size,
          metadata.mtimeMs,
          metadata.ctimeMs,
        ]));
      }
    }
  }
  await visit(root, "");
  return {
    digest: createHash("sha256").update(rows.join("\n")).digest("hex"),
    entryCount: rows.length,
  };
}

export function startMutationWatcher(root: string): {
  snapshot: () => WatcherSnapshot;
  stop: () => WatcherSnapshot;
} {
  let eventCount = 0;
  let overflow = false;
  let stopped = false;
  const watcher: FSWatcher = watch(root, { recursive: true }, () => {
    if (eventCount < MAX_WATCHER_EVENTS) eventCount += 1;
    else overflow = true;
  });
  const snapshot = (): WatcherSnapshot => ({ eventCount, overflow });
  return {
    snapshot,
    stop: () => {
      if (!stopped) {
        watcher.close();
        stopped = true;
      }
      return snapshot();
    },
  };
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function runBounded(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let finished = false;
    const timer = setTimeout(() => rejectProcess("PROCESS_TIMEOUT"), options.timeoutMs);
    function rejectProcess(code: string): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killProcessGroup(child.pid);
      reject(new HarnessFailure(code));
    }
    function countOutput(chunk: Buffer, keep: boolean): void {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        rejectProcess("PROCESS_OUTPUT_LIMIT");
        return;
      }
      if (keep) stdout.push(chunk);
    }
    child.stdout.on("data", (chunk: Buffer) => countOutput(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => countOutput(chunk, false));
    child.once("error", () => rejectProcess("PROCESS_START_FAILED"));
    child.once("close", (code) => {
      killProcessGroup(child.pid);
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

async function validatePython(python: string, root: string): Promise<void> {
  if (!isAbsolute(python)) fail("PYTHON_PATH_INVALID");
  await stat(python).catch(() => fail("PYTHON_UNAVAILABLE"));
  const script = [
    "import importlib.metadata as metadata",
    "import json",
    "import sys",
    "print(json.dumps({'agentevals': metadata.version('agentevals'), 'openevals': metadata.version('openevals'), 'executable': sys.executable}, sort_keys=True))",
  ].join("; ");
  const result = await runBounded(python, ["-c", script], {
    cwd: root,
    env: { ...process.env },
    timeoutMs: 10_000,
  });
  if (result.code !== 0) fail("PYTHON_PACKAGES_UNAVAILABLE");
  let value: JsonRecord | undefined;
  try {
    value = record(JSON.parse(result.stdout));
  } catch {
    fail("PYTHON_IDENTITY_INVALID");
  }
  if (
    value?.agentevals !== "0.0.9"
    || value.openevals !== "0.2.0"
    || typeof value.executable !== "string"
    || await realpath(value.executable) !== await realpath(python)
  ) {
    fail("PYTHON_IDENTITY_INVALID");
  }
}

async function createRuntimeAgentDir(temporaryDirectory: string): Promise<string> {
  const runtimeAgentDir = resolve(temporaryDirectory, "agent");
  await mkdir(runtimeAgentDir, { mode: 0o700 });
  await mkdir(resolve(runtimeAgentDir, "sessions"), { mode: 0o700 });
  const requiredResources = [
    "auth.json",
    "models.json",
    "models-store.json",
    "settings.json",
    "agents",
  ];
  for (const name of requiredResources) {
    const source = resolve(DEFAULT_AGENT_DIR, name);
    await lstat(source).catch(() => fail("AGENT_RESOURCE_UNAVAILABLE"));
    await symlink(source, resolve(runtimeAgentDir, name));
  }
  await writeFile(resolve(runtimeAgentDir, "subagents.json"), `${JSON.stringify({
    default_mode: "task",
    default_model: `${SUBJECT_PROVIDER}/${SUBJECT_MODEL}`,
    default_effort: "high",
    timeout_ms: 180_000,
    stall_timeout_ms: 60_000,
    max_concurrency: 1,
    session_resources: "lean",
  })}\n`, { mode: 0o600 });
  return runtimeAgentDir;
}

function analyze(captured: CapturedEvent[]): Analysis {
  const units = captured.filter(({ event }) => {
    if (event.type !== "message_end") return false;
    const message = record(event.message);
    return message?.role === "user" && messageText(message) === INPUT;
  });
  const allStarts = captured.filter(({ event }) => event.type === "tool_execution_start");
  const allEnds = captured.filter(({ event }) => event.type === "tool_execution_end");
  const dispatches = allStarts.filter(({ event }) => event.toolName === "subagent_run");
  const workerResults = allEnds.filter(({ event }) => event.toolName === "subagent_run");
  const settled = captured.filter(({ event }) => event.type === "agent_settled");
  const extensionErrors = captured.filter(({ event }) => event.type === "extension_error");
  const dispatchMessages = captured.filter(({ event }) => {
    return event.type === "message_end" && assistantToolCalls(event.message).length > 0;
  });
  const workerResultStreamIndex = workerResults[0]?.streamIndex ?? -1;
  const finals = captured.filter(({ event, streamIndex }) => {
    if (streamIndex <= workerResultStreamIndex || event.type !== "message_end") return false;
    const message = record(event.message);
    return message?.role === "assistant"
      && assistantToolCalls(message).length === 0
      && messageText(message).trim().length > 0;
  });
  const laterDomainPhases = allStarts.filter(({ streamIndex }) => streamIndex > workerResultStreamIndex);
  const oracle: StructuralOracle = {
    unitCount: units.length,
    dispatchCount: dispatches.length,
    workerResultCount: workerResults.length,
    parentFinalCount: finals.length,
    subjectSettledCount: settled.length,
    laterDomainPhaseCount: laterDomainPhases.length,
  };
  diagnosticState.counts = oracle;
  const expected: StructuralOracle = {
    unitCount: 1,
    dispatchCount: 1,
    workerResultCount: 1,
    parentFinalCount: 1,
    subjectSettledCount: 1,
    laterDomainPhaseCount: 0,
  };
  for (const key of Object.keys(expected) as Array<keyof StructuralOracle>) {
    if (oracle[key] !== expected[key]) fail("STRUCTURAL_COUNTS_INVALID");
  }
  if (allStarts.length !== 1 || allEnds.length !== 1 || dispatchMessages.length !== 1) {
    fail("TOOL_CARDINALITY_INVALID");
  }
  if (extensionErrors.length !== 0) fail("SUBJECT_EXTENSION_ERROR");

  const unit = units[0]!;
  const dispatchMessage = dispatchMessages[0]!;
  const dispatchStart = dispatches[0]!;
  const workerResult = workerResults[0]!;
  const final = finals[0]!;
  const settledEvent = settled[0]!;
  const calls = assistantToolCalls(dispatchMessage.event.message);
  if (calls.length !== 1) fail("DISPATCH_MESSAGE_INVALID");
  const dispatchCall = calls[0]!;
  const dispatchArgs = record(dispatchStart.event.args);
  const callArgs = record(dispatchCall.arguments);
  if (
    dispatchCall.name !== "subagent_run"
    || typeof dispatchCall.id !== "string"
    || dispatchCall.id.length === 0
    || dispatchStart.event.toolCallId !== dispatchCall.id
    || !dispatchArgs
    || !callArgs
    || canonical(dispatchArgs) !== canonical(callArgs)
    || dispatchArgs.agent !== "explorer"
    || (dispatchArgs.mode !== undefined && dispatchArgs.mode !== "task")
  ) {
    fail("DISPATCH_IDENTITY_INVALID");
  }
  if (
    !(unit.streamIndex < dispatchMessage.streamIndex
      && dispatchMessage.streamIndex < dispatchStart.streamIndex
      && dispatchStart.streamIndex < workerResult.streamIndex
      && workerResult.streamIndex < final.streamIndex
      && final.streamIndex < settledEvent.streamIndex)
  ) {
    fail("SUBJECT_ORDER_INVALID");
  }
  if (workerResult.event.isError !== false || workerResult.event.toolCallId !== dispatchCall.id) {
    fail("WORKER_TOOL_RESULT_INVALID");
  }
  const details = record(record(workerResult.event.result)?.details);
  if (!details || !Array.isArray(details.results) || details.results.length !== 1) {
    fail("WORKER_RESULTS_INVALID");
  }
  const task = record(details.results[0]);
  if (
    !task
    || task.agent !== "explorer"
    || task.status !== "completed"
    || task.effective_mode !== "task"
    || typeof task.result !== "string"
    || !workerContractComplete(task.result)
  ) {
    fail("WORKER_CONTRACT_INVALID");
  }
  const unitText = messageText(record(unit.event.message));
  const finalText = messageText(record(final.event.message));
  if (!finalText.includes(EXPECTED_NODE_ENGINE) || !finalText.includes("package.json")) {
    fail("SUBJECT_RESULT_INVALID");
  }
  return {
    oracle,
    unit,
    unitText,
    dispatchMessage,
    dispatchStart,
    dispatchCall,
    workerResult,
    results: details.results,
    workerInternalTrajectoryAvailable: Object.hasOwn(task, "thread_snapshot"),
    final,
    finalText,
    settled: settledEvent,
    toolStartCount: allStarts.length,
    toolEndCount: allEnds.length,
    extensionErrorCount: extensionErrors.length,
  };
}

function evaluationFailure(result: JsonRecord | undefined): never {
  const status = result?.status;
  const error = result?.error;
  if (status === "VETO") {
    diagnosticState.stage = "judge";
    fail("JUDGE_VETO");
  }
  if (error === "BRIDGE_FAILURE") {
    diagnosticState.stage = "bridge";
    fail("BRIDGE_FAILURE");
  }
  if (error === "JUDGE_TIMEOUT" || error === "JUDGE_FAILURE") {
    diagnosticState.stage = "judge";
    fail(error);
  }
  diagnosticState.stage = "agentevals";
  fail(typeof error === "string" && /^[A-Z0-9_]+$/.test(error) ? error : "AGENTEVALS_FAILURE");
}

async function persistFailureEvidence(error: unknown): Promise<string> {
  const code = error instanceof HarnessFailure ? error.code : `${diagnosticState.stage.toUpperCase()}_UNEXPECTED`;
  const directory = await mkdtemp(resolve(tmpdir(), "a4s-pi-atomic-failure-"));
  await chmod(directory, 0o700);
  const path = resolve(directory, "evidence.json");
  const evidence = {
    schema: FAILURE_SCHEMA,
    stage: diagnosticState.stage,
    code,
    counts: diagnosticState.counts ?? null,
    rpcEventCount: diagnosticState.rpcEventCount ?? null,
    capturedEventCount: diagnosticState.capturedEventCount ?? null,
    watcherEventCount: diagnosticState.watcherEventCount ?? null,
    watcherOverflow: diagnosticState.watcherOverflow ?? null,
    inventoryBefore: diagnosticState.inventoryBefore ?? null,
    inventoryAfter: diagnosticState.inventoryAfter ?? null,
  };
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function main(): Promise<void> {
  if (process.env.A4S_RUN_AGENT_E2E !== "1") fail("OPT_IN_REQUIRED");
  const python = process.env.A4S_PYTHON;
  if (!python) fail("A4S_PYTHON_REQUIRED");

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const packagePath = resolve(root, "package.json");
  const adapterPath = resolve(root, "evals/pi_atomic_e2e/adapter.py");
  const bridgePath = resolve(root, "evals/pi_atomic_e2e/judge-result.ts");
  const extensionPath = resolve(DEFAULT_AGENT_DIR, "npm/node_modules/pi-subagents-j0k3r/index.ts");
  const extensionPackagePath = resolve(DEFAULT_AGENT_DIR, "npm/node_modules/pi-subagents-j0k3r/package.json");

  await Promise.all([
    stat(PI_CLI),
    stat(adapterPath),
    stat(bridgePath),
    stat(extensionPath),
  ]).catch(() => fail("RUNTIME_PATH_UNAVAILABLE"));
  await validatePython(python, root);
  const [packageBytes, extensionPackageBytes] = await Promise.all([
    readFile(packagePath),
    readFile(extensionPackagePath),
  ]);
  const packageValue = JSON.parse(packageBytes.toString("utf8")) as JsonRecord;
  const extensionPackage = JSON.parse(extensionPackageBytes.toString("utf8")) as JsonRecord;
  if (record(packageValue.engines)?.node !== EXPECTED_NODE_ENGINE) fail("WORKSPACE_IDENTITY_INVALID");
  if (extensionPackage.name !== "pi-subagents-j0k3r" || extensionPackage.version !== "1.6.1") {
    fail("SUBAGENT_EXTENSION_IDENTITY_INVALID");
  }

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "a4s-pi-atomic-run-"));
  let client: RpcClient | undefined;
  let unsubscribe: (() => void) | undefined;
  let mutationWatcher: ReturnType<typeof startMutationWatcher> | undefined;
  let initialInventory: Inventory | undefined;
  let watcherStopped = false;
  try {
    const runtimeAgentDir = await createRuntimeAgentDir(temporaryDirectory);
    initialInventory = await inventoryTree(root);
    diagnosticState.inventoryBefore = initialInventory;
    mutationWatcher = startMutationWatcher(root);

    const captured: CapturedEvent[] = [];
    let capturedBytes = 0;
    let captureFailure = false;
    let streamIndex = 0;
    const retainedTypes = new Set([
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "agent_settled",
      "extension_error",
    ]);
    client = new RpcClient({
      cliPath: PI_CLI,
      cwd: root,
      provider: SUBJECT_PROVIDER,
      model: SUBJECT_MODEL,
      env: { PI_CODING_AGENT_DIR: runtimeAgentDir },
      args: [
        "--no-session",
        "--no-extensions",
        "--extension", extensionPath,
        "--tools", "subagent_run",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
      ],
    });
    unsubscribe = client.onEvent((rawEvent: JsonAgentSessionEvent) => {
      streamIndex += 1;
      const event = record(rawEvent);
      if (!event || !retainedTypes.has(String(event.type))) return;
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      capturedBytes += eventBytes;
      if (captured.length >= MAX_CAPTURED_EVENTS || capturedBytes > MAX_CAPTURED_BYTES) {
        captureFailure = true;
        return;
      }
      captured.push({ streamIndex, event });
    });

    diagnosticState.stage = "subject";
    await client.start();
    const state = await client.getState();
    if (state.model?.provider !== SUBJECT_PROVIDER || state.model.id !== SUBJECT_MODEL) {
      fail("SUBJECT_MODEL_INVALID");
    }
    await client.setAutoRetry(false);
    await client.setAutoCompaction(false);
    const disposition = await client.prompt(INPUT);
    if (disposition !== "started") fail("SUBJECT_PROMPT_NOT_STARTED");
    await client.waitForIdle(SUBJECT_TIMEOUT_MS);
    diagnosticState.rpcEventCount = streamIndex;
    diagnosticState.capturedEventCount = captured.length;
    if (captureFailure) fail("SUBJECT_TRAJECTORY_LIMIT");

    diagnosticState.stage = "structure";
    const analysis = analyze(captured);
    if (analysis.settled.streamIndex !== streamIndex) fail("SUBJECT_SETTLED_NOT_FINAL");

    unsubscribe();
    unsubscribe = undefined;
    await client.stop();
    client = undefined;

    diagnosticState.stage = "mutation";
    const afterSubjectInventory = await inventoryTree(root);
    diagnosticState.inventoryAfter = afterSubjectInventory;
    const subjectWatcher = mutationWatcher.snapshot();
    diagnosticState.watcherEventCount = subjectWatcher.eventCount;
    diagnosticState.watcherOverflow = subjectWatcher.overflow;
    if (
      canonical(initialInventory) !== canonical(afterSubjectInventory)
      || subjectWatcher.eventCount !== 0
      || subjectWatcher.overflow
    ) {
      fail("SUBJECT_MUTATION_DETECTED");
    }

    const runnerObservation = {
      source: "runner",
      rpcEventCount: streamIndex,
      capturedEventCount: captured.length,
      lastRpcStreamIndex: streamIndex,
      settledStreamIndex: analysis.settled.streamIndex,
      toolStartCount: analysis.toolStartCount,
      toolEndCount: analysis.toolEndCount,
      extensionErrorCount: analysis.extensionErrorCount,
      laterDomainPhaseCount: analysis.oracle.laterDomainPhaseCount,
      subjectSettledCount: analysis.oracle.subjectSettledCount,
      settledWasLastRpcEvent: analysis.settled.streamIndex === streamIndex,
      inventoryBefore: initialInventory,
      inventoryAfterSubject: afterSubjectInventory,
      inventoryEqual: canonical(initialInventory) === canonical(afterSubjectInventory),
      watcherEventCount: subjectWatcher.eventCount,
      watcherOverflow: subjectWatcher.overflow,
      workerInternalTrajectoryAvailable: analysis.workerInternalTrajectoryAvailable,
    };
    const trajectory = {
      schema: SCHEMA,
      input: analysis.unitText,
      events: [
        {
          order: 1,
          streamIndex: analysis.unit.streamIndex,
          type: "unit",
          content: analysis.unitText,
        },
        {
          order: 2,
          streamIndex: analysis.dispatchMessage.streamIndex,
          startedStreamIndex: analysis.dispatchStart.streamIndex,
          type: "dispatch",
          toolCallId: analysis.dispatchCall.id,
          toolName: analysis.dispatchCall.name,
          args: analysis.dispatchStart.event.args,
        },
        {
          order: 3,
          streamIndex: analysis.workerResult.streamIndex,
          type: "worker_result",
          toolCallId: analysis.workerResult.event.toolCallId,
          toolName: analysis.workerResult.event.toolName,
          isError: analysis.workerResult.event.isError,
          details: { results: analysis.results },
        },
        {
          order: 4,
          streamIndex: analysis.final.streamIndex,
          type: "parent_final",
          content: analysis.finalText,
        },
        {
          order: 5,
          streamIndex: analysis.settled.streamIndex,
          type: "subject_settled",
        },
      ],
      runnerObservation,
    };
    const trajectoryPath = resolve(temporaryDirectory, "trajectory.json");
    await writeFile(trajectoryPath, `${JSON.stringify(trajectory)}\n`, { mode: 0o600 });

    diagnosticState.stage = "agentevals";
    let evaluation: { code: number; stdout: string } | undefined;
    let evaluationError: unknown;
    try {
      evaluation = await runBounded(python, [
        adapterPath,
        "--trajectory", trajectoryPath,
        "--bridge", bridgePath,
        "--provider", JUDGE_PROVIDER,
        "--model", JUDGE_MODEL,
        "--timeout-seconds", String(JUDGE_TIMEOUT_SECONDS),
      ], {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: runtimeAgentDir },
        timeoutMs: (JUDGE_TIMEOUT_SECONDS + 30) * 1000,
      });
    } catch (error) {
      evaluationError = error;
    }

    const finalInventory = await inventoryTree(root);
    diagnosticState.inventoryAfter = finalInventory;
    const finalWatcher = mutationWatcher.stop();
    watcherStopped = true;
    diagnosticState.watcherEventCount = finalWatcher.eventCount;
    diagnosticState.watcherOverflow = finalWatcher.overflow;
    if (
      canonical(initialInventory) !== canonical(finalInventory)
      || finalWatcher.eventCount !== 0
      || finalWatcher.overflow
    ) {
      diagnosticState.stage = "mutation";
      fail("E2E_MUTATION_DETECTED");
    }
    if (evaluationError) throw evaluationError;
    if (!evaluation) fail("AGENTEVALS_PROCESS_FAILURE");

    const lines = evaluation.stdout.trim().split("\n");
    let result: JsonRecord | undefined;
    if (lines.length === 1) {
      try {
        result = record(JSON.parse(lines[0]!));
      } catch {
        result = undefined;
      }
    }
    if (evaluation.code !== 0) evaluationFailure(result);
    const judge = record(result?.judge);
    if (
      result?.schema !== SCHEMA
      || result.status !== "PASS"
      || result.blocking !== false
      || judge?.key !== "trajectory_accuracy"
      || judge.score !== true
    ) {
      evaluationFailure(result);
    }
    diagnosticState.stage = "completed";
    process.stdout.write("PI_ATOMIC_E2E PASS\n");
  } finally {
    unsubscribe?.();
    await client?.stop().catch(() => undefined);
    if (mutationWatcher && !watcherStopped) {
      const snapshot = mutationWatcher.stop();
      diagnosticState.watcherEventCount = snapshot.eventCount;
      diagnosticState.watcherOverflow = snapshot.overflow;
      if (initialInventory) {
        try {
          diagnosticState.inventoryAfter = await inventoryTree(root);
        } catch {
          delete diagnosticState.inventoryAfter;
        }
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function reportFailure(error: unknown): Promise<void> {
  let evidencePath = "unavailable";
  try {
    evidencePath = await persistFailureEvidence(error);
  } catch {
    evidencePath = "unavailable";
  }
  const code = error instanceof HarnessFailure ? error.code : `${diagnosticState.stage.toUpperCase()}_UNEXPECTED`;
  const counts = diagnosticState.counts
    ? Object.entries(diagnosticState.counts).map(([key, value]) => `${key}:${value}`).join(",")
    : "unavailable";
  process.stderr.write(
    `PI_ATOMIC_E2E FAIL stage=${diagnosticState.stage} code=${code} counts=${counts} evidence=${evidencePath}\n`,
  );
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch(reportFailure);
}
