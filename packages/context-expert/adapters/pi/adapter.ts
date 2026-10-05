// Pi adapter for @a4s/context-expert — CONTRACT-PARITY SHIM (PoC scope).
//
// Purpose: prove that the SAME host-neutral core (../../core) drives Pi, whose
// compaction model differs from Claude's. Claude's `session.compact` returns a
// message array; Pi's `session_before_compact` returns a SUMMARY STRING plus a
// kept boundary. This file implements the HostBinding `assemble` for Pi's
// string-summary shape over the identical core decisions.
//
// It deliberately does NOT register a live Pi extension or import the Pi
// runtime: a faithful port (mapping Pi's real entry types and wiring
// `session_before_compact`, ideally refactoring the existing
// @a4s/pi-context-expert onto this core) is promotion work, not PoC scope.
// What the PoC asserts is contract parity: one core, two assemblers.

import { runCompaction, type HostBinding } from '../../core/binding.js';
import type { CompactOptions, CompactResult, JevAsker, Message } from '../../core/types.js';

/**
 * A Pi transcript message, reduced to the neutral shape the core reads. A real
 * Pi port maps Pi's branch entries (messages, tool calls, custom entries) here.
 */
export type PiMessage = Message;

/** Pi's compaction return shape: the summary is a string, not a message array. */
export interface PiCompaction {
  /** The deterministic summary Pi installs in place of the dropped history. */
  summary: string;
  /** How many messages survived verbatim (kept with their content). */
  keptMessages: number;
  stats: CompactResult['stats'];
}

/** Renders the core decisions as a Pi-style deterministic summary string. */
function renderPiSummary(result: CompactResult): string {
  const { stats } = result;
  const lines = [
    '# Jev-authoritative compaction (Pi)',
    '',
    'Tool calls and results were scored deterministically; whatever is not kept',
    'was removed, and the assistant can re-run a tool if needed.',
    '',
    '## Decisions',
  ];
  for (const d of result.decisions) {
    if (d.reason === 'pinned') continue;
    lines.push(`- ${d.id} (${d.tool}): ${d.action} · keepCall=${d.keepCall.toFixed(2)} keepResult=${d.keepResult.toFixed(2)}`);
  }
  lines.push(
    '',
    '## Audit',
    `- messages ${stats.messagesBefore} → ${stats.messagesAfter}`,
    `- kept=${stats.kept}, results truncated=${stats.resultsDropped}, calls dropped=${stats.callsDropped}, pinned=${stats.pinned}`,
    `- state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`,
  );
  return lines.join('\n');
}

/**
 * The Pi half of the HostBinding contract. `toNeutral` passes the (already
 * neutral) transcript through; `assemble` produces Pi's string-summary result
 * from the same core decisions the Claude adapter uses.
 */
export const piBinding: HostBinding<PiMessage, PiCompaction> = {
  toNeutral: (host) => host,
  assemble: (_host, result) => ({
    summary: renderPiSummary(result),
    keptMessages: result.stats.messagesAfter,
    stats: result.stats,
  }),
};

/** Drives the shared core for Pi via the contract (used by tests and a future Pi hook). */
export function compactForPi(
  messages: readonly PiMessage[],
  asker: JevAsker,
  options?: CompactOptions,
): Promise<{ result: CompactResult; output: PiCompaction }> {
  return runCompaction(messages, piBinding, asker, options);
}
