import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeEvidence } from "../src/role-runtime.ts";
import { planningReviewer, type TranscriptRow } from "../src/transcript-identity.ts";

function transcript(): TranscriptRow[] {
  return [
    { type: "session", id: "reviewer-session-648" },
    { type: "session_init", agent: "plan-reviewer", resolvedModel: "xai-oauth/grok-4.7" } as TranscriptRow,
    { type: "message", id: "failed-attempt", message: { role: "assistant", provider: "xai-oauth", model: "grok-4.7", stopReason: "error", errorMessage: "provider unavailable" } },
    { type: "model_change", id: "fallback-1", timestamp: "2026-10-23T22:38:42Z", model: "openai-codex/gpt-6.1-sol", resolvedModelIsFallback: true },
    { type: "message", id: "assistant-final", message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", stopReason: "stop" } },
  ];
}

test("accepted review records the final assistant model rather than session_init.resolvedModel", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-reviewer-"));
  const path = join(root, "reviewer.jsonl");
  try {
    const rows = transcript();
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const reviewer = planningReviewer(rows);
    assert.deepEqual(reviewer, {
      provider: "openai-codex", model: "gpt-6.1-sol", session: "reviewer-session-648", agent: "plan-reviewer",
      fallbacks: [{ event: "fallback-1", timestamp: "2026-10-23T22:38:42Z", model: "openai-codex/gpt-6.1-sol", resolvedModelIsFallback: true }],
    });
    const native = nativeEvidence(path, { agent: "plan-reviewer" });
    assert.equal(native.provider, reviewer.provider);
    assert.equal(native.model, reviewer.model);
    assert.equal(native.session, reviewer.session);
    assert.deepEqual(native.fallbacks, reviewer.fallbacks);
    assert.equal(native.attempts.length, 2);
    assert.equal(JSON.parse(readFileSync(path, "utf8").split("\n")[1]!).resolvedModel, "xai-oauth/grok-4.7");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reviewer identity fails closed for missing or ambiguous native identity", () => {
  const rows = transcript();
  for (const invalid of [
    rows.filter(row => row.type !== "session"),
    [...rows, { type: "session", id: "foreign-session" }],
    rows.filter(row => row.type !== "session_init"),
    rows.filter(row => row.id !== "assistant-final"),
    rows.map(row => row.id === "assistant-final" ? { ...row, message: { ...row.message, provider: "" } } : row),
  ]) assert.throws(() => planningReviewer(invalid), /Missing native session\/effective assistant identity/);
});
