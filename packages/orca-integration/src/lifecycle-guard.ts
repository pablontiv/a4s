import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { findOrcaCommands, hasShellFlag, readShellFlag } from './orca-command.ts'
import { resolveOrcaCliPath } from './orca-cli.ts'
import { isUnknownRecord } from './type-guards.ts'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_WORKERS = 100
const GUARD_MESSAGE_TYPE = 'a4s.orca-lifecycle-guard'

export interface OrcaLifecycleGuardOptions {
  cliPath?: string
  isOrcaPane?: () => boolean
  timeoutMs?: number
}

interface ReclaimableWorker {
  dispatchId: string
  taskId?: string
  terminalHandle?: string
  nextActionArgv: string[]
}

interface PendingInventory {
  state: 'pending'
  runId: string
  total: number
  workers: ReclaimableWorker[]
  nextCursor?: string
}

interface ClearInventory {
  state: 'clear'
  runId: string
}

interface InactiveInventory {
  state: 'inactive'
}

interface FailedInventory {
  state: 'failed'
  reason: string
}

type Inventory = PendingInventory | ClearInventory | InactiveInventory | FailedInventory

interface CommandResult {
  stdout: string
  stderr: string
  code: number
  killed: boolean
}

export function createOrcaLifecycleGuard(options: OrcaLifecycleGuardOptions = {}) {
  const cliPath = options.cliPath ?? resolveOrcaCliPath()
  const isOrcaPane = options.isOrcaPane ?? (() => Boolean(process.env.ORCA_PANE_KEY?.trim()))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return function orcaLifecycleGuard(pi: ExtensionAPI): void {
    if (!isOrcaPane()) return

    let continuedInventoryKey: string | undefined

    pi.on('session_start', async () => {
      continuedInventoryKey = undefined
    })

    pi.on('before_agent_start', async (event, ctx) => {
      const inventory = await readInventory(pi, cliPath, timeoutMs, ctx.cwd)
      if (inventory.state === 'inactive') return
      if (inventory.state === 'clear') {
        continuedInventoryKey = undefined
        return
      }

      const directive = inventory.state === 'failed'
        ? renderFailureDirective(inventory.reason)
        : renderPendingDirective(inventory)

      const currentPrompt: string | string[] = event.systemPrompt
      const systemPrompt = Array.isArray(currentPrompt)
        ? [...currentPrompt, directive]
        : `${currentPrompt}\n\n${directive}`
      const compatibleResult = { systemPrompt }

      // Pi changed systemPrompt from string to string[]; this preserves both host contracts.
      return compatibleResult as never
    })

    pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'bash') return
      const command = readString(event.input, 'command')
      if (!command) return

      const operation = classifyGuardedCommand(command)
      if (!operation) return

      const inventory = await readInventory(pi, cliPath, timeoutMs, ctx.cwd)
      if (inventory.state === 'inactive' || inventory.state === 'clear') return
      if (inventory.state === 'failed') {
        return {
          block: true,
          reason: `Orca lifecycle guard could not verify coordinator worker state: ${inventory.reason}`,
        }
      }

      if (operation.kind === 'worker-start' && operation.reuseTerminal) {
        const isExactReuse = inventory.workers.some(
          worker => worker.terminalHandle === operation.reuseTerminal,
        )
        if (isExactReuse) return
      }

      return {
        block: true,
        reason: renderBlockReason(inventory, operation.kind),
      }
    })

    pi.on('agent_end', async (event, ctx) => {
      if ('willContinue' in event && event.willContinue === true) return

      const inventory = await readInventory(pi, cliPath, timeoutMs, ctx.cwd)
      if (inventory.state === 'inactive' || inventory.state === 'failed') return
      if (inventory.state === 'clear') {
        continuedInventoryKey = undefined
        return
      }
      const inventoryKey = pendingInventoryKey(inventory)
      if (continuedInventoryKey === inventoryKey) return

      continuedInventoryKey = inventoryKey
      await Promise.resolve(pi.sendMessage(
        {
          customType: GUARD_MESSAGE_TYPE,
          content: renderPendingDirective(inventory),
          display: true,
        },
        { triggerTurn: true },
      ))
    })
  }
}

async function readInventory(
  pi: ExtensionAPI,
  cliPath: string,
  timeoutMs: number,
  cwd: string,
): Promise<Inventory> {
  const current = await executeJson(
    pi,
    cliPath,
    ['orchestration', 'run-current', '--json'],
    timeoutMs,
    cwd,
  )
  if (!current.ok) return { state: 'failed', reason: current.reason }

  const currentResult = readRecord(current.value, 'result')
  if (!currentResult) return { state: 'failed', reason: 'run-current returned no result' }
  if (currentResult.run === null) return { state: 'inactive' }
  const run = readRecord(currentResult, 'run')
  if (!run) return { state: 'failed', reason: 'run-current returned an invalid Run' }
  const runId = readString(run, 'id')
  if (!runId) return { state: 'failed', reason: 'run-current returned a Run without an id' }

  const listed = await executeJson(
    pi,
    cliPath,
    [
      'orchestration',
      'worker-list',
      '--run',
      runId,
      '--terminal-state',
      'reclaimable',
      '--include-remote',
      '--limit',
      String(MAX_WORKERS),
      '--json',
    ],
    timeoutMs,
    cwd,
  )
  if (!listed.ok) return { state: 'failed', reason: listed.reason }

  const result = readRecord(listed.value, 'result')
  const partialHostErrors = result?.partialHostErrors
  if (partialHostErrors !== undefined && !Array.isArray(partialHostErrors)) {
    return { state: 'failed', reason: 'worker-list returned invalid partial host errors' }
  }
  if (Array.isArray(partialHostErrors) && partialHostErrors.length > 0) {
    return {
      state: 'failed',
      reason: `worker-list reported ${partialHostErrors.length} partial host error(s)`,
    }
  }

  const rawWorkers = result?.workers
  if (!Array.isArray(rawWorkers)) {
    return { state: 'failed', reason: 'worker-list returned no workers array' }
  }
  const workers = rawWorkers.flatMap((value): ReclaimableWorker[] => {
    if (!isUnknownRecord(value)) return []
    const dispatchId = readString(value, 'dispatchId')
    if (!dispatchId) return []

    const resource = readRecord(value, 'resource')
    const projection = readRecord(value, 'projection')
    const nextAction = readRecord(projection, 'nextAction')
    const rawArgv = nextAction?.argv
    const nextActionArgv = Array.isArray(rawArgv) && rawArgv.every(item => typeof item === 'string')
      ? rawArgv
      : []
    const taskId = readString(value, 'taskId')
    const terminalHandle = readString(resource, 'terminalHandle')
      ?? readString(value, 'agentTerminalHandle')

    return [{
      dispatchId,
      ...(taskId ? { taskId } : {}),
      ...(terminalHandle ? { terminalHandle } : {}),
      nextActionArgv,
    }]
  })

  if (rawWorkers.length > 0 && workers.length === 0) {
    return { state: 'failed', reason: 'worker-list returned workers without dispatch ids' }
  }

  const page = readRecord(result, 'page')
  const hasMore = page?.hasMore === true
  const nextCursor = readString(page, 'nextCursor')
  if (hasMore && !nextCursor) {
    return { state: 'failed', reason: 'worker-list reported another page without a cursor' }
  }
  if (workers.length === 0) return { state: 'clear', runId }

  const rawTotal = page?.total
  const reportedTotal = typeof rawTotal === 'number' && Number.isFinite(rawTotal)
    ? rawTotal
    : undefined
  return {
    state: 'pending',
    runId,
    total: reportedTotal !== undefined && reportedTotal >= workers.length
      ? reportedTotal
      : workers.length,
    workers,
    ...(nextCursor ? { nextCursor } : {}),
  }
}

async function executeJson(
  pi: ExtensionAPI,
  cliPath: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  let result: CommandResult
  try {
    result = await pi.exec(cliPath, args, { timeout: timeoutMs, cwd })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: truncate(detail) }
  }

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`
    return { ok: false, reason: truncate(detail) }
  }

  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    return { ok: false, reason: 'Orca CLI returned invalid JSON' }
  }

  if (!isUnknownRecord(value) || value.ok !== true) {
    return { ok: false, reason: 'Orca CLI returned an unsuccessful response' }
  }
  return { ok: true, value }
}

function classifyGuardedCommand(
  command: string,
): { kind: 'check --ack' } | { kind: 'worker-start'; reuseTerminal?: string } | undefined {
  const acknowledges = findOrcaCommands(command, 'check')
    .some(candidate => hasShellFlag(candidate.segment, '--ack'))
  if (acknowledges) return { kind: 'check --ack' }

  const starts = findOrcaCommands(command, 'worker-start')
    .filter(candidate => !hasShellFlag(candidate.segment, '--help'))
  if (starts.length === 0) return undefined
  if (starts.length !== 1) return { kind: 'worker-start' }

  const reuseTerminal = readShellFlag(starts[0]?.segment ?? '', '--terminal')
  return { kind: 'worker-start', ...(reuseTerminal ? { reuseTerminal } : {}) }
}

function renderPendingDirective(inventory: PendingInventory): string {
  const shown = inventory.workers.length
  const more = inventory.nextCursor
    ? `; showing ${shown}, with another page available`
    : inventory.total > shown
      ? `; showing ${shown}, with additional workers reported`
      : ''
  const actions = inventory.workers.map(worker => {
    const identity = [worker.dispatchId, worker.taskId, worker.terminalHandle].filter(Boolean).join(' · ')
    const action = worker.nextActionArgv.length > 0
      ? JSON.stringify(worker.nextActionArgv)
      : '[] (projection supplied no action; inspect this worker before proceeding)'
    return `- ${identity}\n  nextAction.argv: ${action}`
  }).join('\n')
  const nextPage = inventory.nextCursor
    ? `Next page argv: ${JSON.stringify([
      'orchestration',
      'worker-list',
      '--run',
      inventory.runId,
      '--terminal-state',
      'reclaimable',
      '--include-remote',
      '--limit',
      String(MAX_WORKERS),
      '--cursor',
      inventory.nextCursor,
      '--json',
    ])}`
    : undefined

  return [
    '[Orca lifecycle guard]',
    `Run ${inventory.runId} has ${inventory.total} reclaimable worker(s)${more}.`,
    'Resolve every worker before acknowledging inbox deliveries or starting a fresh worker.',
    'For each row, execute its projected nextAction argv with the resolved Orca CLI, or reuse that exact terminal when the task truly continues.',
    actions,
    nextPage,
    'Re-run `orca orchestration worker-list --terminal-state reclaimable --json` after acting. Do not stop while reclaimable workers remain.',
  ].filter((line): line is string => line !== undefined).join('\n')
}

function pendingInventoryKey(inventory: PendingInventory): string {
  return [
    inventory.runId,
    inventory.total,
    inventory.nextCursor ?? '',
    ...inventory.workers.map(worker => worker.dispatchId),
  ].join('\u0000')
}

function renderFailureDirective(reason: string): string {
  return [
    '[Orca lifecycle guard]',
    `Worker lifecycle state could not be verified: ${reason}`,
    'Do not run `orca orchestration check --ack` or start a worker until the read-only inventory succeeds.',
  ].join('\n')
}

function renderBlockReason(inventory: PendingInventory, operation: 'check --ack' | 'worker-start'): string {
  const rows = inventory.workers
    .map(worker => `${worker.dispatchId}: ${JSON.stringify(worker.nextActionArgv)}`)
    .join('; ')
  return `Blocked Orca orchestration ${operation}: Run ${inventory.runId} has ${inventory.total} reclaimable worker(s). Resolve projected actions first: ${rows}`
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isUnknownRecord(value)) return undefined
  const nested = value[key]
  return isUnknownRecord(nested) ? nested : undefined
}

function readString(value: unknown, key: string): string | undefined {
  if (!isUnknownRecord(value)) return undefined
  const nested = value[key]
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined
}

function truncate(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact
}

export default createOrcaLifecycleGuard()
