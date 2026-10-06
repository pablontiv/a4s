#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCHEMA = 'a4s.otel.rca.log.v1'
const SERVICE_NAME = '@a4s/synagent-bus'
const LOG_FILE_NAME = 'operational.jsonl'
const ERROR_PHASES = new Set([
  'arguments',
  'db.open',
  'ensure',
  'lock.acquire',
  'lock.release',
  'pane.close',
  'pane.get',
  'pane.open',
  'pane.process_info',
  'port.listen',
  'readiness.mqtt',
  'readiness.tcp',
  'state.read',
  'state.write',
  'shutdown',
  'tab.close',
  'tab.get',
  'tab.rename',
  'workspace.create',
  'workspace.list',
  'workspace.validate',
])
const SEVERITY_NUMBER = Object.freeze({
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
})

function stateHome({ env = process.env, home = os.homedir() } = {}) {
  return env.XDG_STATE_HOME || path.join(home, '.local', 'state')
}

function safeIdentifier(value, fallback) {
  const raw = typeof value === 'string' ? value : ''
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  const safe = trimmed.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 96)
  return !safe || safe === '.' || safe === '..' ? fallback : safe
}

function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return crypto.randomBytes(16).toString('hex')
}

function hostIdHash(hostname = os.hostname()) {
  return crypto.createHash('sha256').update(String(hostname)).digest('hex').slice(0, 32)
}

function defaultLogRoot({ env = process.env, home = os.homedir() } = {}) {
  return path.resolve(env.A4S_SYNAGENT_BUS_LOG_DIR ||
    path.join(stateHome({ env, home }), 'a4s', 'log', 'synagent-bus'))
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function defaultLogDir({ env = process.env, home = os.homedir(), instanceId } = {}) {
  const base = defaultLogRoot({ env, home })
  const component = safeIdentifier(instanceId, 'unknown-instance')
  const candidate = path.resolve(base, component)
  return isContained(base, candidate) ? candidate : path.join(base, 'unknown-instance')
}

function tagOperationalError(error, code, { phase, retryable = false } = {}) {
  const target = error instanceof Error ? error : new Error('operational failure')
  for (const [name, value] of [
    ['a4sCode', code],
    ['a4sPhase', ERROR_PHASES.has(phase) ? phase : 'ensure'],
    ['retryable', Boolean(retryable)],
  ]) {
    Object.defineProperty(target, name, { configurable: true, value, writable: true })
  }
  return target
}

function operationalError(code, message, { cause, phase, retryable = false } = {}) {
  return tagOperationalError(
    new Error(message, cause ? { cause } : undefined),
    code,
    { phase, retryable },
  )
}

function classifyError(error, source, { code: explicitCode, phase: explicitPhase, retryable } = {}) {
  const code = safeIdentifier(explicitCode || error?.a4sCode || error?.code, 'UNCLASSIFIED')
  const type = safeIdentifier(error?.name, 'Error')
  const inferredRetryable = retryable !== undefined
    ? Boolean(retryable)
    : typeof error?.retryable === 'boolean'
      ? error.retryable
      : ['EADDRINUSE', 'ECONNREFUSED', 'ETIMEDOUT', 'EAGAIN', 'EBUSY'].includes(code)
  const phase = explicitPhase || error?.a4sPhase
  return {
    type,
    code,
    source: safeIdentifier(source, 'unknown'),
    retryable: inferredRetryable,
    ...(ERROR_PHASES.has(phase) ? { phase } : {}),
  }
}

function cleanString(value, fallback, maximum = 160) {
  if (typeof value !== 'string') return fallback
  const oneLine = value.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '')
  const trimmed = oneLine.trim()
  return trimmed ? trimmed.slice(0, maximum) : fallback
}

function cleanBoolean(value) {
  return Boolean(value)
}

function cleanFiniteNumber(value) {
  return Number.isFinite(value) ? value : undefined
}

function cleanAttributeValue(value) {
  if (typeof value === 'string') return cleanString(value, 'redacted')
  if (typeof value === 'boolean') return value
  if (Number.isFinite(value)) return value
  if (value === null) return null
  return undefined
}

function createLogger({
  env = process.env,
  home = os.homedir(),
  now = () => new Date(),
  scopeName = 'a4s.synagent-bus',
  harnessName = 'a4s',
  harnessKind = 'node-cli',
  harnessRole = 'worker',
  instanceId = safeIdentifier(env.A4S_SERVICE_INSTANCE_ID, `${process.pid}-${newId()}`),
  operationId = safeIdentifier(env.A4S_OPERATION_ID, newId()),
  correlationId = safeIdentifier(env.A4S_CORRELATION_ID, operationId),
  hostname = os.hostname(),
} = {}) {
  const serviceInstanceId = safeIdentifier(instanceId, `${process.pid}-${newId()}`)
  const root = defaultLogRoot({ env, home })
  const directory = defaultLogDir({ env, home, instanceId: serviceInstanceId })
  const file = path.join(directory, LOG_FILE_NAME)
  let fd = null
  let closed = false
  let droppedCount = 0

  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    if (!fs.statSync(root).isDirectory()) throw new Error('log root is not a directory')
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const directoryStat = fs.lstatSync(directory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('log instance path is not a real directory')
    }
    fs.chmodSync(directory, 0o700)

    const realRoot = fs.realpathSync(root)
    const realDirectory = fs.realpathSync(directory)
    if (!isContained(realRoot, realDirectory)) throw new Error('log instance escaped its real root')

    let existingStat
    try {
      existingStat = fs.lstatSync(file)
      if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
        throw new Error('log path is not a regular file')
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow
    fd = fs.openSync(file, flags, 0o600)
    const openedStat = fs.fstatSync(fd)
    if (!openedStat.isFile()) throw new Error('opened log is not a regular file')
    if (existingStat && (existingStat.dev !== openedStat.dev || existingStat.ino !== openedStat.ino)) {
      throw new Error('log file changed while opening')
    }
    fs.fchmodSync(fd, 0o600)
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
      fd = null
    }
    droppedCount += 1
  }

  function record(eventName, {
    severityText = 'INFO',
    body = eventName,
    attributes = {},
    protocol,
    error,
    flushStatus = 'not_requested',
    operation = operationId,
    correlation = correlationId,
  } = {}) {
    if (closed) {
      droppedCount += 1
      return false
    }

    const severity = SEVERITY_NUMBER[severityText] ? severityText : 'INFO'
    const line = {
      schema: SCHEMA,
      timestamp: now().toISOString(),
      severity_text: severity,
      severity_number: SEVERITY_NUMBER[severity],
      event_name: cleanString(eventName, 'unknown.event'),
      body: cleanString(body, cleanString(eventName, 'event')),
      'resource.service.name': SERVICE_NAME,
      'resource.service.instance.id': serviceInstanceId,
      'resource.host.id_hash': hostIdHash(hostname),
      'resource.a4s.harness.name': cleanString(harnessName, 'a4s'),
      'resource.a4s.harness.kind': cleanString(harnessKind, 'node-cli'),
      'resource.a4s.harness.role': cleanString(harnessRole, 'worker'),
      'scope.name': cleanString(scopeName, 'a4s.synagent-bus'),
      'attributes.a4s.correlation_id': safeIdentifier(correlation, operationId),
      'attributes.a4s.operation_id': safeIdentifier(operation, operationId),
      'a4s.logging.lossy': droppedCount > 0,
      'a4s.logging.dropped_count': droppedCount,
      'a4s.logging.flush_status': cleanString(flushStatus, 'not_requested'),
    }

    if (protocol) {
      line['a4s.protocol.channel'] = cleanString(protocol.channel, 'unknown')
      line['a4s.protocol.contaminated'] = cleanBoolean(protocol.contaminated)
    }

    if (error) {
      line['error.type'] = cleanString(error.type, 'Error')
      line['error.code'] = cleanString(error.code, 'UNCLASSIFIED')
      line['error.source'] = cleanString(error.source, 'unknown')
      line['error.retryable'] = cleanBoolean(error.retryable)
      if (ERROR_PHASES.has(error.phase)) line['error.phase'] = error.phase
    }

    for (const [key, value] of Object.entries(attributes)) {
      if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(key)) continue
      const clean = cleanAttributeValue(value)
      if (clean !== undefined) line[key] = clean
    }

    try {
      if (fd === null) throw new Error('log file unavailable')
      fs.writeSync(fd, `${JSON.stringify(line)}\n`)
      return true
    } catch {
      droppedCount += 1
      return false
    }
  }

  function close() {
    if (closed) return
    closed = true
    if (fd === null) return
    try {
      fs.fsyncSync(fd)
    } catch {
      droppedCount += 1
    } finally {
      try { fs.closeSync(fd) } catch {}
      fd = null
    }
  }

  return {
    file,
    instanceId: serviceInstanceId,
    operationId,
    correlationId,
    log: record,
    info(eventName, options) { return record(eventName, { ...options, severityText: 'INFO' }) },
    warn(eventName, options) { return record(eventName, { ...options, severityText: 'WARN' }) },
    error(eventName, options) { return record(eventName, { ...options, severityText: 'ERROR' }) },
    close,
  }
}

module.exports = {
  SCHEMA,
  SERVICE_NAME,
  SEVERITY_NUMBER,
  classifyError,
  createLogger,
  defaultLogDir,
  defaultLogRoot,
  hostIdHash,
  operationalError,
  stateHome,
  tagOperationalError,
}
