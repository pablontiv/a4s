import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LeaseAuthority } from './authority.mjs';

const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: new URL('.', import.meta.url) }).trim();
assert.match(sourceRevision, /^[0-9a-f]{40}$/);

const root = mkdtempSync(join(tmpdir(), 'ownership-probe-'));
const dbPath = join(root, 'authority.sqlite');
const processes = [];
const childPids = new Set();
const evidence = [];
const limitations = ['Generic owned Node processes, not native OMP supervisor/session recovery.',
  'Single-host SQLite local filesystem; wall-clock TTL requires stable host clock.',
  'Effects proven are transactional accepted-effect records, not an atomic remote Git push fence.',
  'No host power-loss or filesystem fault injection; SIGKILL process loss only.'];
const record = (scenario, result) => evidence.push({ observedAt: new Date().toISOString(), scenario, result, limitations });
const spawn = (mode, mandate, gate) => {
  const process = fork(new URL('./process.mjs', import.meta.url), [mode, dbPath, mandate, gate], {
    silent: true, env: { ...globalThis.process.env, PROBE_REVISION: sourceRevision },
  });
  let stderr = '';
  process.stderr.on('data', (data) => { stderr += data; });
  process.on('exit', (code) => { if (code && code !== 0) console.error(stderr); });
  processes.push(process);
  return process;
};
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 6000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout:${description}`); await delay(10); }
};
const message = async (process) => {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 6000);
  try { return (await once(process, 'message', { signal: abort.signal }))[0]; }
  finally { clearTimeout(timeout); }
};
const closed = (process) => once(process, 'exit');
let authority;
try {
  authority = new LeaseAuthority(dbPath);
  const gate = join(root, 'crash-delivery');
  const owner = spawn('owner', 'crash', gate);
  const started = await message(owner);
  childPids.add(started.childPid);
  await waitFor(() => existsSync(`${gate}.ready`), 'child-in-flight');
  assert.equal(Number(readFileSync(`${gate}.ready`, 'utf8')), started.childPid);
  assert.throws(() => authority.acquire('crash', 'competitor', 600), /lease-busy/);
  const exited = closed(owner);
  owner.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  record('owner-killed-with-live-child', { ownerPid: owner.pid, childPid: started.childPid, signal, priorGeneration: started.lease.generation });
  await waitFor(() => authority.current('crash').expiresAt <= Date.now(), 'lease-expiry');
  const replacement = spawn('replacement', 'crash', gate);
  const recovered = await message(replacement);
  assert.equal(recovered.lease.generation, started.lease.generation + 1);
  assert.equal(recovered.attempt.attempt, 2);
  writeFileSync(gate, 'deliver after takeover');
  await waitFor(() => authority.db.prepare('SELECT count(*) AS n FROM inbox').get().n === 1, 'late-result');
  const verdictPromise = message(replacement);
  const replacementExit = closed(replacement);
  replacement.send('late-delivery');
  const verdict = await verdictPromise;
  assert.deepEqual(verdict.verdicts, { result: 'stale-lease', effect: 'stale-lease' });
  await replacementExit;
  const accepted = authority.db.prepare('SELECT generation,kind FROM accepted').all();
  assert.equal(accepted.length, 2);
  assert.ok(accepted.every((row) => row.generation === recovered.lease.generation));
  record('replacement-rejects-late-result-and-effect', { generation: recovered.lease.generation, attempt: recovered.attempt.attempt, verdicts: verdict.verdicts, accepted: accepted.map((row) => ({ ...row })) });

  const normalGate = join(root, 'normal-delivery');
  const normal = spawn('owner', 'normal', normalGate);
  const normalStarted = await message(normal);
  childPids.add(normalStarted.childPid);
  await waitFor(() => existsSync(`${normalGate}.ready`), 'normal-child-ready');
  const normalExit = closed(normal);
  normal.send('normal-exit');
  const [normalCode] = await normalExit;
  assert.equal(normalCode, 0);
  const successor = spawn('replacement', 'normal', normalGate);
  const normalRecovery = await message(successor);
  assert.deepEqual(normalRecovery.attempt, { state: 'done', attempt: 1 });
  const successorExit = closed(successor);
  successor.send('stop');
  await successorExit;
  record('normal-owner-exit-no-child-relaunch', { ownerExitCode: normalCode, recovery: normalRecovery.attempt });

  let bounded = authority.acquire('bounded', 'first', 1000);
  assert.equal(authority.beginAttempt(bounded, 'item-1', 2).attempt, 1);
  authority.release(bounded);
  bounded = authority.acquire('bounded', 'second', 1000);
  assert.equal(authority.beginAttempt(bounded, 'item-1', 2).attempt, 2);
  authority.release(bounded);
  bounded = authority.acquire('bounded', 'third', 1000);
  const exhausted = authority.beginAttempt(bounded, 'item-1', 2);
  assert.deepEqual(exhausted, { state: 'exhausted', attempt: 2 });
  authority.release(bounded);
  record('lost-child-recovery-attempt-bound', exhausted);

  authority.close();
  authority = new LeaseAuthority(dbPath);
  const reopened = authority.acquire('crash', 'reopened', 1000);
  assert.equal(reopened.generation, recovered.lease.generation + 1);
  assert.deepEqual(authority.beginAttempt(reopened, 'item-1', 2), { state: 'done', attempt: 2 });
  authority.release(reopened);
  record('durable-generation-and-completion-after-reopen', { generation: reopened.generation, noRelaunch: true });
  const output = { schemaVersion: 1, runtime: process.version, sourceRevision,
    command: 'node poc/temporal-omp/ownership/probe.mjs poc/temporal-omp/ownership/evidence.json', evidence };
  const destination = process.argv[2];
  if (destination) writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} finally {
  for (const process of processes) if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
  for (const pid of childPids) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  authority?.close();
  rmSync(root, { recursive: true, force: true });
}
