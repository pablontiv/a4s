export type Github = (args: string[]) => string;
export interface PublicationEvent {
  repository: { full_name: string };
  workflow_run?: { id: number; conclusion: string; event: string; head_branch: string; head_sha: string; head_repository: { full_name: string } };
}
export interface PublicationPlan {
  publish: boolean; version?: string; commit?: string; tag?: string;
  repository?: string; existing?: boolean; tagExists?: boolean;
}
export function planPublication(options: { cwd: string; event: PublicationEvent; inputs: string[]; gh?: Github }): PublicationPlan;
export function publishArchives(plan: PublicationPlan, directory: string, options?: { cwd?: string; gh?: Github }): Promise<void>;
