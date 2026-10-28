import { resourceDecision } from "../resources.ts";
import { admissionDecision } from "./guard.ts";
import { runMutationDecision } from "./run-guard.ts";
import type { CallDecision, Event } from "./guard.ts";
interface GuardContext {
  cwd: string;
  sessionManager: { getSessionDir(): string };
}

// Structural API keeps this OMP-only package independent of provider imports.
interface ExtensionAPI {
  on(event: "tool_call", handler: (event: Event, ctx?: GuardContext) => CallDecision | Promise<CallDecision>): void;
}

export default function triageGuard(pi: ExtensionAPI, decideResources = resourceDecision): void {
  pi.on("tool_call", async (event, ctx) => {
    const transcriptRoot = ctx?.sessionManager?.getSessionDir();
    const admission = admissionDecision(event, transcriptRoot ? { transcriptRoot } : undefined, ctx?.cwd);
    if (admission) return admission;
    const mutation = await runMutationDecision(event, ctx?.cwd);
    if (mutation) return mutation;
    return await decideResources(event, ctx?.cwd ?? process.cwd());
  });
}
