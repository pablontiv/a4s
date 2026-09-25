import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTriggerDecision,
  evaluateTrigger,
  hasConservativeCompactableHistory,
  type TriggerInput,
} from "../src/trigger.ts";
import type { JevClient, JevRequest } from "../src/types.ts";
import { validJevResponse } from "./fixtures.ts";

class SuggestingJev implements JevClient {
  calls = 0;
  requests: JevRequest[] = [];

  async evaluate(request: JevRequest): Promise<unknown> {
    this.calls += 1;
    this.requests.push(request);
    return validJevResponse(request, (_id, question) =>
      question.type === "choice"
        ? {
            type: "choice",
            choice: "compact",
            probabilities: { compact: 1, wait: 0 },
            confidence: 1,
          }
        : undefined,
    );
  }
}

function readyInput(jevClient: JevClient): TriggerInput {
  return {
    mode: "hint",
    interactive: true,
    idle: true,
    contextTokens: 200_000,
    contextWindow: 872_000,
    minimumContextRatio: 0.2,
    compactableHistory: true,
    hasPendingWork: false,
    cooldownActive: false,
    editorHasText: false,
    credentialAvailable: true,
    autoAcknowledged: false,
    jevClient,
    signal: new AbortController().signal,
  };
}

test("trigger only compacts after all local gates and persisted acknowledgement", async () => {
  const decision = await evaluateTrigger({
    ...readyInput(new SuggestingJev()),
    mode: "auto",
    autoAcknowledged: true,
  });
  assert.equal(decision.action, "compact");
});

test("auto without acknowledgement, with pending work, cooldown, editor text, or compactable history is inert", async () => {
  const blockedInputs = [
    { mode: "auto" as const, autoAcknowledged: false },
    { mode: "auto" as const, autoAcknowledged: true, hasPendingWork: true },
    { mode: "auto" as const, autoAcknowledged: true, cooldownActive: true },
    { mode: "auto" as const, autoAcknowledged: true, editorHasText: true },
    { mode: "auto" as const, autoAcknowledged: true, compactableHistory: false },
  ];
  for (const blocked of blockedInputs) {
    const jev = new SuggestingJev();
    const decision = await evaluateTrigger({ ...readyInput(jev), ...blocked });
    assert.equal(decision.action, "none");
    assert.equal(jev.calls, 0, "local gates must run before Jev");
  }
});

test("trigger recomputes the percentage gate from the active model context window", async () => {
  const largeWindowJev = new SuggestingJev();
  assert.deepEqual(
    await evaluateTrigger({
      ...readyInput(largeWindowJev),
      contextTokens: 40_000,
      contextWindow: 872_000,
    }),
    { action: "none" },
  );
  assert.equal(largeWindowJev.calls, 0);

  const smallWindowJev = new SuggestingJev();
  assert.deepEqual(
    await evaluateTrigger({
      ...readyInput(smallWindowJev),
      contextTokens: 40_000,
      contextWindow: 128_000,
    }),
    { action: "hint", reason: "Jev recommends compaction" },
  );
  assert.equal(smallWindowJev.calls, 1);
});

test("conservative readiness requires an older turn beyond Pi's retained tail", () => {
  const oldTurn = {
    sourceType: "message",
    messages: [{ role: "user" as const, content: "old request", timestamp: 0 }],
  };
  const recentLargeTurn = {
    sourceType: "message",
    messages: [{ role: "user" as const, content: "x".repeat(80_000), timestamp: 0 }],
  };

  assert.equal(
    hasConservativeCompactableHistory([oldTurn, recentLargeTurn], 20_000, false),
    true,
  );
  assert.equal(
    hasConservativeCompactableHistory([recentLargeTurn], 20_000, false),
    false,
    "one large user turn is not enough for Pi to summarize history",
  );
  assert.equal(
    hasConservativeCompactableHistory([oldTurn, recentLargeTurn], 20_000, true),
    false,
    "a compaction at the branch tip is already compacted",
  );
});

test("off never queries Jev and the request contains no chunk text or credentials", async () => {
  const offJev = new SuggestingJev();
  assert.deepEqual(
    await evaluateTrigger({ ...readyInput(offJev), mode: "off" }),
    { action: "none" },
  );
  assert.equal(offJev.calls, 0);

  const jev = new SuggestingJev();
  assert.deepEqual(
    await evaluateTrigger({ ...readyInput(jev), mode: "hint" }),
    { action: "hint", reason: "Jev recommends compaction" },
  );
  assert.equal(jev.calls, 1);
  const serialized = JSON.stringify(jev.requests[0]);
  assert.doesNotMatch(serialized, /chunk-secret|credential-secret|password/i);
  assert.doesNotMatch(serialized, /Bearer|TYPESAFE_API_KEY/);
  assert.match(serialized, /contextWindow/);
  assert.match(serialized, /contextRatio/);
  assert.doesNotMatch(serialized, /minimumContextTokens/);
});

test("applyTriggerDecision delegates compaction only through ctx.compact", async () => {
  const notifications: string[] = [];
  let compactCalls = 0;
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    compact: () => { compactCalls += 1; },
  };
  await applyTriggerDecision({ action: "hint", reason: "Jev recommends compaction" }, ctx as never);
  await applyTriggerDecision({ action: "compact" }, ctx as never);
  assert.deepEqual(notifications, ["Compaction suggested: Jev recommends compaction"]);
  assert.equal(compactCalls, 1);
});
