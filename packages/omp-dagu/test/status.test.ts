import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import extension from "../src/status/index.ts";

interface Tool {
  name: string;
  loadMode: string;
  defaultInactive?: boolean;
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

type Hook = (event: unknown, ctx: unknown) => unknown;

function load(role: string | undefined, active: string[]) {
  let registered: Tool | undefined;
  let flag: string | undefined;
  const hooks = new Map<string, Hook>();
  const state = { active };
  extension({
    registerTool(tool: Tool) { registered = tool; },
    registerFlag(name: string, options: { type: string }) {
      flag = name;
      assert.equal(options.type, "string");
    },
    getFlag: (name: string) => (name === "a4s-role" ? role : undefined),
    getActiveTools: () => state.active,
    async setActiveTools(names: string[]) { state.active = names; },
    on(event: string, handler: Hook) { hooks.set(event, handler); },
    sendMessage() {},
  } as never);
  const fire = async (event: "session_start" | "session_switch") => {
    const handler = hooks.get(event);
    assert.ok(handler);
    // A headless subagent returns before observe(), avoiding Dagu and git calls.
    await handler({}, { hasUI: false, agent: { kind: "sub" } });
  };
  return { registered, flag, state, fire, hooks };
}

for (const role of ["coordinator", "supervisor", "researcher", undefined]) {
  for (const listed of [false, true]) {
    test(`${role ?? "no role"} ${listed ? "with" : "without"} pre-listed dagu_session_id`, async () => {
      const initial = listed ? ["read", "dagu_session_id", "bash"] : ["read", "bash"];
      const { state, fire } = load(role, [...initial]);
      for (const event of ["session_start", "session_switch"] as const) {
        state.active = [...initial];
        await fire(event);
        assert.deepEqual(
          state.active,
          role === "coordinator" || role === "supervisor" ? ["read", "bash", "dagu_session_id"] : ["read", "bash"],
          event,
        );
      }
    });
  }
}

test("an unknown role removes a pre-listed dagu_session_id before reporting an error", async () => {
  const { state, fire } = load("admin", []);
  for (const event of ["session_start", "session_switch"] as const) {
    state.active = ["read", "dagu_session_id", "bash"];
    await assert.rejects(
      fire(event),
      /unknown --a4s-role "admin"; expected supervisor \| coordinator \| researcher/,
    );
    assert.deepEqual(state.active, ["read", "bash"], event);
  }
});

test("dagu_session_id returns the caller main session id and rejects subagents", async () => {
  const { registered, flag } = load(undefined, []);
  assert.equal(flag, "a4s-role");
  assert.equal(registered?.name, "dagu_session_id");
  assert.equal(registered?.loadMode, "essential");
  assert.equal(registered?.defaultInactive, true);
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

test("each role card matches the README and appends to every received request policy", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(readme.split("\n## Communication protocol\n").length, 2);
  const protocol = readme.split("\n## Communication protocol\n")[1]!.split("\n## ")[0]!;
  for (const role of ["supervisor", "coordinator", "researcher"]) {
    const card = protocol.split(`#### ${role}\n\n\`\`\`text\n`)[1]?.split("\n```")[0];
    assert.ok(card, `${role} card is documented inside Communication protocol`);
    const { hooks } = load(role, []);
    const handler = hooks.get("before_agent_start");
    assert.ok(handler);
    for (const policy of [["base policy", "previous extension policy"], ["policy after compaction"]]) {
      const systemPrompt = Object.freeze([...policy]);
      assert.deepEqual(await handler({ reason: "prompt", systemPrompt }, {}), {
        systemPrompt: [...policy, card],
      });
      assert.deepEqual(systemPrompt, policy, "received policy is not mutated");
    }
    if (role === "researcher") {
      const rule = card.split("\n").find(line => line.startsWith("Role rule:"));
      assert.ok(rule);
      assert.ok(protocol.split("### Launch prompts\n")[1]?.includes(rule), "researcher launch includes the standing user request verbatim");
    }
  }
});

for (const role of [undefined, "", "admin", "constructor", "toString", "__proto__"]) {
  test(`${role ?? "no role"} does not receive a protocol card`, async () => {
    const { hooks } = load(role, []);
    const handler = hooks.get("before_agent_start");
    assert.ok(handler);
    const systemPrompt = Object.freeze(["existing policy"]);
    assert.equal(await handler({ reason: "prompt", systemPrompt }, {}), undefined);
    assert.deepEqual(systemPrompt, ["existing policy"]);
  });
}
