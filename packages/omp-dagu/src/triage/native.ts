import { readReviewPolicies } from "@a4s/review-routing/settings";
import triageGuard from "./index.ts";

export default function nativeTriageGuard(pi: Parameters<typeof triageGuard>[0]): void {
  triageGuard(pi, readReviewPolicies);
}
