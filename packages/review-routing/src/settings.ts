import { lookup, register } from "@oh-my-pi/pi-coding-agent/config/registry";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";

export interface ReviewPolicy {
  fallbackRoles: string[];
  excludeTaskFamily: boolean;
}
export type ReviewPolicies = Record<string, ReviewPolicy>;

function validatePolicies(raw: unknown): void {
  // Native load validation also visits unconfigured settings.
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("crossFamilyReview.policies must be a record");
  }
  for (const [name, value] of Object.entries(raw)) {
    const policy = value as Partial<ReviewPolicy> | null;
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).length !== 2 || !Object.hasOwn(policy, "fallbackRoles") ||
      !Object.hasOwn(policy, "excludeTaskFamily") || !Array.isArray(policy.fallbackRoles) ||
      policy.fallbackRoles.some(role => typeof role !== "string") ||
      typeof policy.excludeTaskFamily !== "boolean") {
      throw new Error(`crossFamilyReview.policies: invalid policy ${JSON.stringify(name)}; expected fallbackRoles:string[] and excludeTaskFamily:boolean`);
    }
  }
}

// Extension graphs are rebound/reloaded independently in OMP's shared registry.
const policies = lookup("crossFamilyReview.policies") ?? register({
  id: "crossFamilyReview.policies",
  type: "record",
  default: {} as ReviewPolicies,
  validate: validatePolicies,
});

export function readReviewPolicies(cwd: string): ReviewPolicies {
  const scope = findScopedSettings(cwd);
  if (!scope) throw new Error("crossFamilyReview.policies: active session settings unavailable");
  // Late registration does not retrovalidate initial project/overlay values.
  // Check the raw effective value too: get() defaults malformed record types.
  policies.assertWritable(scope.rawValue(policies) ?? {});
  const effective = policies.get(scope);
  policies.assertWritable(effective);
  return effective as ReviewPolicies;
}
