// Why: no package-specific type import here. Pi and OMP expose extension
// APIs under different package names; this hook uses OMP's models facade.
import { orderReviewModels } from "./order.ts";
import type { Model, Models, ReviewModels } from "./order.ts";
export { orderReviewModels } from "./order.ts";

interface SpawnEvent {
  agent: string;
  patterns: readonly string[];
  spawnKey?: string;
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
  strict?: boolean;
}

const REVIEW_POLICIES: Record<string, ReviewPolicy> = {
  reviewer: {
    fallbackRoles: ["@slow", "@default"],
    excludeTaskFamily: true,
    strict: true,
  },
  qa: {
    fallbackRoles: ["@slow", "@default"],
    excludeTaskFamily: true,
    strict: true,
  },
  "triage-reviewer": {
    fallbackRoles: ["@task", "@slow", "@default"],
    excludeTaskFamily: false,
  },
  "security-reviewer": {
    fallbackRoles: ["@slow", "@default"],
    excludeTaskFamily: true,
  },
};

// Bound by the feature gate after reading the implementer's runtime transcript.
// Consumed once at dispatch, rather than inferring identity from @task.
const qualityImplementers = new Map<string, Model>();
export function bindQualityImplementer(spawnKey: string, model: Model): void {
  qualityImplementers.set(spawnKey, model);
}
export default function crossFamilyReview(pi: ExtensionAPI): void {
  pi.on("before_subagent_spawn", (event, ctx) => {
    if (!Object.hasOwn(REVIEW_POLICIES, event.agent)) return undefined;
    const implementer = event.spawnKey ? qualityImplementers.get(event.spawnKey) : undefined;
    if (implementer && event.spawnKey) {
      qualityImplementers.delete(event.spawnKey);
      return orderReviewModels(event.patterns, ["@slow", "@default", "@task"], ctx.models,
        [{ label: "effective implementer", model: implementer }], true);
    }
    const parent = ctx.models.current();
    if (!parent) return REVIEW_POLICIES[event.agent]?.strict
      ? { block: true, reason: "CROSS_FAMILY_INDETERMINATE: parent model unavailable" }
      : undefined;
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
      policy.strict,
    );
  });
}
