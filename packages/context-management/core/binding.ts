// Part of @a4s/context-management core (host-neutral Jev compaction).
// A neutral seam for mapping consumer transcripts into core messages and
// assembling the resulting keep/truncate/drop decisions into consumer output.

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
