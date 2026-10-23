import { resourceDecision } from "../resources.ts";
import { admissionDecision } from "./guard.ts";
import type { CallDecision, Event } from "./guard.ts";
interface GuardContext {
  cwd: string;
  sessionManager: { getSessionDir(): string };
}

// Structural API keeps this OMP-only package independent of provider imports.
interface ExtensionAPI {
  on(event: "tool_call", handler: (event: Event, ctx?: GuardContext) => CallDecision | Promise<CallDecision>): void;
}

export default function triageGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const transcriptRoot = ctx?.sessionManager?.getSessionDir();
    const admission = admissionDecision(event, transcriptRoot ? { transcriptRoot } : undefined, ctx?.cwd);
    if (admission) return admission;
    return await resourceDecision(event, ctx?.cwd ?? process.cwd());
  });
}
