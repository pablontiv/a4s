#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CASES = Object.freeze(['r2', 'r4', 'r9', 'selected-binary']);
export function parseArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--base', '--phase'].includes(key) || values[key] !== undefined || !args[i + 1]) throw new Error('Usage: station-acceptance.mjs --base r<D> --phase pre-bun|post-bun');
    values[key] = args[i + 1];
  }
  if (!/^r(?:0|[1-9]\d*)$/.test(values['--base'] ?? '') || !['pre-bun', 'post-bun'].includes(values['--phase'])) throw new Error('Expected --base r<D> and --phase pre-bun|post-bun');
  return { base: values['--base'], phase: values['--phase'] };
}
export function fixtureIdentities(base) {
  if (!/^r(?:0|[1-9]\d*)$/.test(base)) throw new Error('Invalid base build ID');
  const ordinal = BigInt(base.slice(1));
  return Object.fromEntries(['a', 'b', 'nonStarting', 'skillsOnly', 'agentOnly'].map((name, index) => [name, `r${ordinal + BigInt(index)}`]));
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function fixtureEnvironment(service, home, parent, port) {
  const forbidden = /^(?:DAGU_|DAG_|A4S_|PI_TOOL_BRIDGE_)/;
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => !forbidden.test(key) && !['RUN', 'PRIMARY', 'OMP_SESSION_ID'].includes(key)));
  Object.assign(env, { PATH: service.path, HOME: service.home, DAGU_HOME: home, DAGU_HOST: '127.0.0.1', DAGU_PORT: String(port), DAGU_URL: `http://127.0.0.1:${port}` });
  if (service.agentDir) env.PI_CODING_AGENT_DIR = service.agentDir;
  return env;
}
export function stationSnapshot(home) {
  // rejected IDs and persisted-format history are fields of this exact file,
  // not a lossy JSON projection. Never call the selector here: it writes pointers.
  const path = join(home, 'cache', 'a4s', 'state.json');
  const bytes = readFileSync(path);
  const state = JSON.parse(bytes);
  assert.ok(Array.isArray(state.rejected));
  assert.equal(typeof state.formats, 'object');
  return { bytes, digest: sha256(bytes), rejected: structuredClone(state.rejected), formats: structuredClone(state.formats), state };
}
export function assertStationUnchanged(before, after) {
  assert.ok(before.bytes.equals(after.bytes), 'Real station state changed during acceptance');
  assert.deepEqual(after.rejected, before.rejected);
  assert.deepEqual(after.formats, before.formats);
}
export function aggregateMatrix(rows) {
  const complete = CASES.every(name => rows.filter(row => row.case === name).length === 1);
  return { schema: 1, passed: complete && rows.length === CASES.length && rows.every(row => row.status === 'pass' && Array.isArray(row.evidence) && row.evidence.length > 0), rows };
}
export function isolatedRoot(out, realHome) {
  const output = realpathSync(out), station = realpathSync(realHome);
  const cache = realpathSync(join(station, 'cache', 'a4s'));
  const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
  if (inside(cache, output) || inside(output, station)) throw new Error('Evidence output must not overlap the real station cache or contain its home');
  return mkdtempSync(join(output, 'isolated-'));
}
export function writeEvidence(out, name, value) {
  const path = resolve(out, name);
  if (isAbsolute(relative(out, path)) || relative(out, path).startsWith(`..${sep}`)) throw new Error('Evidence path escapes output');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return relative(out, path);
}
export async function runAcceptance(options, execute) {
  const out = realpathSync(options.out), home = realpathSync(options.home);
  const before = stationSnapshot(home);
  if (before.state.current.version !== options.base) throw new Error('The selected station build must equal --base');
  const rows = [];
  const root = isolatedRoot(out, home);
  const context = { ...options, out, realHome: home, root, home: join(root, 'dagu'), identities: fixtureIdentities(options.base), station: before.state };
  let cleanup;
  try {
    cleanup = await execute.prepare(context);
    for (const name of CASES) {
      const evidence = [];
      try {
        await execute[name](context, evidence);
        rows.push({ case: name, run: `cutover-${options.phase}-${name}`, status: 'pass', evidence });
      } catch (error) {
        evidence.push(writeEvidence(out, `${name}/error.json`, { error: String(error), stack: error?.stack }));
        rows.push({ case: name, run: `cutover-${options.phase}-${name}`, status: 'fail', evidence });
      }
      writeEvidence(out, 'matrix.json', aggregateMatrix(rows));
    }
  } catch (error) {
    const evidence = writeEvidence(out, 'setup-error.json', { error: String(error), stack: error?.stack });
    for (const name of CASES) if (!rows.some(row => row.case === name)) rows.push({ case: name, run: `cutover-${options.phase}-${name}`, status: 'fail', evidence: [evidence] });
  } finally {
    try { await cleanup?.(); }
    catch (error) { for (const row of rows) { row.status = 'fail'; row.evidence.push(writeEvidence(out, 'cleanup-error.json', { error: String(error) })); } }
    try {
      const after = stationSnapshot(home);
      assertStationUnchanged(before, after);
      writeEvidence(out, 'station-integrity.json', { before: before.digest, after: after.digest, rejected: after.rejected, formats: after.formats });
    } catch (error) {
      const evidence = writeEvidence(out, 'station-integrity-error.json', { error: String(error) });
      for (const row of rows) { row.status = 'fail'; row.evidence.push(evidence); }
    }
    // Never follow fixture symlinks, nor delete anything outside the fresh root.
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    rmSync(root, { recursive: true, force: true });
  }
  const matrix = aggregateMatrix(rows);
  writeEvidence(out, 'matrix.json', matrix);
  return matrix;
}
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!process.env.A4S_NATIVE_OUT || !isAbsolute(process.env.A4S_NATIVE_OUT)) throw new Error('A4S_NATIVE_OUT must be an absolute, fresh evidence directory');
  mkdirSync(process.env.A4S_NATIVE_OUT, { recursive: true });
  if (readdirSync(process.env.A4S_NATIVE_OUT).length) throw new Error('Refusing to overwrite nonempty phase evidence');
  const { nativeExecutor } = await import('./station-scenarios.mjs');
  const result = await runAcceptance({ ...options, out: process.env.A4S_NATIVE_OUT, home: process.env.DAGU_HOME || join(homedir(), '.dagu') }, nativeExecutor);
  process.exitCode = result.passed ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error); process.exitCode = 1; });
