import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

const INPUT = "Inspecciona package.json en modo read_only. Devuelve en esta misma respuesta el valor exacto de engines.node y cita la ruta. No modifiques archivos.";
const EXPECTED_NODE_ENGINE = ">=22.19.0";
const SCHEMA = "a4s.pi-atomic-e2e/v1";
const PI_CLI = "/Users/pones/.local/bin/pi";
const PYTHON = "/Users/pones/.local/bin/python3.11";
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

type StructuralOracle = {
  unitCount: number;
  dispatchCount: number;
  workerResultCount: number;
  parentFinalCount: number;
  subjectSettledCount: number;
  laterDomainPhaseCount: number;
};

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
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

function assistantHasToolCall(message: unknown): boolean {
  const value = record(message);
  return Array.isArray(value?.content)
    && value.content.some((part) => record(part)?.type === "toolCall");
}

function taskFromWorkerEvent(event: JsonRecord): JsonRecord | undefined {
  const details = record(record(event.result)?.details);
  if (!details) return undefined;
  if (Array.isArray(details.results) && details.results.length === 1) {
    return record(details.results[0]);
  }
  if (Array.isArray(details.tasks) && details.tasks.length === 1) {
    return record(details.tasks[0]);
  }
  return record(details.task);
}

function findWorkerFields(result: string): string[] {
  return REQUIRED_WORKER_FIELDS.filter((field) => {
    const expression = new RegExp(`(?:^|\\n)${field}\\s*:`, "m");
    return expression.test(result);
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        fail(new Error("evaluation output is too large"));
        return;
      }
      stdout.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) fail(new Error("evaluation output is too large"));
    });
    child.once("error", fail);
    const timer = setTimeout(() => fail(new Error("evaluation timeout")), options.timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

function analyze(events: JsonRecord[]): {
  oracle: StructuralOracle;
  worker: JsonRecord;
  workerResult: string;
  workerFields: string[];
  final: string;
  dispatch: JsonRecord;
} {
  const units = events.filter((event) => {
    if (event.type !== "message_end") return false;
    const message = record(event.message);
    return message?.role === "user" && messageText(message) === INPUT;
  });
  const dispatches = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "subagent_run");
  const workerResults = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent_run");
  const settled = events.filter((event) => event.type === "agent_settled");
  const workerResultIndex = events.findIndex((event) => event === workerResults[0]);
  const finals = events.filter((event, index) => {
    if (index <= workerResultIndex || event.type !== "message_end") return false;
    const message = record(event.message);
    return message?.role === "assistant"
      && !assistantHasToolCall(message)
      && messageText(message).trim().length > 0;
  });
  const laterDomainPhases = events.filter((event, index) => {
    return index > workerResultIndex && event.type === "tool_execution_start";
  });
  const oracle: StructuralOracle = {
    unitCount: units.length,
    dispatchCount: dispatches.length,
    workerResultCount: workerResults.length,
    parentFinalCount: finals.length,
    subjectSettledCount: settled.length,
    laterDomainPhaseCount: laterDomainPhases.length,
  };
  for (const [key, expected] of Object.entries({
    unitCount: 1,
    dispatchCount: 1,
    workerResultCount: 1,
    parentFinalCount: 1,
    subjectSettledCount: 1,
    laterDomainPhaseCount: 0,
  })) {
    if (oracle[key as keyof StructuralOracle] !== expected) {
      throw new Error("structural oracle failed");
    }
  }

  const dispatch = dispatches[0]!;
  const dispatchArgs = record(dispatch.args);
  if (dispatchArgs?.agent !== "explorer" || (dispatchArgs.mode !== undefined && dispatchArgs.mode !== "task")) {
    throw new Error("worker dispatch is invalid");
  }
  const workerEvent = workerResults[0]!;
  if (workerEvent.isError !== false || workerEvent.toolCallId !== dispatch.toolCallId) {
    throw new Error("worker tool evidence is invalid");
  }
  const worker = taskFromWorkerEvent(workerEvent);
  if (
    !worker
    || worker.agent !== "explorer"
    || worker.status !== "completed"
    || worker.effective_mode !== "task"
    || typeof worker.result !== "string"
  ) {
    throw new Error("worker result is invalid");
  }
  const workerResult = worker.result;
  const workerFields = findWorkerFields(workerResult);
  if (
    workerFields.length !== REQUIRED_WORKER_FIELDS.length
    || !/(?:^|\n)status\s*:\s*completed\b/m.test(workerResult)
  ) {
    throw new Error("worker contract is incomplete");
  }
  const final = messageText(record(finals[0]!.message));
  if (!final.includes(EXPECTED_NODE_ENGINE) || !final.includes("package.json")) {
    throw new Error("subject result is incorrect");
  }
  if (events.some((event) => event.type === "extension_error")) {
    throw new Error("subject extension failed");
  }
  return { oracle, worker, workerResult, workerFields, final, dispatch };
}

async function main(): Promise<void> {
  if (process.env.A4S_RUN_AGENT_E2E !== "1") {
    throw new Error("Set A4S_RUN_AGENT_E2E=1 to run the Pi atomic E2E.");
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const packagePath = resolve(root, "package.json");
  const adapterPath = resolve(root, "evals/pi_atomic_e2e/adapter.py");
  const bridgePath = resolve(root, "evals/pi_atomic_e2e/judge-result.ts");
  const extensionPath = resolve(DEFAULT_AGENT_DIR, "npm/node_modules/pi-subagents-j0k3r/index.ts");
  const extensionPackagePath = resolve(DEFAULT_AGENT_DIR, "npm/node_modules/pi-subagents-j0k3r/package.json");
  const projectPiDir = resolve(root, ".pi");
  const projectConfigPath = resolve(projectPiDir, "subagents.json");
  const agentDir = process.env.PI_CODING_AGENT_DIR || DEFAULT_AGENT_DIR;

  await Promise.all([stat(PI_CLI), stat(PYTHON), stat(adapterPath), stat(bridgePath), stat(extensionPath)]);
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
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code !== "ENOENT") throw error;
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

    const captured: JsonRecord[] = [];
    let capturedBytes = 0;
    let captureFailure = false;
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
      const event = record(rawEvent);
      if (!event || !retainedTypes.has(String(event.type))) return;
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      capturedBytes += eventBytes;
      if (captured.length >= MAX_CAPTURED_EVENTS || capturedBytes > MAX_CAPTURED_BYTES) {
        captureFailure = true;
        return;
      }
      captured.push(event);
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
    if (sha256(await readFile(packagePath)) !== sha256(packageBytes)) {
      throw new Error("package.json changed during read-only inspection");
    }
    const trajectory = {
      schema: SCHEMA,
      input: INPUT,
      oracle: analysis.oracle,
      worker: {
        agent: analysis.worker.agent,
        status: analysis.worker.status,
        result: analysis.workerResult,
        fields: analysis.workerFields,
      },
      final: analysis.final,
      messages: [
        {
          role: "system",
          content: JSON.stringify({
            source: "Pi RpcClient events",
            subject: `${SUBJECT_PROVIDER}/${SUBJECT_MODEL}`,
            extension: "pi-subagents-j0k3r@1.6.1",
            oracle: analysis.oracle,
          }),
        },
        { role: "user", content: INPUT },
        {
          role: "assistant",
          content: `subagent_run dispatch: ${JSON.stringify(analysis.dispatch.args)}`,
        },
        {
          role: "assistant",
          content: `Explorer result:\n${analysis.workerResult}`,
        },
        {
          role: "assistant",
          content: `Parent final response:\n${analysis.final}`,
        },
      ],
    };
    const trajectoryPath = resolve(temporaryDirectory, "trajectory.json");
    await writeFile(trajectoryPath, `${JSON.stringify(trajectory)}\n`, { mode: 0o600 });

    unsubscribe();
    unsubscribe = undefined;
    await client.stop();
    client = undefined;

    const evaluation = await runBounded(PYTHON, [
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
