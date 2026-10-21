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
}

const REVIEW_POLICIES: Record<string, ReviewPolicy> = {
  reviewer: {
    fallbackRoles: ["@slow", "@default"],
    excludeTaskFamily: true,
  },
  qa: {
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
export default function crossFamilyReview(pi: ExtensionAPI): void {
  pi.on("before_subagent_spawn", (event, ctx) => {
    if (!Object.hasOwn(REVIEW_POLICIES, event.agent)) return undefined;
    const name = event.spawnKey ? boundName(event.spawnKey) : undefined;
    const implementer = name ? qualityImplementers.get(name) : undefined;
    if (implementer && name) {
      qualityImplementers.delete(name);
      return orderReviewModels(event.patterns, ["@slow", "@default", "@task"], ctx.models,
        [{ label: "effective implementer", model: implementer }]);
    }
    const parent = ctx.models.current();
    if (!parent) return {
      block: true,
      reason: "CROSS_FAMILY_INDETERMINATE: parent model unresolved; parent family cannot be verified",
    };
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
