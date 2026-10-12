import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTriggerDecision,
  buildTriggerState,
  createCoreAsker,
  evaluateTrigger,
  hasConservativeCompactableHistory,
  localTriggerGatesPass,
  toTriggerMessages,
  type JevClient,
  type JevRequest,
} from "../src/index.ts";
import { validJevResponse } from "./fixtures.ts";

class StrictTriggerJev implements JevClient {
  requests: JevRequest[] = [];

  async evaluate(request: JevRequest): Promise<unknown> {
    assert.deepEqual(Object.keys(request.questions), ["done", "shape"]);
    this.requests.push(request);
    return validJevResponse(request);
  }
}

function assistant(content: unknown[]) {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

test("Pi Trigger uses the core with populated sanitized conversation", async () => {
  const longResult = `HEAD${"á".repeat(1_000)}TAIL`;
  const messages = toTriggerMessages([
    { role: "system", content: "SYSTEM_PROMPT_CANARY", timestamp: 0 },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect alice@example.com" },
        { type: "image", data: "IMAGE_CANARY", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    assistant([
      { type: "thinking", thinking: "THINKING_CANARY" },
      { type: "text", text: "Inspection is complete." },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/file.ts" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: longResult }],
      isError: false,
      timestamp: 3,
    },
  ]);
  const state = buildTriggerState(62_000, 200_000, 0.2, messages);
  const jev = new StrictTriggerJev();

  assert.equal(await evaluateTrigger(createCoreAsker(jev, new AbortController().signal), state), "compact");
  assert.equal(jev.requests.length, 1);
  const serialized = JSON.stringify(jev.requests[0]?.state);
  assert.match(serialized, /Inspect/);
  assert.match(serialized, /Inspection is complete/);
  assert.doesNotMatch(serialized, /SYSTEM_PROMPT_CANARY|THINKING_CANARY|IMAGE_CANARY|alice@example.com/);
  const recent = (jev.requests[0]?.state as typeof state).recent;
  const excerpt = recent.find((message) => message.role === "assistant")?.tools?.[0]?.excerpt ?? "";
  assert.match(excerpt, /^HEAD/);
  assert.match(excerpt, /TAIL$/);
  assert.ok(new TextEncoder().encode(excerpt).byteLength <= 512);
});

test("Pi Trigger keeps its compactable-history and lifecycle gates", () => {
  const oldTurn = {
    sourceType: "message",
    messages: [{ role: "user" as const, content: "old request", timestamp: 0 }],
  };
  const recentLargeTurn = {
    sourceType: "message",
    messages: [{ role: "user" as const, content: "x".repeat(80_000), timestamp: 0 }],
  };
  assert.equal(hasConservativeCompactableHistory([oldTurn, recentLargeTurn], 20_000, false), true);
  assert.equal(hasConservativeCompactableHistory([recentLargeTurn], 20_000, false), false);
  assert.equal(hasConservativeCompactableHistory([oldTurn, recentLargeTurn], 20_000, true), false);

  const ready = {
    mode: "auto" as const,
    interactive: true,
    idle: true,
    contextTokens: 20_000,
    contextWindow: 100_000,
    minimumContextRatio: 0.2,
    compactableHistory: true,
    hasPendingWork: false,
    cooldownActive: false,
    editorHasText: false,
  };
  assert.equal(localTriggerGatesPass(ready), true);
  assert.equal(localTriggerGatesPass({ ...ready, hasPendingWork: true }), false);
  assert.equal(localTriggerGatesPass({ ...ready, cooldownActive: true }), false);
  assert.equal(localTriggerGatesPass({ ...ready, editorHasText: true }), false);
});

test("Pi applies core decisions only through its existing lifecycle", async () => {
  const notifications: string[] = [];
  let compactCalls = 0;
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    compact: () => { compactCalls += 1; },
  };
  await applyTriggerDecision("compact", "hint", ctx as never);
  await applyTriggerDecision("compact", "auto", ctx as never);
  await applyTriggerDecision("wait", "auto", ctx as never);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /\/compact/);
  assert.equal(compactCalls, 1);
});
