import { defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Binding, Snapshot, Activities } from './contracts';
export const objectiveState = defineQuery<Snapshot>('objectiveState');
export async function nativeObjective(input: { mandateId: string; nativeQueue: string; commandQueue: string }) {
  const commands = proxyActivities<Activities>({ taskQueue: input.commandQueue, startToCloseTimeout: '25 seconds', retry: { maximumAttempts: 1 } });
  const native = proxyActivities<Activities>({ taskQueue: input.nativeQueue, startToCloseTimeout: '180 seconds', heartbeatTimeout: '8 seconds', retry: { initialInterval: '1 second', maximumInterval: '2 seconds', maximumAttempts: 5 } });
  const items = [
    { id: 'native-first', dependencies: [], operation: 'native-task' },
    { id: 'native-successor', dependencies: ['native-first'], operation: 'native-task' },
    { id: 'command-independent', dependencies: [], operation: 'inventory' },
    { id: 'named-blocker', dependencies: [], operation: 'native-task', blocker: 'operator-authorization-not-granted' },
  ];
  const snapshot: Snapshot = { mandateId: input.mandateId, status: 'running', items: items.map(item => ({ ...item, status: item.blocker ? 'blocked' : 'pending', binding: { mandateId: input.mandateId, itemId: item.id, stage: 'execute', attempt: 1, revision: 1, generation: 1 } as Binding })) };
  setHandler(objectiveState, () => snapshot);
  const publish = () => commands.recordState(JSON.parse(JSON.stringify(snapshot)));
  await publish();
  while (true) {
    const eligible = snapshot.items.filter(item => item.status === 'pending' && item.dependencies.every(id => snapshot.items.find(s => s.id === id)!.status === 'completed'));
    if (!eligible.length) break;
    for (const item of eligible) item.status = 'running';
    await publish();
    await Promise.all(eligible.map(async item => {
      const receipt = item.operation === 'native-task' ? await native.requestNativeTask(item.binding) : await commands.executeBoundItem(item.binding, item.operation, []);
      if (JSON.stringify(receipt.binding) !== JSON.stringify(item.binding) || receipt.nativeHostProof !== (item.operation === 'native-task') || receipt.kind !== (item.operation === 'native-task' ? 'native_host_activity' : 'bootstrap_command_activity')) throw new Error('Uncorrelated binding receipt');
      item.receipt = receipt; item.status = 'completed'; await publish();
    }));
  }
  for (const item of snapshot.items.filter(item => item.status === 'pending')) { item.status = 'blocked'; item.blocker = 'dependency-unavailable'; }
  snapshot.status = snapshot.items.some(item => item.status === 'blocked') ? 'blocked' : 'completed';
  await publish(); return snapshot;
}
