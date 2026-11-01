// These modules are provided by the OMP host, not installed/bundled by A4S.
declare module "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard" {
  export function resolvePlanPath(session: { cwd: string; localProtocolOptions?: unknown }, target: string): Promise<string>;
}
declare module "@oh-my-pi/pi-coding-agent/tools/path-utils" {
  export function parseSearchPathPreferringLiteral(target: string, cwd: string): Promise<{ basePath: string; glob?: string }>;
  export function expandDelimitedPathEntries(targets: string[], cwd: string): Promise<string[]>;
}
declare module "@oh-my-pi/pi-coding-agent/internal-urls" {
  export const InternalUrlRouter: { instance(): {
    peelWriteSelector(target: string, tool: string): string;
    writeTarget(target: string): { url: unknown; spec: { write?: { scope: string; cancels?: (url: unknown) => boolean } } } | undefined;
  } };
}
declare module "@oh-my-pi/pi-utils/ar" {
  export function parseArchivePathCandidates(target: string): { archivePath: string }[];
}
declare module "@oh-my-pi/pi-coding-agent/tools/sqlite-reader" {
  export function parseSqlitePathCandidates(target: string): { sqlitePath: string }[];
}
declare module "@oh-my-pi/pi-coding-agent/tools/conflict-detect" {
  export function recoverConflictUriPrefix(target: string): { path: string };
}
declare module "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat" {
  export function loadLegacyPiModule(path: string, options?: { reload?: boolean }): Promise<unknown>;
}
