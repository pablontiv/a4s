import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import { rejection, type Binding, type Receipt } from './version-binding';

interface Input { old: Binding; next: Binding; oldQueue: string; nextQueue: string; values: number[] }
const supersede = defineSignal('supersede');
const stateQuery = defineQuery('updateState');
export function createVersionWorkflow(workflowArtifact: string) {
  return async function versionUpdate(input: Input) {
    let superseded = false;
    const state = { workflowArtifact, phase: 'old-pending', active: input.old, rejected: [] as { receipt: Receipt; reason: string }[], accepted: [] as Receipt[] };
    setHandler(stateQuery, () => state);
    setHandler(supersede, () => {
      superseded = true;
      state.active = input.next;
      state.phase = 'superseded-awaiting-old-result';
    });
    const options = { startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 1 } };
    const old = proxyActivities<{ execute(binding: Binding, values: number[]): Promise<Receipt> }>({ ...options, taskQueue: input.oldQueue });
    const next = proxyActivities<{ execute(binding: Binding, values: number[]): Promise<Receipt> }>({ ...options, taskQueue: input.nextQueue });
    const pending = old.execute(input.old, input.values);
    await condition(() => superseded);
    const oldReceipt = await pending;
    const reason = rejection(state.active, oldReceipt);
    if (!reason) throw new Error('Superseded old result unexpectedly accepted');
    state.rejected.push({ receipt: oldReceipt, reason });
    state.phase = 'successor-running';
    const receipt = await next.execute(input.next, input.values);
    const invalid = rejection(state.active, receipt);
    if (invalid) throw new Error(invalid);
    state.accepted.push(receipt);
    state.phase = 'completed';
    return state;
  };
}
