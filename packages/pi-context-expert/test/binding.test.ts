import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_DETAILS_KEY,
  buildCoreTranscript,
  findPreviousCoreCompaction,
  runPiCoreCompaction,
  stableDigest,
  toNeutralPiMessages,
  type JevClient,
  type JevRequest,
} from "../src/index.ts";

const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: unknown[]) {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function toolResult(id: string, text: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    timestamp: 3,
  };
}

function answering(answer: (id: string) => number): JevClient {
  return {
    async evaluate(request: JevRequest) {
      return {
        model: request.model,
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [
          id,
          { type: "noul", noul: answer(id) },
        ])),
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  };
}

function input() {
  return {
    attemptId: stableDigest({ attempt: "binding" }),
    sourceDigest: stableDigest({ source: "binding" }),
    createdAt: "2026-09-23T12:00:00.000Z",
    firstKeptEntryId: "kept-entry",
    tokensBefore: 20_000,
  };
}

test("Pi conversion sanitizes text and tool inputs and omits thinking and images", () => {
  const messages = toNeutralPiMessages([
    { role: "user", content: [{ type: "text", text: "email alice@example.com" }, { type: "image", data: "secret", mimeType: "image/png" }], timestamp: 1 },
    assistant([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "read password=secret-value" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/Users/alice/private.ts", apiKey: "secret-value" } },
    ]),
    toolResult("call-1", "authorization: Bearer hidden-token"),
  ]);

  assert.equal(messages.length, 3);
  assert.match(messages[0]?.text ?? "", /\[REDACTED:email\]/);
  assert.doesNotMatch(JSON.stringify(messages), /private reasoning|image\/png|secret-value|hidden-token|\/Users\/alice/);
  assert.equal(messages[1]?.toolUses[0]?.tool_use_id, "call-1");
  assert.equal(messages[2]?.toolResults?.[0]?.tool_use_id, "call-1");
});

test("HostBinding applies keep, drop_result, and drop_call to one and multiple Pi tool calls", async () => {
  const long = "result ".repeat(150);
  const host = [
    { role: "user", content: "start", timestamp: 1 },
    assistant([
      { type: "toolCall", id: "keep", name: "read", arguments: { path: "keep.ts" } },
      { type: "toolCall", id: "truncate", name: "read", arguments: { path: "truncate.ts" } },
      { type: "toolCall", id: "drop", name: "read", arguments: { path: "drop.ts" } },
    ]),
    toolResult("keep", long),
    toolResult("truncate", long),
    toolResult("drop", long),
    { role: "user", content: "continue", timestamp: 4 },
  ];
  const { result, output } = await runPiCoreCompaction(
    host,
    input(),
    answering((id) => {
      if (id === "call_t1" || id === "result_t1") return 0.9;
      if (id === "call_t2") return 0.9;
      return 0.1;
    }),
    new AbortController().signal,
    { preserveRecentMessages: 0, truncateHeadChars: 40 },
  );

  assert.deepEqual(result.decisions.map((decision) => decision.action), ["keep", "drop_result", "drop_call"]);
  assert.match(output.summary, /keep\.ts/);
  assert.match(output.summary, /truncate\.ts/);
  assert.match(output.summary, /truncated/);
  assert.doesNotMatch(output.summary, /drop\.ts/);
  assert.equal(output.firstKeptEntryId, "kept-entry");
  assert.equal(output.tokensBefore, 20_000);
  if ("schema" in output.details) assert.fail("expected HostBinding details");
  assert.equal(output.details[CORE_DETAILS_KEY].decisions.length, 3);
});

test("HostBinding preserves boundary and recent tool pairs", async () => {
  const host = [
    assistant([{ type: "toolCall", id: "boundary", name: "read", arguments: { path: "boundary.ts" } }]),
    toolResult("boundary", "boundary result"),
    assistant([{ type: "toolCall", id: "middle", name: "read", arguments: { path: "middle.ts" } }]),
    toolResult("middle", "middle result"),
    assistant([{ type: "toolCall", id: "recent", name: "read", arguments: { path: "recent.ts" } }]),
    toolResult("recent", "recent result"),
  ];
  const { result } = await runPiCoreCompaction(
    host,
    input(),
    answering(() => 0),
    new AbortController().signal,
    { preserveRecentMessages: 2 },
  );

  assert.deepEqual(result.decisions.map((decision) => [decision.action, decision.reason]), [
    ["keep", "pinned"],
    ["drop_call", "call_dropped"],
    ["keep", "pinned"],
  ]);
  assert.ok(result.messages.some((message) => message.toolUses.some((call) => call.tool_use_id === "boundary")));
  assert.ok(result.messages.some((message) => message.toolUses.some((call) => call.tool_use_id === "recent")));
  assert.ok(!result.messages.some((message) => message.toolUses.some((call) => call.tool_use_id === "middle")));
});

test("continuity reads structured upstream, built-in, and historical A4S compactions", () => {
  const messages = [{ role: "user" as const, text: "old", toolUses: [] }];
  const upstream = findPreviousCoreCompaction([{
    type: "compaction",
    summary: "rendered",
    details: { fastJev: { version: 1, messages } },
  }]);
  assert.deepEqual(upstream, { messages, readFiles: [], modifiedFiles: [] });
  const reconstructed = toNeutralPiMessages(buildCoreTranscript(upstream, [
    { role: "user", content: "new", timestamp: 1 },
  ]));
  assert.deepEqual(reconstructed.map((message) => message.text), ["old", "new"]);

  const builtIn = findPreviousCoreCompaction([{
    type: "compaction",
    summary: "native historical summary",
    details: { schema: "a4s.jev-compaction-details/v1" },
  }]);
  assert.equal(builtIn?.summaryText, "native historical summary");
  const transcript = buildCoreTranscript(builtIn, [{ role: "user", content: "new", timestamp: 1 }]);
  assert.equal((transcript[0] as { content: string }).content, "[Previous compaction summary]\n\nnative historical summary");
});
