import { registerReviewHook } from "./index.ts";
import { readReviewPolicies } from "./settings.ts";

export default function crossFamilyReview(pi: Parameters<typeof registerReviewHook>[0]): void {
  registerReviewHook(pi, readReviewPolicies);
}
