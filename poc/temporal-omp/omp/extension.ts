import './runtime-paths';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { Worker, NativeConnection } from '../objective/node_modules/@temporalio/worker/lib/index.js';
import { Client, Connection } from '../objective/node_modules/@temporalio/client/lib/index.js';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export default function nativeTemporalHost(pi: ExtensionAPI) {
  const evidence = process.env.NATIVE_HOST_EVENTS!;
  const record = (type: string, data: object = {}) => appendFileSync(evidence, JSON.stringify({ type, at: new Date().toISOString(), ...data }) + '\n');
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let worker: Worker | undefined, native: NativeConnection | undefined, connection: Connection | undefined, running: Promise<void> | undefined;
  pi.on('tool_result', async event => {
    if (event.toolName !== 'task') return;
    const input = JSON.stringify(event.input);
    for (const [receiptId, receipt] of pending) {
      if (!input.includes(receiptId)) continue;
      const text = event.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      record('native_task_result', { receiptId, toolCallId: event.toolCallId, isError: event.isError, inputSha256: sha(input), resultSha256: sha(text), markerObserved: text.includes(receiptId) });
      clearTimeout(receipt.timer); pending.delete(receiptId);
      if (event.isError || !text.includes(receiptId)) receipt.reject(new Error('Native task receipt missing or failed'));
      else receipt.resolve({ receiptId, toolCallId: event.toolCallId, resultSha256: sha(text) });
    }
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const deployedFiles = ['extension.js', 'workflow-worker-thread.js', 'workflow-bundle.js', 'mappings.wasm', 'releases/x86_64-unknown-linux-gnu/index.node', 'build-manifest.json'];
    record('session_start', { sessionId, hasUI: ctx.hasUI, activeTools: pi.getActiveTools(), hostDistribution: 'official-compiled', ompVersion: '18.16.0', bunVersion: Bun.version, cwd: process.cwd(), nodePathUnset: process.env.NODE_PATH === undefined, deployedSha256: Object.fromEntries(deployedFiles.map(path => [path, sha(readFileSync(join(import.meta.dir, path)))])) });
    try {
      const address = '127.0.0.1:17233';
      const taskQueue = 'native-host-' + randomUUID();
      native = await NativeConnection.connect({ address });
      worker = await Worker.create({ connection: native, namespace: 'default', taskQueue, workflowBundle: { codePath: join(import.meta.dir, 'workflow-bundle.js') }, debugMode: false, shutdownGraceTime: '1 second', shutdownForceTime: '3 seconds', activities: {
        requestNativeTask: ({ receiptId }: { receiptId: string }) => {
          const { promise, resolve, reject } = Promise.withResolvers<unknown>();
          const timer = setTimeout(() => { pending.delete(receiptId); reject(new Error('Native task receipt deadline')); }, 85000);
          pending.set(receiptId, { resolve, reject, timer });
          record('activity_request', { receiptId, sessionId, deliverAs: 'nextTurn' });
          pi.sendMessage({ customType: 'temporal-native-request', content: `Bounded Temporal smoke. Invoke the native task tool once, synchronously, with a single child instructed: Reply exactly ${receiptId}; use no tools and change no files. Include ${receiptId} in the task prompt. Do not simulate delegation. After receiving its result, reply NATIVE_HOST_DONE.`, display: false, details: { receiptId, sessionId } }, { deliverAs: 'nextTurn', triggerTurn: true });
          return promise;
        },
      } });
      running = worker.run(); running.catch((error: Error) => record('worker_error', { error: String(error) }));
      record('worker_started', { taskQueue, debugMode: false });
      connection = await Connection.connect({ address });
      const client = new Client({ connection });
      const receiptId = 'native-receipt-' + randomUUID();
      const workflowId = 'native-host-' + randomUUID();
      const handle = await client.workflow.start('nativeHostSmoke', { taskQueue, workflowId, args: [{ receiptId }], workflowExecutionTimeout: '110 seconds' });
      record('workflow_started', { workflowId, receiptId });
      handle.result().then((result: unknown) => { record('workflow_completed', { workflowId, result }); ctx.ui.notify('NATIVE_HOST_WORKFLOW_COMPLETED', 'info'); }).catch((error: Error) => record('workflow_failed', { workflowId, error: String(error) }));
    } catch (error) { record('startup_failed', { error: String(error) }); ctx.ui.notify(String(error), 'error'); }
  });
  pi.on('session_shutdown', async () => {
    for (const receipt of pending.values()) { clearTimeout(receipt.timer); receipt.reject(new Error('Host shutdown')); }
    pending.clear();
    if (worker?.getState() === 'RUNNING') worker.shutdown();
    await running?.catch(() => {});
    await connection?.close(); await native?.close(); record('session_shutdown');
  });
}
