import './runtime-paths';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { Worker, NativeConnection } from '../objective/node_modules/@temporalio/worker/lib/index.js';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '../objective/node_modules/@temporalio/client/lib/index.js';
import { Context } from '../objective/node_modules/@temporalio/activity/lib/index.js';
import { Database } from 'bun:sqlite';
import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { bindingToken, parseTokens, type Binding, type Receipt, type Snapshot } from './contracts';
export default function objectiveHost(pi: ExtensionAPI) {
  const root = process.env.NATIVE_OBJECTIVE_EVIDENCE!;
  const mandateId = process.env.NATIVE_OBJECTIVE_MANDATE!;
  const instanceId = randomUUID();
  const workflowId = 'native-objective-' + mandateId;
  const nativeQueue = workflowId + '-native', commandQueue = workflowId + '-commands';
  const record = (type: string, data: object = {}) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ type, at: new Date().toISOString(), pid: process.pid, instanceId, workflowId, ...data }) + '\n');
  let db: Database | undefined, worker: Worker | undefined, native: NativeConnection | undefined, connection: Connection | undefined, running: Promise<void> | undefined;
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  pi.on('turn_start', () => record('turn_start'));
  pi.on('turn_end', () => record('turn_end'));
  pi.on('agent_end', () => record('agent_end'));
  pi.on('session_before_compact', () => { record('session_before_compact'); });
  pi.on('session_compact', () => record('session_compact'));
  pi.on('tool_result', event => {
    if (!db || event.toolName !== 'task') return;
    const input = JSON.stringify(event.input);
    // Parse each string field rather than matching escaped JSON substrings.
    const strings: string[] = [];
    const collect = (value: unknown): void => { if (typeof value === 'string') strings.push(value); else if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
    collect(event.input);
    const inputs = strings.flatMap(parseTokens);
    const text = event.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const outputs = parseTokens(text);
    for (const key of new Set(inputs)) {
      const row = db.query('SELECT status FROM handoffs WHERE binding = ?').get(key) as { status: string } | null;
      if (!row || !outputs.includes(key) || event.isError) { record('receipt_rejected', { key, reason: 'unknown-or-mismatched-binding-or-error' }); continue; }
      if (row.status === 'accepted') { record('duplicate_receipt_rejected', { key }); continue; }
      const receipt: Receipt = { binding: JSON.parse(key), kind: 'native_host_activity', nativeHostProof: true, toolCallId: event.toolCallId, digest: createHash('sha256').update(text).digest('hex') };
      const changed = db.query("UPDATE handoffs SET status = 'accepted', receipt = ? WHERE binding = ? AND status = 'sent'").run(JSON.stringify(receipt), key).changes;
      if (changed) record('native_task_result', { binding: receipt.binding, receipt, toolCallId: event.toolCallId, inputSha256: createHash('sha256').update(input).digest('hex') });
      else record('receipt_rejected', { key, reason: 'not-dispatched' });
    }
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI || worker) return;
    record('session_start', { sessionId: ctx.sessionManager.getSessionId(), hasUI: ctx.hasUI, bunVersion: Bun.version, nativeQueue, commandQueue });
    try {
      db = new Database(join(root, 'handoffs.sqlite'));
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS handoffs (binding TEXT PRIMARY KEY, status TEXT NOT NULL, due INTEGER NOT NULL, receipt TEXT)');
      native = await NativeConnection.connect({ address: '127.0.0.1:17233' });
      worker = await Worker.create({ connection: native, namespace: 'default', taskQueue: nativeQueue, workflowBundle: { codePath: join(import.meta.dir, 'workflow-bundle.js') }, debugMode: false, shutdownGraceTime: '1 second', shutdownForceTime: '2 seconds', activities: {
        requestNativeTask: async (binding: Binding) => {
          const key = bindingToken(binding);
          const inserted = db!.query("INSERT OR IGNORE INTO handoffs(binding,status,due) VALUES (?, 'pending', ?)").run(key, Date.now() + (binding.itemId === 'native-first' ? 30000 : 0)).changes;
          record(inserted ? 'activity_request' : 'activity_recovered', { binding });
          while (!stopped) {
            const row = db!.query('SELECT status,due,receipt FROM handoffs WHERE binding = ?').get(key) as { status: string; due: number; receipt: string | null };
            if (row.status === 'accepted') return JSON.parse(row.receipt!);
            if (row.status === 'pending' && Date.now() >= row.due) {
              const changed = db!.query("UPDATE handoffs SET status = 'sent' WHERE binding = ? AND status = 'pending'").run(key).changes;
              if (changed) {
                record('handoff_sent', { binding });
                pi.sendMessage({ customType: 'native-objective', content: `Temporal objective request. Invoke native task exactly once synchronously with one child, no tools or files. The child's prompt must include this exact line and instruct the child to output that exact line unchanged:\nA4S_BINDING:${key}\nDo not simulate delegation. After result, say ITEM_DONE and await automatic successor.`, display: false, details: { binding } }, { deliverAs: 'nextTurn', triggerTurn: true });
              }
            }
            Context.current().heartbeat({ binding, status: row.status });
            await new Promise<void>(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 500); timers.add(timer); });
          }
          throw new Error('Owned host stopping; durable handoff retained');
        },
      } });
      running = worker.run(); running.catch(error => record('worker_error', { error: String(error) }));
      record('worker_started', { nativeQueue });
      connection = await Connection.connect({ address: '127.0.0.1:17233' });
      const client = new Client({ connection });
      let handle;
      try { handle = await client.workflow.start('nativeObjective', { taskQueue: nativeQueue, workflowId, args: [{ mandateId, nativeQueue, commandQueue }], workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowExecutionTimeout: '240 seconds' }); record('workflow_started', { runId: handle.firstExecutionRunId }); }
      catch (error) { if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error; handle = client.workflow.getHandle(workflowId); record('workflow_attached'); }
      handle.result().then((result: Snapshot) => { record('workflow_completed', { result }); ctx.ui.notify('NATIVE_OBJECTIVE_FINISHED', 'info'); }).catch(error => record('workflow_failed', { error: String(error) }));
    } catch (error) { record('startup_failed', { error: String(error) }); }
  });
  pi.on('session_shutdown', async () => {
    stopped = true;
    if (worker?.getState() === 'RUNNING') worker.shutdown();
    await running?.catch(() => {});
    await connection?.close(); await native?.close();
    record('session_shutdown');
  });
}
