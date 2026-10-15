// Why: no package-specific type import here. Pi and OMP expose extension
// APIs under different package names; this hook uses OMP's models facade.
import { orderReviewModels } from "./order.ts";
import type { Models, ReviewModels } from "./order.ts";

interface SpawnEvent {
  agent: string;
  patterns: readonly string[];
}

interface ExtensionAPI {
  on(
    event: "before_subagent_spawn",
    handler: (event: SpawnEvent, ctx: { models: Models }) => ReviewModels | undefined,
  ): void;
}

const REVIEW_AGENTS: Record<string, true> = {
  reviewer: true,
  "triage-reviewer": true,
  "security-reviewer": true,
};
const FALLBACK_ROLES = ["@task", "@slow", "@default"] as const;

export default function crossFamilyReview(pi: ExtensionAPI): void {
  pi.on("before_subagent_spawn", (event, ctx) => {
    if (!Object.hasOwn(REVIEW_AGENTS, event.agent)) return undefined;
    return orderReviewModels(event.patterns, FALLBACK_ROLES, ctx.models);
  });
}
