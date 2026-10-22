import { resourceDecision } from "../resources.ts";
import { primarySessionDecision } from "./primary.ts";
import { admissionDecision, TriageGuard } from "./guard.ts";
import type { CallDecision, Event } from "./guard.ts";
import { qualityDecision } from "./quality.ts";
import type { QualityContext } from "./quality.ts";
import type { ReviewPolicies } from "@a4s/omp-cross-family-review";

// Structural API keeps this OMP-only package independent of provider imports.
interface ExtensionAPI {
  on(event: "tool_call", handler: (event: Event, ctx?: QualityContext) => CallDecision | Promise<CallDecision>): void;
  on(event: "tool_result", handler: (event: Event) => void): void;
  on(event: "message_end", handler: (event: { message: Record<string, unknown> }) => void): void;
  on(event: "session_start" | "session_switch", handler: () => void): void;
}

export default function triageGuard(pi: ExtensionAPI, readPolicies?: (cwd: string) => ReviewPolicies): void {
  let guard = new TriageGuard();
  pi.on("session_start", () => { guard = new TriageGuard(); });
  pi.on("session_switch", () => { guard = new TriageGuard(); });
  pi.on("tool_call", async (event, ctx) => {
    const transcriptRoot = ctx?.sessionManager?.getSessionDir();
    const admission = admissionDecision(event, transcriptRoot ? { transcriptRoot } : undefined, ctx?.cwd);
    if (admission) return admission;
    return await resourceDecision(event, ctx?.cwd ?? process.cwd())
      ?? (ctx ? await qualityDecision(event, ctx, readPolicies) : undefined)
      ?? (ctx ? await primarySessionDecision(event, ctx) : undefined)
      ?? guard.toolCall(event);
  });
  pi.on("tool_result", event => guard.toolResult(event));
  pi.on("message_end", event => guard.messageEnd(event.message));
}
