import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DIAGNOSTIC_SCHEMA = 'a4s.log/1'
export const DIAGNOSTIC_SERVICE = '@a4s/synagent'
export const DIAGNOSTIC_FILE_QUOTA_BYTES = 16 * 1024 * 1024

const FILE_NAME = 'operational.jsonl'
const SEVERITY_NUMBER = Object.freeze({
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
})

type Severity = keyof typeof SEVERITY_NUMBER

export type DiagnosticError = {
  code: string
  phase: string
  retryable: boolean
  source: string
  type: string
}

export type DiagnosticEvent = {
  correlationId?: string
  deliveryMode?: 'idle' | 'steer' | 'followUp'
  destinationScope?: 'direct' | 'project' | 'global' | 'invalid'
  error?: DiagnosticError
  generation?: number
  messageId?: string
  messageKind?: string
  operation: string
  queueDepth?: number
  role?: string
  severity?: Severity
  timeoutMs?: number
}

export type DiagnosticsOptions = {
  componentName?: string
  env?: NodeJS.ProcessEnv
  harnessName: string
  home?: string
  hostname?: string
  instanceId: string
  now?: () => Date
  operationId?: string
  scopeName?: string
}

export type Diagnostics = {
  close(): void
  file: string
  instanceId: string
  record(eventName: string, event: DiagnosticEvent): boolean
}

export function digestIdentifier(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export function classifyDiagnosticError(
  error: unknown,
  code: string,
  phase: string,
  retryable: boolean,
  source: string,
): DiagnosticError {
  void error
  return {
    code: cleanIdentifier(code, 'UNCLASSIFIED'),
    phase: cleanIdentifier(phase, 'unknown'),
    retryable,
    source: cleanIdentifier(source, 'unknown'),
    type: 'Error',
  }
}

export function defaultDiagnosticRoot({
  env = process.env,
  home = os.homedir(),
  harnessName,
  componentName,
}: Pick<DiagnosticsOptions, 'componentName' | 'env' | 'home' | 'harnessName'>): string {
  const stateRoot = env.A4S_STATE_ROOT
    ? path.resolve(env.A4S_STATE_ROOT)
    : path.resolve(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'a4s')
  return path.join(stateRoot, 'log', 'synagent', cleanIdentifier(componentName ?? harnessName, 'unknown-adapter'))
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  try {
    return createDiagnosticsUnsafe(options)
  } catch {
    return {
      close() {},
      file: '',
      instanceId: 'unavailable',
      record() { return false },
    }
  }
}

function createDiagnosticsUnsafe({
  env = process.env,
  harnessName,
  componentName = harnessName,
  home = os.homedir(),
  hostname = os.hostname(),
  instanceId,
  now = () => new Date(),
  operationId = crypto.randomUUID(),
  scopeName = `a4s.synagent.${harnessName}`,
}: DiagnosticsOptions): Diagnostics {
  const rawStateRoot = env.A4S_STATE_ROOT
    ? path.resolve(env.A4S_STATE_ROOT)
    : path.resolve(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'a4s')
  const root = defaultDiagnosticRoot({ componentName, env, home, harnessName })
  const safeComponentName = cleanIdentifier(componentName, 'adapter')
  const serviceInstanceId = `${safeComponentName}-${digestIdentifier(instanceId).slice(0, 32)}`
  const directory = path.join(root, serviceInstanceId)
  const file = path.join(directory, FILE_NAME)
  const stableOperationId = cleanIdentifier(operationId, crypto.randomUUID())
  const hostHash = digestIdentifier(hostname).slice(0, 32)
  let descriptor: number | undefined
  let closed = false
  let droppedCount = 0
  let fileBytes = 0
  let quotaReached = false
  let writerFailed = false

  try {
    ensureDirectory(rawStateRoot, false)
    let current = rawStateRoot
    for (const component of ['log', 'synagent', safeComponentName]) {
      current = path.join(current, component)
      ensureDirectory(current, true)
    }
    ensureDirectory(directory, true)

    const realStateRoot = fs.realpathSync(rawStateRoot)
    const realDirectory = fs.realpathSync(directory)
    if (!isContained(realStateRoot, realDirectory)) throw new Error('diagnostic directory escaped state root')

    let existing: fs.Stats | undefined
    try {
      existing = fs.lstatSync(file)
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('diagnostic path is not a regular file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0
    descriptor = fs.openSync(
      file,
      fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow,
      0o600,
    )
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile()) throw new Error('opened diagnostic path is not a regular file')
    if (existing && (existing.dev !== opened.dev || existing.ino !== opened.ino)) {
      throw new Error('diagnostic file changed while opening')
    }
    fs.fchmodSync(descriptor, 0o600)
    fileBytes = opened.size
    quotaReached = fileBytes >= DIAGNOSTIC_FILE_QUOTA_BYTES
  } catch {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
      descriptor = undefined
    }
    droppedCount += 1
  }

  function record(eventName: string, event: DiagnosticEvent): boolean {
    if (closed || quotaReached || writerFailed) {
      droppedCount += 1
      return false
    }

    try {
      const severity = event.severity && SEVERITY_NUMBER[event.severity] ? event.severity : 'INFO'
      const messageHash = event.messageId ? digestIdentifier(event.messageId) : undefined
      const correlationId = event.correlationId
        ?? (messageHash ? `message-${messageHash.slice(0, 32)}` : stableOperationId)
      const line: Record<string, boolean | number | string> = {
        schema: DIAGNOSTIC_SCHEMA,
        timestamp: now().toISOString(),
        severity_text: severity,
        severity_number: SEVERITY_NUMBER[severity],
        event_name: cleanText(eventName, 'synagent.unknown'),
        body: cleanText(eventName, 'synagent.unknown'),
        'resource.service.name': DIAGNOSTIC_SERVICE,
        'resource.service.instance.id': serviceInstanceId,
        'resource.host.id_hash': hostHash,
        'resource.a4s.harness.name': cleanIdentifier(harnessName, 'unknown-harness'),
        'resource.a4s.harness.kind': 'agent-harness',
        'resource.a4s.harness.role': 'channel-adapter',
        'scope.name': cleanIdentifier(scopeName, 'a4s.synagent'),
        'attributes.a4s.correlation_id': cleanIdentifier(correlationId, stableOperationId),
        'attributes.a4s.operation_id': stableOperationId,
        'attributes.a4s.operation': cleanIdentifier(event.operation, 'unknown'),
        'a4s.logging.lossy': droppedCount > 0,
        'a4s.logging.dropped_count': droppedCount,
        'a4s.logging.flush_status': 'not_requested',
      }

      if (messageHash) line['messaging.message.id_hash'] = messageHash
      if (event.messageKind) line['messaging.message.kind'] = cleanIdentifier(event.messageKind, 'unknown')
      if (event.destinationScope) line['messaging.destination.scope'] = event.destinationScope
      if (event.deliveryMode) line['a4s.delivery.mode'] = event.deliveryMode
      if (event.role) line['a4s.client.role'] = cleanIdentifier(event.role, 'unknown')
      if (Number.isFinite(event.generation)) line['a4s.connection.generation'] = event.generation as number
      if (Number.isFinite(event.queueDepth)) line['a4s.queue.depth'] = event.queueDepth as number
      if (Number.isFinite(event.timeoutMs)) line['a4s.timeout.ms'] = event.timeoutMs as number
      if (event.error) {
        line['error.type'] = 'Error'
        line['error.code'] = cleanIdentifier(event.error.code, 'UNCLASSIFIED')
        line['error.phase'] = cleanIdentifier(event.error.phase, 'unknown')
        line['error.retryable'] = Boolean(event.error.retryable)
        line['error.source'] = cleanIdentifier(event.error.source, 'unknown')
      }

      const bytes = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')
      if (fileBytes + bytes.length > DIAGNOSTIC_FILE_QUOTA_BYTES) {
        quotaReached = true
        droppedCount += 1
        return false
      }
      if (descriptor === undefined) throw new Error('diagnostic file unavailable')

      try {
        let offset = 0
        let attempts = 0
        while (offset < bytes.length && attempts < bytes.length) {
          const remaining = bytes.length - offset
          const written = fs.writeSync(descriptor, bytes, offset, remaining)
          if (!Number.isInteger(written) || written <= 0 || written > remaining) {
            throw new Error('diagnostic write made no progress')
          }
          offset += written
          fileBytes += written
          attempts += 1
        }
        if (offset !== bytes.length) throw new Error('diagnostic write was incomplete')
        return true
      } catch (error) {
        writerFailed = true
        throw error
      }
    } catch {
      droppedCount += 1
      return false
    }
  }

  function close(): void {
    if (closed) return
    closed = true
    if (descriptor === undefined) return
    try {
      fs.fsyncSync(descriptor)
    } catch {
      droppedCount += 1
    } finally {
      try { fs.closeSync(descriptor) } catch {}
      descriptor = undefined
    }
  }

  return { close, file, instanceId: serviceInstanceId, record }
}

function ensureDirectory(directory: string, enforcePrivateMode: boolean): void {
  try {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      } else {
        throw error
      }
    }
  }
  const stat = fs.lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('diagnostic path is not a real directory')
  if (enforcePrivateMode) fs.chmodSync(directory, 0o700)
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function cleanIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const clean = value.trim().replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 160)
  return clean && clean !== '.' && clean !== '..' ? clean : fallback
}

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean ? clean.slice(0, 160) : fallback
}
