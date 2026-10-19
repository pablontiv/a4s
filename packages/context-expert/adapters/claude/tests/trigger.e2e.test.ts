import { expect, mock, test, type Plugin } from "claude-code/testing";

const WINDOWS = [
  { contextWindow: 128_000, floorTokens: 60_000, ceilingTokens: 66_400 },
  { contextWindow: 200_000, floorTokens: 60_000, ceilingTokens: 70_000 },
  { contextWindow: 272_000, floorTokens: 60_000, ceilingTokens: 73_600 },
  { contextWindow: 872_000, floorTokens: 130_800, ceilingTokens: 174_400 },
] as const;

const observer: Plugin = {
  name: "acceptance-observer",
  tier: "prepend",
  register(on) {
    on("session.compact", async ($, event, next) => {
      $.ui.log("[acceptance] public session.compact dispatch");
      const messages = await $.session.messages();
      return next({ ...event, messages });
    });
  },
};

function transcript() {
  return [
    { role: "user" as const, text: "Inspect the old result.", toolUses: [] },
    {
      role: "assistant" as const,
      text: "Reading.",
      toolUses: [{ tool_use_id: "old-call", tool: "Read", input: { path: "old.txt" } }],
    },
    {
      role: "user" as const,
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: "old-call", text: "old result ".repeat(2_000), isError: false }],
    },
    { role: "assistant" as const, text: "checkpoint 1", toolUses: [] },
    { role: "user" as const, text: "continue 1", toolUses: [] },
    { role: "assistant" as const, text: "checkpoint 2", toolUses: [] },
    { role: "user" as const, text: "continue 2", toolUses: [] },
    { role: "assistant" as const, text: "checkpoint 3", toolUses: [] },
    { role: "user" as const, text: "continue 3", toolUses: [] },
    { role: "assistant" as const, text: "finished", toolUses: [] },
  ];
}

for (const matrix of WINDOWS) {
  test(
    `real plugin dispatcher compacts once at ${matrix.contextWindow}`,
    { plugins: [observer] },
    async ($, on) => {
      const logs: string[] = [];
      const requests: Array<{
        state: { context?: string; history?: unknown[] };
        questions: Record<string, { type: string }>;
      }> = [];
      const messages = transcript();

      mock.env(on, {
        HOME: "/offline-home",
        TYPESAFE_API_KEY: "OFFLINE_TEST_KEY",
      });
      on("session.usage", () => ({
        value: {
          context: {
            window: matrix.contextWindow,
            tokens: matrix.ceilingTokens,
            percent: matrix.ceilingTokens / matrix.contextWindow * 100,
          },
          rateLimits: [],
        },
      }));
      on("session.messages", () => ({ value: messages }));
      on("session.model", () => ({ value: "offline-model" }));
      on("http.fetch", (_host, event) => {
        const body = JSON.parse(event.init?.body ?? "{}") as {
          state: { context?: string; history?: unknown[] };
          questions: Record<string, { type: string }>;
        };
        requests.push(body);
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { noul: 0.05 }]),
        );
        return {
          value: {
            status: 200,
            ok: true,
            headers: {},
            text: JSON.stringify({ model: "jev-test", answers }),
          },
        };
      });
      on("ui.log", (_host, event) => {
        logs.push(event.text);
        return { value: undefined };
      });
      on("ui.toast", () => ({ value: undefined }));
      on("turn.complete", (_host, event) => ({ text: event.answer, usage: event.usage }));

      const result = await $.turn.complete({
        reason: "answer",
        answer: "CLAUDE_CONVERSATION_CANARY_DO_NOT_LOG",
        durationMs: 1,
        isAborted: false,
        turnId: `turn-${matrix.contextWindow}`,
      });

      expect(result.text).toBe("CLAUDE_CONVERSATION_CANARY_DO_NOT_LOG");
      expect(logs.filter((line) => line === "[acceptance] public session.compact dispatch")).toHaveLength(1);
      expect(logs.filter((line) => line.includes("event=compact code=compact_result outcome=applied"))).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0]!.questions)).toEqual(["call_t1", "result_t1"]);
      expect(requests[0]!.state.context).toContain("conversation is being compacted");
      expect(requests[0]!.state.history).toBeDefined();

      const triggerLine = logs.find((line) => line.includes("a4s.claude-context-expert.trigger-decision.v1"));
      expect(triggerLine).toBeDefined();
      const trigger = JSON.parse(triggerLine!.slice("[context-expert] ".length)) as Record<string, unknown>;
      expect(trigger).toMatchObject({
        schema: "a4s.claude-context-expert.trigger-decision/v1",
        adapter: "claude",
        effectiveFloorTokens: matrix.floorTokens,
        effectiveCeilingTokens: matrix.ceilingTokens,
        preContextTokens: matrix.ceilingTokens,
        mode: "auto",
        decision: "compact",
        reason: "adaptive_ceiling",
        basis: "ceiling",
        dispatchOutcome: "completed",
      });
      expect(logs.join("\n")).not.toContain("CLAUDE_CONVERSATION_CANARY_DO_NOT_LOG");
      expect(logs.join("\n")).not.toContain("OFFLINE_TEST_KEY");
    },
  );
}
