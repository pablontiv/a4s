/**
 * Privacy boundary for the headless E2E runner. Only these complete notify
 * requests are emitted by safeNotify() for a cancelled compiler compaction.
 * The runner retains the category, never the UI request or its message.
 */
export const SAFE_COMPACTION_DIAGNOSTIC_CATEGORIES = [
  "missing_key",
  "timeout",
  "validation",
  "oversized_state",
  "api_failure",
  "aborted",
  "internal_failure",
] as const;

export type SafeCompactionDiagnosticCategory =
  (typeof SAFE_COMPACTION_DIAGNOSTIC_CATEGORIES)[number];

const SAFE_NOTIFICATION_MESSAGES: Readonly<Record<string, SafeCompactionDiagnosticCategory>> = {
  "Rule compiler compaction skipped: Jev is unavailable (missing TYPESAFE_API_KEY). Compaction was cancelled; native fallback is disabled.": "missing_key",
  "Rule compiler compaction skipped: the bounded analysis timed out. Compaction was cancelled; native fallback is disabled.": "timeout",
  "Rule compiler compaction skipped: a model response failed strict validation. Compaction was cancelled; native fallback is disabled.": "validation",
  "Rule compiler compaction skipped: the sanitized state or summary exceeded configured bounds. Compaction was cancelled; native fallback is disabled.": "oversized_state",
  "Rule compiler compaction skipped: the Jev request failed. Compaction was cancelled; native fallback is disabled.": "api_failure",
  "Rule compiler compaction skipped: the analysis was aborted. Compaction was cancelled; native fallback is disabled.": "aborted",
  "Rule compiler compaction skipped: an internal bounded failure occurred. Compaction was cancelled; native fallback is disabled.": "internal_failure",
};

/**
 * Parses the sole safe notification grammar accepted by the E2E diagnostic
 * channel. Extra fields are rejected so arbitrary extension UI payloads cannot
 * cross this boundary.
 */
export function classifySafeCompactionNotification(value: unknown): SafeCompactionDiagnosticCategory | undefined {
  if (!isExactNotifyRequest(value)) return undefined;
  return SAFE_NOTIFICATION_MESSAGES[value.message];
}

function isExactNotifyRequest(value: unknown): value is {
  type: "extension_ui_request";
  id: string;
  method: "notify";
  notifyType: "warning";
  message: string;
} {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 5 || !keys.every((key) => key === "type" || key === "id" || key === "method" || key === "notifyType" || key === "message")) {
    return false;
  }
  return (
    value.type === "extension_ui_request" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.method === "notify" &&
    value.notifyType === "warning" &&
    typeof value.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
