// Anchors the self-containment invariant: the Claude plugin ships a bundled
// copy of the host-neutral core (because the marketplace installs only the
// plugin's own directory), and that copy must stay byte-identical to the
// canonical `core/`. If this fails, run:
//   node adapters/claude/scripts/sync-core.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// @ts-expect-error — plain .mjs helper, no type declarations needed for the test.
import { checkCore } from '../adapters/claude/scripts/sync-core.mjs';

test('claude plugin: bundled core is byte-identical to canonical core', async () => {
  const diffs: string[] = await checkCore();
  assert.deepEqual(diffs, [], `bundled core is stale:\n${diffs.join('\n')}`);
});
