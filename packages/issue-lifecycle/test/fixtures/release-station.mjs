import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareService } from './service-environment.ts';

// Hosted runners have no operator station. Give the heavy-slot wrapper its own
// disposable declaration before the test preload creates per-process stations.
// Real tools win PATH lookup; bootstrap-only missing tools are fixture stubs.
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('release-station requires a test command');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'a4s-release-station-')));
try {
  const declared = declareService(home, 'http://127.0.0.1:18765');
  const service = JSON.parse(readFileSync(declared.A4S_SERVICE_ENV, 'utf8'));
  service.PATH = `${process.env.PATH}:${service.PATH}`;
  writeFileSync(declared.A4S_SERVICE_ENV, JSON.stringify(service));
  const env = { ...process.env, ...declared, PATH: service.PATH };
  // Never borrow an enclosing role job's engine, slot or journal.
  for (const key of ['A4S_BIN', 'A4S_HEAVY_SLOT_HELD', 'A4S_GATE_JOURNAL', 'DAGU_OUTPUT_FILE']) delete env[key];
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
