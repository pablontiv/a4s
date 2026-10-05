// Part of @a4s/context-expert core (host-neutral Jev compaction).
// The HostBinding contract: the single seam both host adapters implement so
// ONE core serves both the Claude mod and the Pi extension — the same pattern
// the synagent adapters use (host-neutral core + per-host adapter).
//
// The two hosts differ in how a compaction is RETURNED:
//   - Claude's `session.compact` hook returns the message array itself
//     (keep = engine message with its handle; truncate = rebuilt message
//     without a handle; drop = omitted). HostResult = { messages }.
//   - Pi's `session_before_compact` returns a summary string + a kept
//     boundary. HostResult = a Pi-shaped summary payload.
// The contract abstracts both the INPUT mapping (toNeutral) and the OUTPUT
// assembly (assemble), leaving the deterministic keep/truncate/drop decision
// in the shared core.

import { compact } from './compact.js';
import type { CompactOptions, CompactResult, JevAsker, Message } from './types.js';

/**
 * What a host adapter must provide to drive the shared compaction core.
 *
 * `HostMsg` is the host's transcript message type; `HostResult` is the shape
 * the host's compaction hook is expected to return.
 */
export interface HostBinding<HostMsg, HostResult> {
  /** Map the host transcript onto the neutral messages the core compacts. */
  toNeutral(host: readonly HostMsg[]): readonly Message[];
  /** Assemble the core's decisions into the host hook's return shape. */
  assemble(host: readonly HostMsg[], result: CompactResult): HostResult;
}

/**
 * Runs the shared core over a host transcript through its binding. The core
 * (and therefore the Jev classification and keep/truncate/drop logic) is
 * identical across hosts; only `toNeutral`/`assemble` are host-specific.
 */
export async function runCompaction<HostMsg, HostResult>(
  host: readonly HostMsg[],
  binding: HostBinding<HostMsg, HostResult>,
  asker: JevAsker,
  options?: CompactOptions,
): Promise<{ result: CompactResult; output: HostResult }> {
  const result = await compact(binding.toNeutral(host), asker, options);
  return { result, output: binding.assemble(host, result) };
}
