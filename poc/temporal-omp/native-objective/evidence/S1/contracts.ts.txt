import type { Binding } from '../objective/workflows';
export type { Binding };
export interface Receipt { binding: Binding; kind: 'native_host_activity' | 'bootstrap_command_activity'; nativeHostProof: boolean; digest?: string; toolCallId?: string }
export interface StateItem { id: string; dependencies: string[]; operation: string; blocker?: string; status: string; binding: Binding; receipt?: Receipt }
export interface Snapshot { mandateId: string; status: string; items: StateItem[] }
export interface Activities { requestNativeTask(binding: Binding): Promise<Receipt>; executeBoundItem(binding: Binding, operation: string, upstream: Receipt[]): Promise<Receipt>; recordState(snapshot: Snapshot): Promise<void> }
export const bindingKeys = ['mandateId', 'itemId', 'stage', 'attempt', 'revision', 'generation'] as const;
export function bindingToken(binding: Binding) { return JSON.stringify(Object.fromEntries(bindingKeys.map(key => [key, binding[key]]))); }
export function parseTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/A4S_BINDING:(\{[^\n{}]+\})/g)) {
    try { const value = JSON.parse(match[1]); if (Object.keys(value).length === bindingKeys.length && bindingKeys.every(key => typeof value[key] === (['attempt', 'revision', 'generation'].includes(key) ? 'number' : 'string'))) tokens.push(bindingToken(value)); } catch {}
  }
  return tokens;
}
