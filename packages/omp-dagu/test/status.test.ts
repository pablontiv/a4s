import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/status/index.ts";

interface Tool {
  name: string;
  loadMode: string;
  execute(
    toolCallId: string,
    params: Record<string, never>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: {
      agent: { kind: "main" | "sub" };
      sessionManager: { getSessionId(): string };
    },
  ): Promise<{ content: { type: "text"; text: string }[] }>;
}

test("dagu_session_id returns the caller main session id and rejects subagents", async () => {
  let registered: Tool | undefined;
  extension({
    registerTool(tool: Tool) { registered = tool; },
    on() {},
    sendMessage() {},
  } as never);
  assert.equal(registered?.name, "dagu_session_id");
  assert.equal(registered?.loadMode, "essential");
  assert.ok(registered);
  const main = {
    agent: { kind: "main" as const },
    sessionManager: { getSessionId: () => "session-main" },
  };
  const result = await registered.execute("call", {}, undefined, undefined, main);
  assert.equal(result.content[0]?.text, "session-main");

  const sub = {
    agent: { kind: "sub" as const },
    sessionManager: { getSessionId: () => "session-sub" },
  };
  await assert.rejects(
    registered.execute("call", {}, undefined, undefined, sub),
    /dagu_session_id rejected: agent.kind=sub/,
  );
});
