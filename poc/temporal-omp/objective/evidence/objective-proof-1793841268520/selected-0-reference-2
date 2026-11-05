'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const sdkModules = path.resolve(process.env.TEMPORAL_SDK_MODULES || path.join(__dirname, '../objective/node_modules'));
const sdk = createRequire(path.join(sdkModules, '__sqlite_probe__.cjs'));
const { Client, Connection } = sdk('@temporalio/client');
const { Worker, NativeConnection } = sdk('@temporalio/worker');
const address = '127.0.0.1:17233';
const namespace = 'default';
const mode = process.argv[2];
const evidencePath = process.argv[3];
if (!['before', 'after'].includes(mode) || !evidencePath) throw new Error('Usage: node probe.cjs before|after EVIDENCE_JSON');

async function observe(client, workflowId, runId) {
  const handle = client.workflow.getHandle(workflowId, runId);
  const result = await handle.result();
  const history = await handle.fetchHistory();
  const eventTypes = history.events.map(event => Number(event.eventType));
  // temporal.api.enums.v1.EventType: activity completed=12, workflow completed=2.
  if (!eventTypes.includes(12) || !eventTypes.includes(2)) throw new Error('Missing persisted activity/workflow completion history');
  const listed = [];
  for await (const info of client.workflow.list({ query: `WorkflowId = '${workflowId}'` })) listed.push({ workflowId: info.workflowId, runId: info.runId, status: info.status.name });
  if (!listed.some(info => info.runId === runId && info.status === 'COMPLETED')) throw new Error('Completed workflow missing from SQLite visibility');
  return { result, eventTypes, eventCount: eventTypes.length, visibility: listed };
}

(async () => {
  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    if (mode === 'before') {
      try { await connection.workflowService.describeNamespace({ namespace }); }
      catch (error) {
        if (error.code !== 5) throw error;
        await connection.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: 86400 } });
      }
      const nativeConnection = await NativeConnection.connect({ address });
      const taskQueue = 'sqlite-persistence-proof';
      let activityCalls = 0;
      const worker = await Worker.create({
        connection: nativeConnection, namespace, taskQueue,
        workflowsPath: path.join(__dirname, 'workflows.cjs'),
        bundlerOptions: { webpackConfigHook(config) { config.resolve.modules = [sdkModules, ...(config.resolve.modules || [])]; return config; } },
        activities: { recordCompletion: async binding => { activityCalls++; return { binding, activityCompleted: true }; } },
      });
      const workflowId = `sqlite-persistence-${Date.now()}`;
      const binding = { mandateId: 'sqlite-runtime-proof', itemId: workflowId, stage: 'activity', attempt: 1, revision: 1, generation: 1 };
      let runId;
      try {
        await worker.runUntil(async () => {
          const handle = await client.workflow.start('sqlitePersistenceProof', { taskQueue, workflowId, args: [binding] });
          runId = handle.firstExecutionRunId;
          await handle.result();
        });
      } finally { await nativeConnection.close(); }
      // Visibility indexing is asynchronous, not a guarantee at completion return.
      let before;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { before = await observe(client, workflowId, runId); break; }
        catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
      if (activityCalls !== 1) throw new Error(`Unexpected activity execution count: ${activityCalls}`);
      const evidence = { observedAt: new Date().toISOString(), scenario: 'real-server-sqlite-graceful-restart', address, namespace, serverVersion: '1.32.2', sdkVersion: sdk('@temporalio/client/package.json').version, workflowId, runId, binding, activityCalls, before, limitations: ['Single local process, graceful stop/restart only.', 'Not a backup restore, crash durability, HA, or production readiness proof.'] };
      evidence.phase = 'before-restart';
      evidence.result = 'INCOMPLETE: real activity/workflow completion observed; server restart and persistence read pending';
      fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ phase: mode, workflowId, runId, activityCalls, eventCount: before.eventCount }));
    } else {
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      const after = await observe(client, evidence.workflowId, evidence.runId);
      if (JSON.stringify(after) !== JSON.stringify(evidence.before)) throw new Error('Persisted workflow result/history/visibility differs after restart');
      evidence.after = { observedAt: new Date().toISOString(), ...after };
      evidence.phase = 'completed';
      evidence.result = 'passed';
      evidence.observation = 'Activity completion, workflow history/result and visibility survive real server graceful stop/restart without worker';
      fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ phase: mode, result: evidence.result, workflowId: evidence.workflowId, eventCount: after.eventCount }));
    }
  } finally { await connection.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
