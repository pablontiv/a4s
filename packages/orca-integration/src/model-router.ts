import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { findOrcaCommands, hasShellFlag, readShellFlag } from './orca-command.ts'
import { resolveOrcaCliPath } from './orca-cli.ts'
import { isUnknownRecord } from './type-guards.ts'

const DEFAULT_TIMEOUT_MS = 10_000

export interface OrcaModelRoute {
  taskClass: string
  modelRole: string
}

export interface OrcaModelRouterOptions {
  cliPath?: string
  isOrcaPane?: () => boolean
  routes?: readonly OrcaModelRoute[]
  timeoutMs?: number
}

interface CommandResult {
  stdout: string
  stderr: string
  code: number
  killed: boolean
}

interface CoordinatorState {
  state: 'active' | 'inactive' | 'failed'
  reason?: string
}

interface ResolvedOrcaModelRoute extends OrcaModelRoute {
  effectiveModel: string
}

interface RoutingState {
  state: 'ready' | 'failed'
  routes?: readonly ResolvedOrcaModelRoute[]
  reason?: string
}


export const DEFAULT_ORCA_MODEL_ROUTES: readonly OrcaModelRoute[] = [
  { taskClass: 'implementation', modelRole: '@task' },
  { taskClass: 'planning', modelRole: '@plan' },
  { taskClass: 'review', modelRole: '@slow' },
  { taskClass: 'security', modelRole: '@slow' },
  { taskClass: 'light research', modelRole: '@smol' },
]

export function createOrcaModelRouter(options: OrcaModelRouterOptions = {}) {
  const cliPath = options.cliPath ?? resolveOrcaCliPath()
  const isOrcaPane = options.isOrcaPane ?? (() => Boolean(process.env.ORCA_PANE_KEY?.trim()))
  const routes = options.routes ?? DEFAULT_ORCA_MODEL_ROUTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return function orcaModelRouter(pi: ExtensionAPI): void {
    if (!isOrcaPane()) return

    pi.on('before_agent_start', async (event, ctx) => {
      const coordinator = await readCoordinatorState(pi, cliPath, timeoutMs, ctx.cwd)
      if (coordinator.state === 'inactive') return

      let directive: string
      if (coordinator.state === 'failed') {
        directive = renderFailureDirective(coordinator.reason ?? 'unknown error')
      } else {
        const routing = resolveRoutes(ctx, routes)
        directive = routing.state === 'ready'
          ? renderRoutingDirective(routing.routes ?? [])
          : renderFailureDirective(routing.reason ?? 'unknown model resolution error')
      }
      const currentPrompt: string | string[] = event.systemPrompt
      const systemPrompt = Array.isArray(currentPrompt)
        ? [...currentPrompt, directive]
        : `${currentPrompt}\n\n${directive}`
      const compatibleResult = { systemPrompt }

      // Pi changed systemPrompt from string to string[]; this preserves both host contracts.
      return compatibleResult as never
    })

    pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'bash' || typeof event.input.command !== 'string') return
      const workerStarts = findOrcaCommands(event.input.command, 'worker-start')
        .filter(candidate => !hasShellFlag(candidate.segment, '--help'))
      if (workerStarts.length === 0) return

      const coordinator = await readCoordinatorState(pi, cliPath, timeoutMs, ctx.cwd)
      if (coordinator.state === 'inactive') return
      if (coordinator.state === 'failed') {
        return {
          block: true,
          reason: `Orca model router could not verify coordinator state: ${coordinator.reason ?? 'unknown error'}`,
        }
      }
      if (workerStarts.length !== 1) {
        return {
          block: true,
          reason: 'Orca model router requires one worker-start per Bash call so its route can be verified.',
        }
      }

      const workerStart = workerStarts[0]
      if (!workerStart || readShellFlag(workerStart.segment, '--terminal')) return

      const routing = resolveRoutes(ctx, routes)
      if (routing.state === 'failed') {
        return {
          block: true,
          reason: `Orca model router could not resolve the OMP model policy: ${routing.reason ?? 'unknown error'}`,
        }
      }

      const resolvedRoutes = routing.routes ?? []
      const agent = readShellFlag(workerStart.segment, '--agent')
      const model = readShellFlag(workerStart.segment, '--model')
      if (!agent || !model) {
        return {
          block: true,
          reason: renderBlockReason(resolvedRoutes, agent, model),
        }
      }

      if (model.startsWith('@')) {
        if (agent !== 'omp') {
          return {
            block: true,
            reason: `Blocked fresh Orca worker: OMP model role ${model} requires --agent omp.`,
          }
        }
        const selected = resolveModelSpec(ctx, model)
        return {
          block: true,
          reason: selected
            ? `Blocked fresh OMP worker: ${model} currently resolves to ${selected}; pass that concrete model so Orca can verify the launch receipt.`
            : `Blocked fresh OMP worker: model role ${model} does not resolve through the current OMP model registry.`,
        }
      }

      if (agent === 'omp' && !resolveModelSpec(ctx, model)) {
        return {
          block: true,
          reason: `Blocked fresh OMP worker: model spec ${model} does not resolve through the current OMP model registry.`,
        }
      }

      return
    })
  }
}

async function readCoordinatorState(
  pi: ExtensionAPI,
  cliPath: string,
  timeoutMs: number,
  cwd: string,
): Promise<CoordinatorState> {
  let result: CommandResult
  try {
    result = await pi.exec(
      cliPath,
      ['orchestration', 'run-current', '--json'],
      { timeout: timeoutMs, cwd },
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { state: 'failed', reason: truncate(detail) }
  }

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`
    return { state: 'failed', reason: truncate(detail) }
  }

  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    return { state: 'failed', reason: 'Orca CLI returned invalid JSON' }
  }

  if (!isUnknownRecord(value) || value.ok !== true) {
    return { state: 'failed', reason: 'Orca CLI returned an unsuccessful response' }
  }
  const resultValue = value.result
  if (!isUnknownRecord(resultValue)) {
    return { state: 'failed', reason: 'run-current returned no result' }
  }
  if (resultValue.run === null) return { state: 'inactive' }
  if (!isUnknownRecord(resultValue.run) || typeof resultValue.run.id !== 'string') {
    return { state: 'failed', reason: 'run-current returned an invalid Run' }
  }
  return { state: 'active' }
}

function resolveRoutes(ctx: unknown, routes: readonly OrcaModelRoute[]): RoutingState {
  const cache = new Map<string, string>()
  const resolved: ResolvedOrcaModelRoute[] = []

  try {
    for (const route of routes) {
      let effectiveModel = cache.get(route.modelRole)
      if (!effectiveModel) {
        effectiveModel = resolveModelSpec(ctx, route.modelRole)
        if (!effectiveModel) {
          return {
            state: 'failed',
            reason: `OMP model role ${route.modelRole} did not resolve to an available model`,
          }
        }
        cache.set(route.modelRole, effectiveModel)
      }
      resolved.push({ ...route, effectiveModel })
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { state: 'failed', reason: truncate(detail) }
  }

  return { state: 'ready', routes: resolved }
}

function resolveModelSpec(ctx: unknown, spec: string): string | undefined {
  if (!isUnknownRecord(ctx) || !isUnknownRecord(ctx.models)) return undefined
  const resolve = ctx.models.resolve
  if (typeof resolve !== 'function') return undefined
  const model: unknown = resolve.call(ctx.models, spec)
  if (!isUnknownRecord(model)) return undefined
  if (typeof model.provider !== 'string' || !model.provider.trim()) return undefined
  if (typeof model.id !== 'string' || !model.id.trim()) return undefined
  return `${model.provider}/${model.id}`
}

function renderRoutingDirective(routes: readonly ResolvedOrcaModelRoute[]): string {
  const rows = routes
    .map(route => `- ${route.taskClass} (${route.modelRole}): --agent omp --model ${route.effectiveModel}`)
    .join('\n')
  return [
    '[Orca model router]',
    'Every fresh Orca worker MUST name both --agent and --model. Never inherit an Orca agent default.',
    'OMP resolved each responsibility role through its current configured model candidates. Pass the concrete result shown:',
    rows,
    'OMP 18.10.3 treats a CLI model override as the child default role, so runtime retries use retry.fallbackChains.default.',
    'After worker-start, verify launch.requested.model and launch.effective.model equal the selected concrete model.',
    'A reused --terminal keeps its existing model; reuse it only when that effective route still matches the task.',
  ].join('\n')
}

function renderFailureDirective(reason: string): string {
  return [
    '[Orca model router]',
    `Coordinator model policy could not be verified: ${reason}`,
    'Do not start a fresh Orca worker until both run-current and OMP model resolution succeed.',
  ].join('\n')
}

function renderBlockReason(
  routes: readonly ResolvedOrcaModelRoute[],
  agent: string | undefined,
  model: string | undefined,
): string {
  const missing = [!agent ? '--agent' : undefined, !model ? '--model' : undefined]
    .filter(Boolean)
    .join(' and ')
  const rows = routes
    .map(route => `${route.taskClass}=${route.effectiveModel} (from ${route.modelRole})`)
    .join(', ')
  return `Blocked fresh Orca worker: explicit ${missing} required. Prefer --agent omp and the current OMP-resolved model: ${rows}`
}

function truncate(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact
}

export default createOrcaModelRouter()
