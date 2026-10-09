import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

const INPUT = "Inspecciona package.json en modo read_only. Devuelve en esta misma respuesta el valor exacto de engines.node y cita la ruta. No modifiques archivos.";
const EXPECTED_NODE_ENGINE = ">=22.19.0";
const SCHEMA = "a4s.pi-atomic-e2e/v1";
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
const REQUIRED_WORKER_FIELDS = [
  "status",
  "summary",
  "result_or_artifacts",
  "evidence_or_validation",
  "risks_or_uncertainty",
] as const;

type JsonRecord = Record<string, unknown>;
type CapturedEvent = { streamIndex: number; event: JsonRecord };

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
  final: CapturedEvent;
  finalText: string;
  settled: CapturedEvent;
};

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

function findWorkerFields(result: string): string[] {
  const lines = result.split("\n");
  return REQUIRED_WORKER_FIELDS.filter((field) => lines.some((line) => line.startsWith(`${field}:`)));
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
    const timer = setTimeout(() => fail(new Error("process timeout")), options.timeoutMs);
    function fail(error: Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killProcessGroup(child.pid);
      reject(error);
    }
    function countOutput(chunk: Buffer, keep: boolean): void {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        fail(new Error("process output is too large"));
        return;
      }
      if (keep) stdout.push(chunk);
    }
    child.stdout.on("data", (chunk: Buffer) => countOutput(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => countOutput(chunk, false));
    child.once("error", fail);
    child.once("close", (code) => {
      killProcessGroup(child.pid);
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

async function captureWorktreeState(root: string): Promise<string> {
  const env = { ...process.env };
  const commands = [
    ["status", "--porcelain=v2", "--untracked-files=all"],
    ["diff", "--no-ext-diff", "--binary", "HEAD", "--"],
    ["diff", "--cached", "--no-ext-diff", "--binary", "HEAD", "--"],
  ];
  const values: string[] = [];
  for (const args of commands) {
    const result = await runBounded("git", args, { cwd: root, env, timeoutMs: 10_000 });
    if (result.code !== 0) throw new Error("worktree state check failed");
    values.push(result.stdout);
  }
  return JSON.stringify(values);
}

async function validatePython(python: string, root: string): Promise<void> {
  if (!isAbsolute(python)) throw new Error("A4S_PYTHON must be an absolute path");
  await stat(python);
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
  if (result.code !== 0) throw new Error("A4S_PYTHON does not contain AgentEvals");
  const value = record(JSON.parse(result.stdout));
  if (
    value?.agentevals !== "0.0.9"
    || value.openevals !== "0.2.0"
    || typeof value.executable !== "string"
    || await realpath(value.executable) !== await realpath(python)
  ) {
    throw new Error("A4S_PYTHON has an incompatible evaluation environment");
  }
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
  const expected: StructuralOracle = {
    unitCount: 1,
    dispatchCount: 1,
    workerResultCount: 1,
    parentFinalCount: 1,
    subjectSettledCount: 1,
    laterDomainPhaseCount: 0,
  };
  for (const key of Object.keys(expected) as Array<keyof StructuralOracle>) {
    if (oracle[key] !== expected[key]) throw new Error("structural oracle failed");
  }
  if (
    allStarts.length !== 1
    || allEnds.length !== 1
    || dispatchMessages.length !== 1
    || captured.some(({ event }) => event.type === "extension_error")
  ) {
    throw new Error("subject tool evidence is invalid");
  }

  const unit = units[0]!;
  const dispatchMessage = dispatchMessages[0]!;
  const dispatchStart = dispatches[0]!;
  const workerResult = workerResults[0]!;
  const final = finals[0]!;
  const settledEvent = settled[0]!;
  const calls = assistantToolCalls(dispatchMessage.event.message);
  if (calls.length !== 1) throw new Error("subject dispatch message is invalid");
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
    throw new Error("subject dispatch identity is invalid");
  }
  if (
    !(unit.streamIndex < dispatchMessage.streamIndex
      && dispatchMessage.streamIndex < dispatchStart.streamIndex
      && dispatchStart.streamIndex < workerResult.streamIndex
      && workerResult.streamIndex < final.streamIndex
      && final.streamIndex < settledEvent.streamIndex)
  ) {
    throw new Error("subject event order is invalid");
  }
  if (
    workerResult.event.isError !== false
    || workerResult.event.toolCallId !== dispatchCall.id
  ) {
    throw new Error("worker tool result is invalid");
  }
  const details = record(record(workerResult.event.result)?.details);
  if (!details || !Array.isArray(details.results) || details.results.length !== 1) {
    throw new Error("worker details.results is invalid");
  }
  const task = record(details.results[0]);
  if (
    !task
    || task.agent !== "explorer"
    || task.status !== "completed"
    || task.effective_mode !== "task"
    || typeof task.result !== "string"
    || findWorkerFields(task.result).length !== REQUIRED_WORKER_FIELDS.length
    || !task.result.split("\n").some((line) => line.startsWith("status: completed"))
  ) {
    throw new Error("worker contract is incomplete");
  }
  const unitText = messageText(record(unit.event.message));
  const finalText = messageText(record(final.event.message));
  if (!finalText.includes(EXPECTED_NODE_ENGINE) || !finalText.includes("package.json")) {
    throw new Error("subject result is incorrect");
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
    final,
    finalText,
    settled: settledEvent,
  };
}

async function main(): Promise<void> {
  if (process.env.A4S_RUN_AGENT_E2E !== "1") {
    throw new Error("Set A4S_RUN_AGENT_E2E=1 to run the Pi atomic E2E.");
  }
  const python = process.env.A4S_PYTHON;
  if (!python) throw new Error("Set A4S_PYTHON to the prepared AgentEvals interpreter.");

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const packagePath = resolve(root, "package.json");
  const adapterPath = resolve(root, "evals/pi_atomic_e2e/adapter.py");
  const bridgePath = resolve(root, "evals/pi_atomic_e2e/judge-result.ts");
  const extensionPath = resolve(DEFAULT_AGENT_DIR, "npm/node_modules/pi-subagents-j0k3r/index.ts");
  const extensionPackagePath = resolve(DEFAULT_AGENT_DIR, "npm/node_modules/pi-subagents-j0k3r/package.json");
  const projectPiDir = resolve(root, ".pi");
  const projectConfigPath = resolve(projectPiDir, "subagents.json");
  const agentDir = process.env.PI_CODING_AGENT_DIR || DEFAULT_AGENT_DIR;

  await Promise.all([stat(PI_CLI), stat(adapterPath), stat(bridgePath), stat(extensionPath)]);
  await validatePython(python, root);
  const [packageBytes, extensionPackageBytes] = await Promise.all([
    readFile(packagePath),
    readFile(extensionPackagePath),
  ]);
  const packageValue = JSON.parse(packageBytes.toString("utf8")) as JsonRecord;
  const extensionPackage = JSON.parse(extensionPackageBytes.toString("utf8")) as JsonRecord;
  if (record(packageValue.engines)?.node !== EXPECTED_NODE_ENGINE) {
    throw new Error("package.json has an unexpected Node engine");
  }
  if (extensionPackage.name !== "pi-subagents-j0k3r" || extensionPackage.version !== "1.6.1") {
    throw new Error("pi-subagents-j0k3r@1.6.1 is required");
  }
  try {
    await stat(projectPiDir);
    throw new Error("the runner requires an absent project .pi directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const initialWorktreeState = await captureWorktreeState(root);
  if (initialWorktreeState !== JSON.stringify(["", "", ""])) {
    throw new Error("the runner requires a clean worktree");
  }

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "a4s-pi-atomic-"));
  let client: RpcClient | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await mkdir(projectPiDir, { mode: 0o700 });
    await writeFile(projectConfigPath, `${JSON.stringify({
      default_mode: "task",
      default_model: `${SUBJECT_PROVIDER}/${SUBJECT_MODEL}`,
      default_effort: "high",
      timeout_ms: 180_000,
      stall_timeout_ms: 60_000,
      max_concurrency: 1,
      session_resources: "lean",
    })}\n`, { mode: 0o600 });

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
      env: { PI_CODING_AGENT_DIR: agentDir },
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

    await client.start();
    const state = await client.getState();
    if (state.model?.provider !== SUBJECT_PROVIDER || state.model.id !== SUBJECT_MODEL) {
      throw new Error("subject model identity is invalid");
    }
    await client.setAutoRetry(false);
    await client.setAutoCompaction(false);
    const disposition = await client.prompt(INPUT);
    if (disposition !== "started") throw new Error("subject prompt did not start");
    await client.waitForIdle(SUBJECT_TIMEOUT_MS);
    if (captureFailure) throw new Error("subject trajectory is too large");
    const analysis = analyze(captured);

    unsubscribe();
    unsubscribe = undefined;
    await client.stop();
    client = undefined;
    await rm(projectPiDir, { recursive: true, force: true });
    if (await captureWorktreeState(root) !== initialWorktreeState) {
      throw new Error("the subject changed the worktree");
    }

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
    };
    const trajectoryPath = resolve(temporaryDirectory, "trajectory.json");
    await writeFile(trajectoryPath, `${JSON.stringify(trajectory)}\n`, { mode: 0o600 });

    const evaluation = await runBounded(python, [
      adapterPath,
      "--trajectory", trajectoryPath,
      "--bridge", bridgePath,
      "--provider", JUDGE_PROVIDER,
      "--model", JUDGE_MODEL,
      "--timeout-seconds", String(JUDGE_TIMEOUT_SECONDS),
    ], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      timeoutMs: (JUDGE_TIMEOUT_SECONDS + 30) * 1000,
    });
    if (evaluation.code !== 0) throw new Error("AgentEvals rejected the trajectory");
    const lines = evaluation.stdout.trim().split("\n");
    if (lines.length !== 1) throw new Error("AgentEvals output is invalid");
    const result = record(JSON.parse(lines[0]!));
    const judge = record(result?.judge);
    if (
      result?.schema !== SCHEMA
      || result.status !== "PASS"
      || result.blocking !== false
      || judge?.key !== "trajectory_accuracy"
      || judge.score !== true
    ) {
      throw new Error("AgentEvals did not pass");
    }
    process.stdout.write("PI_ATOMIC_E2E PASS\n");
  } finally {
    unsubscribe?.();
    await client?.stop().catch(() => undefined);
    await rm(projectPiDir, { recursive: true, force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write("PI_ATOMIC_E2E FAIL\n");
  process.exitCode = 1;
});
