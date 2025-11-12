// Host-neutral hook API. Native OMP settings are wired statically
// by the runtime entrypoint.
import { orderReviewModels } from "./order.ts";
import type { Models, ReviewModels } from "./order.ts";
import type { ReviewPolicies } from "./settings.ts";
export { orderReviewModels } from "./order.ts";
export type { ReviewPolicies } from "./settings.ts";


interface SpawnEvent {
  agent: string;
  patterns: readonly string[];
  spawnKey?: string;
}

interface ExtensionAPI {
  on(
    event: "before_subagent_spawn",
    handler: (event: SpawnEvent, ctx: { cwd: string; models: Models }) => ReviewModels | undefined,
  ): void;
}


export function registerReviewHook(
  pi: ExtensionAPI,
  readReviewPolicies: (cwd: string) => ReviewPolicies,
): void {
  pi.on("before_subagent_spawn", (event, ctx) => {
    try {
      const policies = readReviewPolicies(ctx.cwd);
      const policy = Object.hasOwn(policies, event.agent) ? policies[event.agent] : undefined;
      if (!policy) return undefined;
      const parent = ctx.models.current();
      if (!parent) return {
        block: true,
        reason: "CROSS_FAMILY_INDETERMINATE: parent model unavailable; family cannot be verified",
      };
      const task = policy.excludeTaskFamily ? ctx.models.resolve("@task") : undefined;
      if (policy.excludeTaskFamily && !task) return {
        block: true,
        reason: "CROSS_FAMILY_INDETERMINATE: @task model unavailable; family cannot be verified",
      };
      return orderReviewModels(event.patterns, policy.fallbackRoles, ctx.models,
        [{ model: parent }, ...(task ? [{ label: "@task", model: task }] : [])]);
    } catch (error) {
      return { block: true, reason: `CROSS_FAMILY_CONFIG: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
}
