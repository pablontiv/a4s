import { fork } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { LeaseAuthority } from './authority.mjs';

const [mode, dbPath, mandateId, gate] = process.argv.slice(2);
const authority = new LeaseAuthority(dbPath);
if (mode === 'child') {
  const lease = JSON.parse(process.env.PROBE_LEASE);
  const binding = JSON.parse(process.env.PROBE_BINDING);
  writeFileSync(`${gate}.ready`, String(process.pid));
  const timer = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(timer);
    authority.deliver(lease, binding, { childPid: process.pid, value: 'late-child-result' });
    authority.close();
  }, 10);
} else if (mode === 'owner') {
  let lease = authority.acquire(mandateId, `owner-${process.pid}`, 600);
  const attempt = authority.beginAttempt(lease, 'item-1', 2);
  const binding = { mandateId, itemId: 'item-1', stage: 'execute', attempt: attempt.attempt, revision: process.env.PROBE_REVISION, generation: lease.generation };
  const child = fork(new URL('./process.mjs', import.meta.url), ['child', dbPath, mandateId, gate], {
    detached: true, stdio: 'ignore', env: { ...process.env, PROBE_LEASE: JSON.stringify(lease), PROBE_BINDING: JSON.stringify(binding) },
  });
  child.unref();
  const heartbeat = setInterval(() => { lease = authority.renew(lease, 600); }, 100);
  process.send({ event: 'started', lease, binding, childPid: child.pid });
  process.on('message', (message) => {
    if (message !== 'normal-exit') return;
    writeFileSync(gate, 'normal child completion');
    child.once('exit', () => {
      clearInterval(heartbeat);
      authority.complete(lease, binding);
      authority.release(lease);
      authority.close();
      process.disconnect();
    });
  });
} else if (mode === 'replacement') {
  const lease = authority.acquire(mandateId, `replacement-${process.pid}`, 5000);
  const attempt = authority.beginAttempt(lease, 'item-1', 2);
  process.send({ event: 'replacement', lease, attempt });
  process.on('message', (message) => {
    if (message === 'late-delivery') {
      const row = authority.db.prepare('SELECT * FROM inbox ORDER BY id DESC LIMIT 1').get();
      const verdicts = {};
      for (const kind of ['result', 'effect']) {
        try { authority.commit(JSON.parse(row.lease), kind, JSON.parse(row.binding), JSON.parse(row.payload)); verdicts[kind] = 'accepted'; }
        catch (error) { verdicts[kind] = error.message; }
      }
      const binding = { mandateId, itemId: 'item-1', stage: 'execute', attempt: attempt.attempt, revision: process.env.PROBE_REVISION, generation: lease.generation };
      authority.commit(lease, 'result', binding, { replacement: true });
      authority.commit(lease, 'effect', binding, { replacement: true });
      authority.complete(lease, binding);
      authority.release(lease);
      process.send({ event: 'verdicts', verdicts });
      authority.close();
      process.disconnect();
    } else if (message === 'stop') {
      authority.release(lease);
      authority.close();
      process.disconnect();
    }
  });
} else {
  throw new Error(`unknown-process-mode:${mode}`);
}
