import { defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';

export interface Binding {
  mandateId: string; itemId: string; stage: string; attempt: number; revision: number; generation: number;
}
export interface Item {
  id: string;
  dependencies: string[];
  operation: 'inventory' | 'validate-inventory';
  blocker?: { name: string; reason: string };
}
export interface ObjectiveInput { mandateId: string; revision: number; generation: number; items: Item[] }
export interface Receipt { binding: Binding; kind: 'bootstrap_command_activity'; nativeHostProof: false; artifact: string; digest: string }
export interface Snapshot {
  mandateId: string; status: 'running' | 'completed' | 'blocked'; sequence: number; observedAt: string;
  items: { id: string; status: 'pending' | 'running' | 'completed' | 'blocked'; binding: Binding; receipt?: Receipt }[];
  blockers: { itemId: string; name: string; reason: string }[];
}
interface Activities {
  executeBoundItem(binding: Binding, operation: Item['operation'], upstream: Receipt[]): Promise<Receipt>;
  recordState(snapshot: Snapshot): Promise<void>;
}
const activities = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 } });
export const objectiveState = defineQuery<Snapshot>('objectiveState');

export async function objectiveWorkflow(input: ObjectiveInput): Promise<Snapshot> {
  if (!input.mandateId || !Number.isInteger(input.revision) || !Number.isInteger(input.generation) || input.items.length < 1 || input.items.length > 32) throw new Error('Invalid bounded objective input');
  const ids = new Set(input.items.map(item => item.id));
  if (ids.size !== input.items.length) throw new Error('Duplicate item IDs');
  for (const item of input.items) {
    if (!item.id || item.dependencies.length > 32 || item.dependencies.some(id => !ids.has(id) || id === item.id)) throw new Error('Invalid dependency');
    if (!['inventory', 'validate-inventory'].includes(item.operation)) throw new Error('Unsupported operation');
    if (item.blocker && (!item.blocker.name || item.blocker.name.length > 80 || !item.blocker.reason || item.blocker.reason.length > 240)) throw new Error('Invalid named blocker');
  }
  const snapshot: Snapshot = {
    mandateId: input.mandateId, status: 'running', sequence: 0, observedAt: new Date().toISOString(),
    items: input.items.map(item => ({ id: item.id, status: item.blocker ? 'blocked' : 'pending', binding: {
      mandateId: input.mandateId, itemId: item.id, stage: 'execute', attempt: 1, revision: input.revision, generation: input.generation,
    } })),
    blockers: input.items.filter(item => item.blocker).map(item => ({ itemId: item.id, ...item.blocker! })),
  };
  setHandler(objectiveState, () => snapshot);
  async function publish() {
    snapshot.sequence++;
    snapshot.observedAt = new Date().toISOString();
    await activities.recordState(snapshot);
  }
  await publish();
  // All currently eligible items run together; blocked items never occupy a worker slot.
  while (true) {
    const eligible = input.items.filter(item => snapshot.items.find(state => state.id === item.id)!.status === 'pending'
      && item.dependencies.every(id => snapshot.items.find(state => state.id === id)!.status === 'completed'));
    if (!eligible.length) break;
    for (const item of eligible) snapshot.items.find(state => state.id === item.id)!.status = 'running';
    await publish();
    await Promise.all(eligible.map(async item => {
      const state = snapshot.items.find(state => state.id === item.id)!;
      const upstream = item.dependencies.map(id => snapshot.items.find(state => state.id === id)!.receipt!);
      const receipt = await activities.executeBoundItem(state.binding, item.operation, upstream);
      if (JSON.stringify(receipt.binding) !== JSON.stringify(state.binding) || receipt.kind !== 'bootstrap_command_activity' || receipt.nativeHostProof !== false) throw new Error('Uncorrelated receipt');
      state.receipt = receipt;
      state.status = 'completed';
    }));
    await publish();
  }
  for (const item of snapshot.items.filter(item => item.status === 'pending')) {
    item.status = 'blocked';
    snapshot.blockers.push({ itemId: item.id, name: 'dependency-unavailable', reason: 'Dependencies blocked or cyclic; no eligible predecessor remains.' });
  }
  snapshot.status = snapshot.blockers.length ? 'blocked' : 'completed';
  await publish();
  return snapshot;
}
