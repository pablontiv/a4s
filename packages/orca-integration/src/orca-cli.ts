export function resolveOrcaCliPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const managedCommand = environment.ORCA_CLI_COMMAND?.trim()
  if (managedCommand) return managedCommand
  if (environment.ORCA_DEV_REPO_ROOT?.trim()) return 'orca-dev'
  if (platform === 'linux' && !environment.ORCA_PANE_KEY?.trim()) return 'orca-ide'
  return 'orca'
}
