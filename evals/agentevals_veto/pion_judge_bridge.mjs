#!/usr/bin/env node

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const SCHEMA = "a4s.pion-judge-bridge/v1";
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_REASONING_CHARS = 8_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error("bridge input is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("message content is invalid");
  return content.map((part) => {
    const item = record(part);
    if (!item || item.type !== "text" || typeof item.text !== "string") {
      throw new Error("message content is invalid");
    }
    return item.text;
  }).join("\n");
}

function pionMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages are invalid");
  return messages.map((message, index) => {
    const item = record(message);
    if (!item || !["system", "user", "assistant"].includes(item.role)) {
      throw new Error("message role is invalid");
    }
    const content = textContent(item.content);
    if (item.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "openai-completions",
        provider: "bridge-input",
        model: "bridge-input",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: index,
      };
    }
    return { role: item.role, content, timestamp: index };
  });
}

const judgeTool = {
  name: "judge_result",
  description: "Return the required semantic gate decision.",
  parameters: {
    type: "object",
    properties: {
      score: { type: "boolean", description: "True only when all trusted criteria pass." },
      reasoning: {
        type: "string",
        maxLength: MAX_REASONING_CHARS,
        description: "A concise reason for the decision.",
      },
    },
    required: ["score", "reasoning"],
    additionalProperties: false,
  },
  constrainedSampling: { type: "json_schema", strict: "require" },
};

async function main() {
  const request = record(await readRequest());
  if (!request || !exactKeys(request, ["messages", "model", "provider", "schema", "timeout_ms"])) {
    throw new Error("bridge request is invalid");
  }
  if (
    request.schema !== SCHEMA ||
    typeof request.provider !== "string" || !request.provider ||
    typeof request.model !== "string" || !request.model ||
    !Number.isInteger(request.timeout_ms) || request.timeout_ms <= 0
  ) {
    throw new Error("bridge request is invalid");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("bridge timeout")), request.timeout_ms);
  const abort = () => controller.abort(new Error("bridge terminated"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: true,
      signal: controller.signal,
    });
    const model = runtime.getModel(request.provider, request.model);
    if (!model || model.provider !== request.provider || model.id !== request.model) {
      throw new Error("configured model was not found");
    }
    const auth = await runtime.getAuth(model, { signal: controller.signal });
    if (!auth) throw new Error("provider is not authenticated");

    const response = await runtime.completeSimple(
      model,
      { messages: pionMessages(request.messages), tools: [judgeTool] },
      {
        signal: controller.signal,
        timeoutMs: request.timeout_ms,
        maxRetries: 0,
        toolChoice: "auto",
      },
    );
    if (
      response.provider !== request.provider ||
      response.model !== request.model ||
      response.stopReason !== "toolUse"
    ) {
      throw new Error("model response identity is invalid");
    }
    if (response.content.length !== 1 || response.content[0]?.type !== "toolCall") {
      throw new Error("model response must contain one tool call");
    }
    const call = response.content[0];
    const result = record(call.arguments);
    if (
      call.name !== "judge_result" ||
      !result ||
      !exactKeys(result, ["reasoning", "score"]) ||
      typeof result.score !== "boolean" ||
      typeof result.reasoning !== "string" ||
      result.reasoning.length > MAX_REASONING_CHARS
    ) {
      throw new Error("judge_result is invalid");
    }
    process.stdout.write(JSON.stringify({
      schema: SCHEMA,
      provider: response.provider,
      model: response.model,
      stop_reason: response.stopReason,
      result,
    }));
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : "bridge failed"));
