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

interface ReviewPolicy {
  fallbackRoles: readonly string[];
  excludeTaskFamily: boolean;
}

const REVIEW_POLICIES: Record<string, ReviewPolicy> = {
  reviewer: {
    fallbackRoles: ["@slow", "@default"],
    excludeTaskFamily: true,
  },
  "triage-reviewer": {
    fallbackRoles: ["@task", "@slow", "@default"],
    excludeTaskFamily: false,
  },
  "plan-reviewer": {
    fallbackRoles: ["@task", "@slow", "@default"],
    excludeTaskFamily: false,
  },
  "security-reviewer": {
    fallbackRoles: ["@slow", "@default"],
    excludeTaskFamily: true,
  },
};

export default function crossFamilyReview(pi: ExtensionAPI): void {
  pi.on("before_subagent_spawn", (event, ctx) => {
    if (!Object.hasOwn(REVIEW_POLICIES, event.agent)) return undefined;
    const parent = ctx.models.current();
    if (!parent) return undefined;
    const policy = REVIEW_POLICIES[event.agent]!;
    const task = policy.excludeTaskFamily
      ? ctx.models.resolve("@task")
      : undefined;
    return orderReviewModels(
      event.patterns,
      policy.fallbackRoles,
      ctx.models,
      [
        { model: parent },
        ...(task ? [{ label: "@task", model: task }] : []),
      ],
    );
  });
}
