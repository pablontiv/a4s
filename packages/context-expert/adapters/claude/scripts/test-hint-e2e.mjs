import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureSource = join(adapterRoot, 'tests', 'trigger-hint.e2e.fixture.ts');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'a4s-claude-hint-'));

try {
  await cp(adapterRoot, temporaryRoot, { recursive: true });
  await rm(join(temporaryRoot, 'tests'), { recursive: true, force: true });
  await mkdir(join(temporaryRoot, 'tests'));
  await cp(fixtureSource, join(temporaryRoot, 'tests', 'trigger-hint.e2e.test.ts'));

  const manifestPath = join(temporaryRoot, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.name = `${manifest.name}-hint-test`;
  manifest.userConfig.triggerMode.default = 'hint';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = spawnSync('claude', ['plugin', 'test', temporaryRoot], {
    cwd: adapterRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
