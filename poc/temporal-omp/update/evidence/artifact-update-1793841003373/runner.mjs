import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createActivities as oldActivities } from './worker-v1.mjs';
import { createActivities as nextActivities } from './worker-v2.mjs';

const require = createRequire(new URL('../objective/package.json', import.meta.url));
const { Connection, Client } = require('@temporalio/client');
const { NativeConnection, Worker } = require('@temporalio/worker');
const here = fileURLToPath(new URL('.', import.meta.url));
const id = `artifact-update-${Date.now()}`;
const root = resolve(here, 'evidence', id);
const address = '127.0.0.1:17233';
const namespace = 'default';
await mkdir(root, { recursive: true });
const sources = ['runner.mjs', 'version-binding.ts', 'workflow.ts', 'workflow-v1.ts', 'workflow-v2.ts', 'worker-v1.mjs', 'worker-v2.mjs'];
const hashes = {};
for (const name of sources) {
  const bytes = await readFile(resolve(here, name));
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(root, name), bytes);
}
const input = {
  old: { attempt: 1, generation: 1, workerArtifact: hashes['worker-v1.mjs'] },
  next: { attempt: 2, generation: 2, workerArtifact: hashes['worker-v2.mjs'] },
  oldQueue: `${id}-old`, nextQueue: `${id}-new`, values: [2, 3, 5],
};
const manifest = { address, namespace, workflowId: id, workflowQueue: `${id}-workflow`, hashes,
  sdk: Object.fromEntries(['client', 'worker', 'workflow', 'common'].map(name => [name, require(`@temporalio/${name}/package.json`).version])),
  bindingScope: 'Isolated update experiment, not SafetyProbe acceptance binding', nativeOMPReloadProven: false };
for (const version of Object.values(manifest.sdk)) assert.equal(version, '1.25.0');
await writeFile(resolve(root, 'input.json'), JSON.stringify(input, null, 2) + '\n');
await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const observations = [];
const connection = await Connection.connect({ address });
const native = await NativeConnection.connect({ address });
const workers = [];
let handle;
const record = async (event, detail) => {
  observations.push({ at: new Date().toISOString(), event, detail });
  await writeFile(resolve(root, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
};
async function start(options) {
  const worker = await Worker.create({ connection: native, namespace, ...options });
  const entry = { worker, running: worker.run(), stopped: false };
  // Attach a rejection handler immediately; shutdown still propagates any failure.
  entry.running.catch(() => {});
  workers.push(entry);
  return entry;
}
async function stop(entry) {
  if (!entry.stopped) { entry.stopped = true; entry.worker.shutdown(); await entry.running; }
}
let release;
try {
  const client = new Client({ connection, namespace });
  let started;
  const oldStarted = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  await start({ taskQueue: input.oldQueue, activities: oldActivities({ started, released }), buildId: hashes['worker-v1.mjs'] });
  await start({ taskQueue: input.nextQueue, activities: nextActivities(), buildId: hashes['worker-v2.mjs'] });
  const oldWorkflow = await start({ taskQueue: manifest.workflowQueue, workflowsPath: resolve(here, 'workflow-v1.ts'), buildId: hashes['workflow-v1.ts'] });
  handle = await client.workflow.start('versionUpdate', { workflowId: id, taskQueue: manifest.workflowQueue, args: [input], workflowExecutionTimeout: '2 minutes' });
  await Promise.race([oldStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Old activity did not start')), 30000).unref())]);
  const before = await handle.query('updateState');
  assert.equal(before.workflowArtifact, 'workflow-v1');
  assert.equal(before.phase, 'old-pending');
  await record('old-activity-in-flight', before);
  await stop(oldWorkflow);
  await start({ taskQueue: manifest.workflowQueue, workflowsPath: resolve(here, 'workflow-v2.ts'), buildId: hashes['workflow-v2.ts'] });
  const after = await handle.query('updateState');
  assert.equal(after.workflowArtifact, 'workflow-v2');
  assert.equal(after.phase, 'old-pending');
  await record('new-workflow-artifact-replayed-pending-old-activity', after);
  await handle.signal('supersede');
  const superseded = await handle.query('updateState');
  assert.equal(superseded.active.attempt, 2);
  assert.equal(superseded.phase, 'superseded-awaiting-old-result');
  await record('old-attempt-superseded-before-release', superseded);
  release();
  const result = await handle.result();
  assert.equal(result.workflowArtifact, 'workflow-v2');
  assert.equal(result.phase, 'completed');
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'superseded-attempt');
  assert.equal(result.rejected[0].receipt.implementation, 'v1-sum');
  assert.equal(result.rejected[0].receipt.value, 10);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].implementation, 'v2-sum-of-squares');
  assert.equal(result.accepted[0].value, 38);
  assert.deepEqual(result.accepted[0].binding, input.next);
  await writeFile(resolve(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const history = await handle.fetchHistory();
  await writeFile(resolve(root, 'history.json'), JSON.stringify(history, null, 2) + '\n');
  const summary = { result: 'passed', workflowId: id, runId: handle.firstExecutionRunId, evidenceRoot: root,
    actualOldImplementation: 'v1-sum => 10', actualNewImplementation: 'v2-sum-of-squares => 38',
    compatibleContinuation: 'New workflow source replayed the same live execution while the old activity remained in flight',
    rejectedOldResult: result.rejected[0].reason, successorAccepted: true, historyEvents: history.events.length,
    limitations: ['Not native OMP extension reload or turn/context continuation.', 'Explicit signal changes experiment attempt authority; not wired to SafetyProbe receipts.', 'Explicit separate activity queues route artifacts; not Temporal server Worker Deployment Versioning.', 'Compatible source change only; arbitrary incompatible workflow updates require a separate gate.'] };
  await writeFile(resolve(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (handle) await writeFile(resolve(root, 'history.json'), JSON.stringify(await handle.fetchHistory(), null, 2) + '\n');
  await writeFile(resolve(root, 'failure.json'), JSON.stringify({ message: String(error), stack: error.stack }, null, 2) + '\n');
  throw error;
} finally {
  release?.();
  for (const entry of workers.reverse()) await stop(entry);
  await native.close();
  await connection.close();
}
