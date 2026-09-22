import assert from "node:assert/strict";
import test from "node:test";
import { classifySafeCompactionNotification } from "../scripts/compaction-diagnostic.ts";

const PREFIX = "Rule compiler compaction skipped: ";
const SUFFIX = ". Compaction was cancelled; native fallback is disabled.";

function notification(description: string): unknown {
  return {
    type: "extension_ui_request",
    id: "e2e-safe-diagnostic",
    method: "notify",
    notifyType: "warning",
    message: `${PREFIX}${description}${SUFFIX}`,
  };
}

test("classifies only safeNotify's bounded compaction cancellation categories", () => {
  assert.equal(classifySafeCompactionNotification(notification("Jev is unavailable (missing TYPESAFE_API_KEY)")), "missing_key");
  assert.equal(classifySafeCompactionNotification(notification("the bounded analysis timed out")), "timeout");
  assert.equal(classifySafeCompactionNotification(notification("a model response failed strict validation")), "validation");
  assert.equal(classifySafeCompactionNotification(notification("the sanitized state or summary exceeded configured bounds")), "oversized_state");
  assert.equal(classifySafeCompactionNotification(notification("the Jev request failed")), "api_failure");
  assert.equal(classifySafeCompactionNotification(notification("the analysis was aborted")), "aborted");
  assert.equal(classifySafeCompactionNotification(notification("an internal bounded failure occurred")), "internal_failure");
});

test("rejects arbitrary UI request payloads and message text", () => {
  const exactMessage = `${PREFIX}the Jev request failed${SUFFIX}`;
  const rejected: unknown[] = [
    null,
    "extension_ui_request",
    { type: "extension_ui_request", id: "e2e-safe-diagnostic", method: "notify", notifyType: "warning", message: "provider error body" },
    { type: "extension_ui_request", id: "e2e-safe-diagnostic", method: "notify", notifyType: "info", message: exactMessage },
    { type: "extension_ui_request", id: "e2e-safe-diagnostic", method: "setStatus", notifyType: "warning", message: exactMessage },
    { type: "message_update", message: exactMessage },
    { type: "extension_ui_request", id: "e2e-safe-diagnostic", method: "notify", notifyType: "warning", message: `${exactMessage} credential` },
    { type: "extension_ui_request", id: "e2e-safe-diagnostic", method: "notify", notifyType: "warning", message: exactMessage, text: "session transcript" },
  ];

  for (const event of rejected) {
    assert.equal(classifySafeCompactionNotification(event), undefined);
  }
});
