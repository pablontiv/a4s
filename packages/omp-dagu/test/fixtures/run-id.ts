import { randomBytes } from "node:crypto";

// Dagu control sockets are host-global, even with separate homes and ports.
const execution = randomBytes(8).toString("hex");
let sequence = 0;

/** Allocate once per real run, then reuse the ID for its entire lifecycle. */
export function testRunId(label: string): string {
  return `${label}-${execution}-${++sequence}`;
}
