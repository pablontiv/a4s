import { Connection, Client } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActivities } from './activities.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const address = process.env.TEMPORAL_ADDRESS || '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
const workflowId = process.env.OBJECTIVE_WORKFLOW_ID || `objective-proof-${Date.now()}`;
const evidenceRoot = resolve(process.env.OBJECTIVE_EVIDENCE_DIR || resolve(here, 'evidence', workflowId));
const taskQueue = `${workflowId}-queue`;
await mkdir(evidenceRoot, { recursive: true });
const input = { mandateId: workflowId, revision: 1, generation: 1, items: [
  { id: 'await-host-authorization', dependencies: [], operation: 'inventory', blocker: { name: 'native-host-not-admitted', reason: 'Native OMP host execution is outside this command bootstrap admission.' } },
  { id: 'inventory-evidence', dependencies: [], operation: 'inventory' },
  { id: 'validate-evidence', dependencies: ['inventory-evidence'], operation: 'validate-inventory' },
] };
await writeFile(resolve(evidenceRoot, 'input.json'), JSON.stringify(input, null, 2) + '\n');
const admission = { workflowId, address, namespace, admissions: 1, admittedAt: new Date().toISOString(), executionKind: 'bootstrap_command_activity', nativeHostProof: false };
await writeFile(resolve(evidenceRoot, 'admission.json'), JSON.stringify(admission, null, 2) + '\n');
// Retain the executable sources used by the fixed command operations, not arbitrary commands supplied by evidence.
for (const file of ['workflows.ts', 'activities.mjs', 'commands.mjs', 'runner.mjs', 'package.json', 'package-lock.json']) await writeFile(resolve(evidenceRoot, file), await readFile(resolve(here, file)));
await writeFile(resolve(evidenceRoot, 'evidence-manifest.json'), JSON.stringify({ version: 1, files: [
  { path: 'input.json', schema: 'objective-input' }, { path: 'admission.json', schema: 'admission' },
  ...['workflows.ts', 'activities.mjs', 'commands.mjs', 'runner.mjs', 'package.json', 'package-lock.json'].map(path => ({ path, schema: 'source' })),
] }, null, 2) + '\n');
const connection = await Connection.connect({ address });
let native;
let worker;
let run;
try {
  try { await connection.workflowService.describeNamespace({ namespace }); }
  catch (error) {
    if (error.code !== 5) throw error;
    await connection.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: 86400 } });
  }
  const client = new Client({ connection, namespace });
  native = await NativeConnection.connect({ address });
  worker = await Worker.create({ connection: native, namespace, taskQueue, workflowsPath: resolve(here, 'workflows.ts'), activities: createActivities(evidenceRoot) });
  run = worker.run();
  const handle = await client.workflow.start('objectiveWorkflow', { workflowId, taskQueue, args: [input], workflowExecutionTimeout: '2 minutes' });
  const queries = [];
  let final;
  try {
    // Queries are real service reads while the workflow progresses, not synthesized snapshots.
    const completion = handle.result().then(result => { final = result; });
    while (!final) {
      try {
        const state = await handle.query('objectiveState');
        queries.push({ observedAt: new Date().toISOString(), state });
      } catch (error) {
        if (!String(error.message).includes('not registered') && !String(error.message).includes('Workflow task is not scheduled')) throw error;
      }
      if (!final) await new Promise(resolve => setTimeout(resolve, 50));
    }
    await completion;
    const querySnapshot = await handle.query('objectiveState');
    await writeFile(resolve(evidenceRoot, 'query-snapshot.json'), JSON.stringify(querySnapshot, null, 2) + '\n');
    await writeFile(resolve(evidenceRoot, 'query-observations.json'), JSON.stringify(queries, null, 2) + '\n');
    await writeFile(resolve(evidenceRoot, 'result.json'), JSON.stringify(final, null, 2) + '\n');
    const history = await handle.fetchHistory();
    await writeFile(resolve(evidenceRoot, 'history.json'), JSON.stringify(history, null, 2) + '\n');
    const completed = final.items.filter(item => item.status === 'completed').map(item => item.id);
    if (final.status !== 'blocked' || completed.join(',') !== 'inventory-evidence,validate-evidence' || final.blockers.length !== 1 || final.blockers[0].name !== 'native-host-not-admitted') throw new Error('Objective acceptance failed');
    const transitions = (await readFile(resolve(evidenceRoot, 'state-updates.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (!queries.some(query => query.state.status === 'running') || !transitions.some(state => state.items.find(item => item.id === 'validate-evidence').status === 'running' && state.items.find(item => item.id === 'await-host-authorization').status === 'blocked')) throw new Error('Missing live independent succession evidence');
    const validation = JSON.parse(await readFile(resolve(evidenceRoot, 'inventory-validation.json'), 'utf8'));
    if (!validation.valid || validation.checkedFiles < 8) throw new Error('Missing real inventory validation');
    const summary = { observedAt: new Date().toISOString(), scenario: 'bounded-objective-independent-succession', result: 'passed', workflowId, runId: handle.firstExecutionRunId, evidenceRoot, completed, blockers: final.blockers, historyEvents: history.events.length, stateTransitions: transitions.length, liveQueries: queries.length, nativeHostProof: false, executionKind: 'bootstrap_command_activity', limitations: ['Not an interactive OMP native host, turn/context continuity or reload proof.'] };
    await writeFile(resolve(evidenceRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
  } finally { worker.shutdown(); await run; run = undefined; }
} finally {
  if (run) { worker.shutdown(); await run; }
  if (native) await native.close();
  await connection.close();
}
