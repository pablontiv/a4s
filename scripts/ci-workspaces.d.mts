export interface Workspace {
  dir: string;
  name: string;
  test: boolean;
  typecheck: boolean;
  dependencies: string[];
}
export function select(
  files: unknown[],
  workspaces: Workspace[],
  eventName: string | undefined,
): { name: string; test: boolean; typecheck: boolean }[];
