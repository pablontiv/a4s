import { readReviewPolicies } from "@a4s/omp-cross-family-review/settings";
import triageGuard from "./index.ts";

export { REVIEW_PROMPT } from "./index.ts";

export default function nativeTriageGuard(pi: Parameters<typeof triageGuard>[0]): void {
  triageGuard(pi, readReviewPolicies);
}
