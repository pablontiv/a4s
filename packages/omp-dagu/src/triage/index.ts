import { primarySessionDecision } from "./primary.ts";
import type { SessionContext } from "./primary.ts";
import { TriageGuard } from "./guard.ts";
import type { CallDecision, Event } from "./guard.ts";
export { REVIEW_PROMPT } from "./guard.ts";

// Structural API keeps this OMP-only package independent of provider imports.
interface ExtensionAPI {
  on(event: "tool_call", handler: (event: Event, ctx?: SessionContext) => CallDecision | Promise<CallDecision>): void;
  on(event: "tool_result", handler: (event: Event) => void): void;
  on(event: "message_end", handler: (event: { message: Record<string, unknown> }) => void): void;
  on(event: "session_start" | "session_switch", handler: () => void): void;
}

export default function triageGuard(pi: ExtensionAPI): void {
  let guard = new TriageGuard();
  pi.on("session_start", () => { guard = new TriageGuard(); });
  pi.on("session_switch", () => { guard = new TriageGuard(); });
  pi.on("tool_call", (event, ctx) => ctx
    ? primarySessionDecision(event, ctx).then(decision => decision ?? guard.toolCall(event))
    : guard.toolCall(event));
  pi.on("tool_result", event => guard.toolResult(event));
  pi.on("message_end", event => guard.messageEnd(event.message));
}
