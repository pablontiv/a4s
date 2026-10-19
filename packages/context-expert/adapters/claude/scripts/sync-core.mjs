// Keeps the Claude plugin's bundled `core/` a byte-identical copy of the
// canonical host-neutral core at `packages/context-expert/core/`.
//
// The marketplace installs ONLY this plugin's own directory
// (`packages/context-expert/adapters/claude`), so the plugin must carry its
// own copy of the core it imports as `../core`. Canonical `core/` stays the
// single source of truth; this script regenerates the copy and the parity
// test (`test/claude-bundle-parity.test.ts`) fails if they ever diverge.
//
//   node adapters/claude/scripts/sync-core.mjs          # write the copy
//   node adapters/claude/scripts/sync-core.mjs --check  # exit 1 if stale
//
// Mirrors the generated-copy discipline of synagent's sync-protocol.mjs.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const canonical = join(here, '..', '..', '..', 'core');
const bundled = join(here, '..', 'core');

async function coreFiles(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort();
  const files = new Map();
  for (const name of names) files.set(name, await readFile(join(dir, name), 'utf8'));
  return files;
}

/** Returns a list of human-readable differences; empty means in sync. */
export async function checkCore() {
  const [src, dst] = await Promise.all([coreFiles(canonical), coreFiles(bundled).catch(() => new Map())]);
  const diffs = [];
  for (const [name, content] of src) {
    if (!dst.has(name)) diffs.push(`missing in bundle: ${name}`);
    else if (dst.get(name) !== content) diffs.push(`content differs: ${name}`);
  }
  for (const name of dst.keys()) if (!src.has(name)) diffs.push(`stale extra file in bundle: ${name}`);
  return diffs;
}

export async function syncCore() {
  const src = await coreFiles(canonical);
  await rm(bundled, { recursive: true, force: true });
  await mkdir(bundled, { recursive: true });
  for (const [name, content] of src) await writeFile(join(bundled, name), content);
  return [...src.keys()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  if (check) {
    const diffs = await checkCore();
    if (diffs.length > 0) {
      console.error('bundled core is stale; run: node adapters/claude/scripts/sync-core.mjs');
      for (const d of diffs) console.error(`  - ${d}`);
      process.exit(1);
    }
    console.log('bundled core is in sync');
  } else {
    const written = await syncCore();
    console.log(`synced ${written.length} core file(s) into adapters/claude/core`);
  }
}
