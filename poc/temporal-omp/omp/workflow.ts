import { proxyActivities } from '@temporalio/workflow';
const { requestNativeTask } = proxyActivities<{ requestNativeTask(request: { receiptId: string }): Promise<unknown> }>({ startToCloseTimeout: '100 seconds', retry: { maximumAttempts: 1 } });
export async function nativeHostSmoke(request: { receiptId: string }) { return requestNativeTask(request); }
