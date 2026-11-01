// Supplied by the running OMP binary, never bundled as a second host instance.
declare module "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat" {
  export function loadLegacyPiModule(path: string, options?: { reload?: boolean }): Promise<unknown>;
}
