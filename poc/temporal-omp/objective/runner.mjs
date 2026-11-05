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
const selectedPaths = JSON.parse(process.env.OBJECTIVE_SELECTED_PATHS || '[]');
if (!Array.isArray(selectedPaths) || selectedPaths.length > 32) throw new Error('selectedPaths must be a bounded array');
const selectedEntries = [];
for (const [index, entry] of selectedPaths.entries()) {
  if (!entry || typeof entry.path !== 'string' || typeof entry.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name) || !entry.expectedScenario) throw new Error('Selected paths require name, path, expectedScenario');
  if (entry.expectedAcceptance && !['accepted', 'reported'].includes(entry.expectedAcceptance)) throw new Error('Invalid expectedAcceptance');
  const path = `selected-${index}-${entry.name}.json`;
  await writeFile(resolve(evidenceRoot, path), await readFile(resolve(entry.path)));
  selectedEntries.push({ path, schema: 'retained-evidence', acceptance: entry.expectedAcceptance || 'accepted', name: entry.name, originalPath: resolve(entry.path), expectedScenario: entry.expectedScenario, expectedBinding: entry.expectedBinding });
  if (entry.references && (!Array.isArray(entry.references) || entry.references.length > 32)) throw new Error('Invalid selected references');
  for (const [referenceIndex, reference] of (entry.references || []).entries()) {
    if (typeof reference !== 'string') throw new Error('Invalid reference path');
    const referencePath = `selected-${index}-reference-${referenceIndex}`;
    await writeFile(resolve(evidenceRoot, referencePath), await readFile(resolve(reference)));
    selectedEntries.push({ path: referencePath, schema: 'source', originalPath: resolve(reference), name: `${entry.name}-reference-${referenceIndex}` });
  }
}
await writeFile(resolve(evidenceRoot, 'selected-paths.json'), JSON.stringify(selectedPaths, null, 2) + '\n');
const admission = { workflowId, address, namespace, admissions: 1, admittedAt: new Date().toISOString(), executionKind: 'bootstrap_command_activity', nativeHostProof: false };
await writeFile(resolve(evidenceRoot, 'admission.json'), JSON.stringify(admission, null, 2) + '\n');
// Retain the executable sources used by the fixed command operations, not arbitrary commands supplied by evidence.
for (const file of ['workflows.ts', 'activities.mjs', 'commands.mjs', 'runner.mjs', 'package.json', 'package-lock.json']) await writeFile(resolve(evidenceRoot, file), await readFile(resolve(here, file)));
await writeFile(resolve(evidenceRoot, 'evidence-manifest.json'), JSON.stringify({ version: 1, files: [
  { path: 'input.json', schema: 'objective-input' }, { path: 'admission.json', schema: 'admission' },
  ...['workflows.ts', 'activities.mjs', 'commands.mjs', 'runner.mjs', 'package.json', 'package-lock.json'].map(path => ({ path, schema: 'source' })),
  ...selectedEntries,
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
    const inventory = JSON.parse(await readFile(resolve(evidenceRoot, 'inventory.json'), 'utf8'));
    if (!validation.valid || !inventory.records.some(record => record.path === 'input.json' && record.schema === 'objective-input') || !inventory.records.some(record => record.path === 'admission.json' && record.schema === 'admission') || !selectedEntries.every(entry => inventory.records.some(record => record.path === entry.path && record.schema === entry.schema))) throw new Error('Missing required semantic evidence entries');
    for (const state of final.items.filter(item => item.status === 'completed')) {
      if (state.receipt.binding.mandateId !== input.mandateId || state.receipt.binding.itemId !== state.id || state.receipt.binding.revision !== input.revision || state.receipt.binding.generation !== input.generation) throw new Error('Missing correlated final binding');
    }
    const summary = { observedAt: new Date().toISOString(), scenario: 'bounded-objective-independent-succession', result: 'passed', workflowId, runId: handle.firstExecutionRunId, evidenceRoot, completed, blockers: final.blockers, selectedEvidence: selectedEntries.filter(entry => entry.schema === 'retained-evidence').map(entry => ({ name: entry.name, scenario: entry.expectedScenario, originalPath: entry.originalPath })), historyEvents: history.events.length, stateTransitions: transitions.length, liveQueries: queries.length, nativeHostProof: false, executionKind: 'bootstrap_command_activity', limitations: ['Not an interactive OMP native host, turn/context continuity or reload proof.', 'Numeric binding revision is the objective experiment sequence, not the safety gate Git SHA; independent slice evidence is reviewed, not integrated gate execution.'] };
    await writeFile(resolve(evidenceRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
  } finally { worker.shutdown(); await run; run = undefined; }
} finally {
  if (run) { worker.shutdown(); await run; }
  if (native) await native.close();
  await connection.close();
}
