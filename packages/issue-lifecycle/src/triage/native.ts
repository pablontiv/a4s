import triageGuard from "./index.ts";

export default function nativeTriageGuard(pi: Parameters<typeof triageGuard>[0]): void {
  triageGuard(pi);
}
