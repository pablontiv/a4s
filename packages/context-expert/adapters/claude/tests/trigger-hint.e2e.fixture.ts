import { expect, mock, test, type Plugin } from "claude-code/testing";

const observer: Plugin = {
  name: "hint-acceptance-observer",
  tier: "prepend",
  register(on) {
    on("session.compact", async ($, event, next) => {
      $.ui.log("[acceptance] public session.compact dispatch");
      return next(event);
    });
  },
};

function timingResponse(): string {
  return JSON.stringify({
    model: "jev-test",
    answers: {
      done: {
        type: "choice",
        choice: "finished",
        confidence: 0.9,
        probabilities: { finished: 0.95, not_finished: 0.05, unclear: 0 },
      },
      shape: {
        type: "choice",
        choice: "hands_on",
        confidence: 0.9,
        probabilities: { hands_on: 0.95, coordinating: 0.05, unclear: 0 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  });
}

test(
  "hint displays a compact command without a public compaction dispatch",
  { plugins: [observer] },
  async ($, on) => {
    const logs: string[] = [];
    const toasts: string[] = [];
    let requests = 0;
    mock.env(on, {
      HOME: "/offline-home",
      TYPESAFE_API_KEY: "OFFLINE_HINT_KEY",
    });
    mock.clock(on);
    on("session.usage", () => ({
      value: {
        context: { window: 200_000, tokens: 62_000, percent: 31 },
        rateLimits: [],
      },
    }));
    on("session.messages", () => ({
      value: [
        { role: "user", text: "Inspect the result.", toolUses: [] },
        { role: "assistant", text: "Done.", toolUses: [] },
      ],
    }));
    on("session.model", () => ({ value: "offline-model" }));
    on("http.fetch", () => {
      requests++;
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: timingResponse(),
        },
      };
    });
    on("ui.log", (_host, event) => {
      logs.push(event.text);
      return { value: undefined };
    });
    on("ui.toast", (_host, event) => {
      toasts.push(event.text);
      return { value: undefined };
    });
    on("turn.complete", (_host, event) => ({ text: event.answer, usage: event.usage }));

    const result = await $.turn.complete({
      reason: "answer",
      answer: "CLAUDE_HINT_CANARY_DO_NOT_LOG",
      durationMs: 1,
      isAborted: false,
      turnId: "turn-hint",
    });

    expect(result.text).toBe("CLAUDE_HINT_CANARY_DO_NOT_LOG");
    expect(requests).toBe(1);
    expect(logs.filter((line) => line === "[acceptance] public session.compact dispatch")).toHaveLength(0);
    expect(logs.filter((line) => line.includes("event=compact code=compact_result"))).toHaveLength(0);
    expect(logs.join("\n")).toContain("/compact");
    expect(toasts.filter((line) => line.includes("/compact"))).toHaveLength(1);
    const hintLine = logs.find((line) =>
      line.includes("a4s.claude-context-expert.trigger-decision.v1"),
    );
    expect(hintLine).toBeDefined();
    const hint = JSON.parse(hintLine!.slice("[context-expert] ".length)) as Record<string, unknown>;
    expect(hint).toMatchObject({
      mode: "hint",
      decision: "compact",
      reason: "semantic_score_meets_floor",
      basis: "semantic",
      dispatchOutcome: "not_dispatched",
      uiOutcome: "hinted",
    });
    expect(hint.rearmTokens).toBeUndefined();
    expect(hint.rearmStatus).toBeUndefined();
    expect(logs.join("\n")).not.toContain("CLAUDE_HINT_CANARY_DO_NOT_LOG");
    expect(logs.join("\n")).not.toContain("OFFLINE_HINT_KEY");
  },
);
