export interface Binding {
  attempt: number;
  generation: number;
  workerArtifact: string;
}
export interface Receipt {
  binding: Binding;
  implementation: string;
  value: number;
}
export function rejection(expected: Binding, receipt: Receipt): string | undefined {
  if (receipt.binding.attempt !== expected.attempt) return 'superseded-attempt';
  if (receipt.binding.generation !== expected.generation) return 'superseded-generation';
  if (receipt.binding.workerArtifact !== expected.workerArtifact) return 'worker-artifact-mismatch';
  return undefined;
}
