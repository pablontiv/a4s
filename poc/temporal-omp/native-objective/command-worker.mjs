import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createActivities } from '../objective/activities.mjs';
const require = createRequire(new URL('../objective/package.json', import.meta.url));
const { Worker, NativeConnection } = require('@temporalio/worker');
const [directory, mandateId] = process.argv.slice(2);
const root = resolve(directory); mkdirSync(root, { recursive: true });
const record = (type, data = {}) => appendFileSync(resolve(root, 'events.jsonl'), JSON.stringify({ type, at: new Date().toISOString(), ...data }) + '\n');
const files = ['workflow.ts', 'contracts.ts', 'extension.ts'];
for (const name of files) writeFileSync(resolve(root, name + '.txt'), await (await import('node:fs/promises')).readFile(new URL(name, import.meta.url)));
writeFileSync(resolve(root, 'evidence-manifest.json'), JSON.stringify({ version: 1, files: files.map(name => ({ path: name + '.txt', schema: 'source' })) }));
const base = createActivities(root);
const connection = await NativeConnection.connect({ address: '127.0.0.1:17233' });
const worker = await Worker.create({ connection, namespace: 'default', taskQueue: 'native-objective-' + mandateId + '-commands', activities: {
  recordState: async snapshot => { await base.recordState(snapshot); record('state', { snapshot }); },
  executeBoundItem: async (...args) => { record('command_started', { binding: args[0] }); const receipt = await base.executeBoundItem(...args); record('command_completed', { receipt }); return receipt; },
}, shutdownGraceTime: '1 second' });
process.on('SIGTERM', () => worker.shutdown());
console.log('COMMAND_WORKER_READY');
await worker.run(); await connection.close(); record('command_worker_shutdown');
