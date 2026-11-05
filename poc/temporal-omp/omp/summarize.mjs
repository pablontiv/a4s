import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const events = readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const sessionIndex = events.findLastIndex(event => event.type === 'session_start' && event.hostDistribution === 'official-compiled');
if (sessionIndex < 0) throw new Error('No compiled host session observed');
const run = events.slice(sessionIndex);
const session = run[0];
const worker = run.find(event => event.type === 'worker_started');
const started = run.find(event => event.type === 'workflow_started');
const request = run.find(event => event.type === 'activity_request' && event.receiptId === started?.receiptId);
const receipt = run.find(event => event.type === 'native_task_result' && event.receiptId === started?.receiptId);
const completed = run.find(event => event.type === 'workflow_completed' && event.workflowId === started?.workflowId);
const shutdown = run.find(event => event.type === 'session_shutdown');
if (!session.hasUI || !session.nodePathUnset || worker?.debugMode !== false || request?.deliverAs !== 'nextTurn' || !receipt?.markerObserved || receipt.isError || !completed || completed.result.receiptId !== started.receiptId || completed.result.toolCallId !== receipt.toolCallId || !shutdown) throw new Error('Latest compiled host completion evidence incomplete');
const manifest = JSON.parse(readFileSync(join(root, 'dist/build-manifest.json'), 'utf8'));
const sourceSha256 = {};
for (const path of [...Object.keys(manifest.inputSha256), 'launch.sh', 'smoke-config.yml', 'summarize.mjs']) {
  sourceSha256[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  if (manifest.inputSha256[path] && manifest.inputSha256[path] !== sourceSha256[path]) throw new Error(`Build input changed: ${path}`);
}
const deployedSha256 = {};
for (const [path, expected] of Object.entries(session.deployedSha256)) {
  deployedSha256[path] = createHash('sha256').update(readFileSync(join(root, 'dist', path))).digest('hex');
  if (deployedSha256[path] !== expected || (manifest.outputSha256[path] && expected !== manifest.outputSha256[path])) throw new Error(`Invoked deployment changed: ${path}`);
}
const binary = '/home/pones/.local/share/tern/omp/bin/omp';
const summary = {
  observedAt: completed.at,
  scenario: 'compiled-interactive-native-main-task-receipt', result: 'passed',
  scope: 'Official compiled interactive OMP -> embedded Temporal worker -> nextTurn activity request -> main native task -> correlated tool_result -> completed Temporal workflow',
  command: 'bash poc/temporal-omp/omp/launch.sh',
  host: { binary, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), cwd: session.cwd, nodePathUnset: session.nodePathUnset },
  interactive: { pty: true, print: false, sessionId: session.sessionId, hasUI: session.hasUI, activeTools: session.activeTools, terminalMarkers: ['NATIVE_HOST_WORKFLOW_COMPLETED', 'NATIVE_HOST_DONE'] },
  versions: { omp: session.ompVersion, hostDistribution: session.hostDistribution, bun: session.bunVersion, buildBun: manifest.bun, temporalSdk: manifest.temporalSdk, temporalServer: '1.32.2' },
  temporal: { address: '127.0.0.1:17233', namespace: 'default', debugMode: worker.debugMode, workflowId: completed.workflowId, receiptId: started.receiptId },
  worker, request, receipt, completed, shutdown,
  sourceSha256, sdkInputSha256: manifest.sdkInputSha256, deployedSha256,
  gateInteroperability: 'Not claimed; no ownership/update/safety gate was executed through this native host',
  limitations: [
    'Historical unbundled compiled host failed to resolve @temporalio/common in its workflow worker thread; NODE_PATH did not fix it. Prior npm-host pass and failures remain in events.jsonl and README.md. This pass uses two self-contained bundles.',
    'SDK 1.25.0 source-rewrite needles are a build dependency; changing the SDK requires reviewing bundler stubbing and rewritten thread/addon/WASM lookups.',
    'Native addon deployment is platform-specific: x86_64-unknown-linux-gnu only.',
    'Remaining hardcoded build paths in @grpc/grpc-js channelz/orca proto loading and Temporal debug-replayer worker-thread are not exercised or made portable by this smoke.',
    'Synchronous task overlay is required for this tool_result receipt contract; async completion hooks remain unproven.',
    'v8.promiseHooks.createHook is unavailable in this embedded runtime; Temporal reports stack trace collection disabled.',
    'Context compaction, reload, crash/restart recovery, ownership/deduplication, authorization and update gates remain unexercised.',
    'Private credential/config snapshots are ignored and unpublished; original user host and existing Temporal server were not stopped.',
    'Only the targeted deployment build, interactive smoke and evidence reconciliation were run; no broad build/test/lint or prior-proof rerun.',
  ],
  eventsPath: 'poc/temporal-omp/omp/events.jsonl',
};
writeFileSync(join(root, 'evidence.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ result: summary.result, workflowId: completed.workflowId, receiptId: started.receiptId }));
