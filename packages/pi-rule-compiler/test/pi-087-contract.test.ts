import assert from "node:assert/strict";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createPi087Fake } from "./fixtures.ts";

test("agent_settled defers ctx.compact and enters the existing compact hook once", async () => {
  assert.equal(VERSION, "0.87.0", "the lifecycle contract requires Pi 0.87.0");
  const runtime = createPi087Fake();
  runtime.pi.on("session_before_compact", () => {
    runtime.beforeCompactCalls += 1;
    return { cancel: true };
  });
  runtime.pi.on("agent_settled", (_event, ctx) => {
    ctx.compact();
  });

  await runtime.emit("agent_settled");

  assert.equal(runtime.compactCalls, 1);
  assert.equal(runtime.beforeCompactCalls, 1);
  assert.equal(runtime.compactCallsWhileSettling, 0, "agent_settled work must not re-enter the settled handler");
  assert.equal(runtime.nativeFallbackCalls, 0, "a cancelled custom compaction must not fall back to native compaction");
});

test("a failed context projection leaves Pi's supplied system context unchanged", async () => {
  assert.equal(VERSION, "0.87.0", "context_with_system is a Pi 0.87.0 lifecycle hook");
  const runtime = createPi087Fake();
  runtime.pi.on("context_with_system", () => {
    throw new Error("projection failed");
  });

  const supplied = [{ role: "system", content: "normal" }];
  const projected = await runtime.emit("context_with_system", { messages: supplied });

  assert.deepEqual(projected, { messages: supplied });
  assert.deepEqual(supplied, [{ role: "system", content: "normal" }]);
});
