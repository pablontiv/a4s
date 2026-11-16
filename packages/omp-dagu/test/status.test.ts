import assert from "node:assert/strict";
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

type Hook = (event: unknown, ctx: unknown) => void | Promise<void>;

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
  return { registered, flag, state, fire };
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
