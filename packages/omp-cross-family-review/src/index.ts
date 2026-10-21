// Host-neutral binding and hook API. Native OMP settings are wired statically
// by the runtime entrypoint; the Dagu transcript guard can import this in Node.
import { orderReviewModels } from "./order.ts";
import type { Model, Models, ReviewModels } from "./order.ts";
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


// Bound by the feature gate after reading the implementer's runtime transcript,
// keyed by the task name. Consumed once at dispatch, rather than inferring
// identity from @task. OMP imports each extension graph with its own load tag,
// so the binding caller and this hook run in separate module instances; the
// registry lives on the process global to be shared between them.
const REGISTRY = Symbol.for("@a4s/omp-cross-family-review/quality-implementers");
function sharedRegistry(): Map<string, Model> {
  const existing: unknown = Reflect.get(globalThis, REGISTRY);
  if (existing instanceof Map) return existing;
  const created = new Map<string, Model>();
  Reflect.set(globalThis, REGISTRY, created);
  return created;
}
const qualityImplementers = sharedRegistry();
export function bindQualityImplementer(name: string, model: Model): void {
  qualityImplementers.set(name, model);
}
// OMP keys async spawns by the allocated output id: the task name, `name-N`
// when the name is taken, and `parent.` prefixed inside nested subagents.
function boundName(spawnKey: string): string | undefined {
  const local = spawnKey.slice(spawnKey.lastIndexOf(".") + 1);
  return [spawnKey, local, local.replace(/-\d+$/, "")].find(key => qualityImplementers.has(key));
}
export function registerReviewHook(
  pi: ExtensionAPI,
  readReviewPolicies: (cwd: string) => ReviewPolicies,
): void {
  pi.on("before_subagent_spawn", (event, ctx) => {
    try {
      const policies = readReviewPolicies(ctx.cwd);
      const name = event.spawnKey ? boundName(event.spawnKey) : undefined;
      const implementer = name ? qualityImplementers.get(name) : undefined;
      const policy = Object.hasOwn(policies, event.agent) ? policies[event.agent] : undefined;
      if (!policy) return implementer
        ? { block: true, reason: `CROSS_FAMILY_INDETERMINATE: quality agent ${event.agent} requires a configured policy` }
        : undefined;
      if (implementer && name) {
        qualityImplementers.delete(name);
        return orderReviewModels(event.patterns, policy.fallbackRoles, ctx.models,
          [{ label: "effective implementer", model: implementer }]);
      }
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
