import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  classifyDiagnosticError,
  createDiagnostics,
  defaultDiagnosticRoot,
  DIAGNOSTIC_FILE_QUOTA_BYTES,
  DIAGNOSTIC_SCHEMA,
  digestIdentifier,
} from '../diagnostics.ts'

function readJsonLines(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

test('diagnostics writes private JSONL with RCA fields and no sensitive input', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synagent-pi-diagnostics-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const env = { A4S_STATE_ROOT: temp }
  const rawSession = 'Session.Raw.Secret'
  const rawMessage = 'message-secret-payload-token-topic-address-url-clientId-env-argv'
  let stdoutWrites = 0
  let stderrWrites = 0
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  process.stdout.write = ((..._args: unknown[]) => { stdoutWrites += 1; return true }) as typeof process.stdout.write
  process.stderr.write = ((..._args: unknown[]) => { stderrWrites += 1; return true }) as typeof process.stderr.write
  let logger: ReturnType<typeof createDiagnostics>
  try {
    logger = createDiagnostics({
      env,
      harnessName: 'pion',
      hostname: 'host-secret',
      instanceId: rawSession,
      now: () => new Date('2026-01-02T03:04:05.678Z'),
      operationId: 'operation-fixture',
      scopeName: 'a4s.synagent.pi',
    })
    const secretError = new Error('prompt response transcript body must stay private')
    secretError.name = 'SecretToken'
    assert.equal(logger.record('synagent.pi.message.rejected', {
      operation: 'message.receive',
      messageId: rawMessage,
      messageKind: 'notify',
      destinationScope: 'direct',
      queueDepth: 2,
      generation: 4,
      role: 'durable',
      deliveryMode: 'followUp',
      timeoutMs: 123,
      severity: 'ERROR',
      error: classifyDiagnosticError(
        secretError,
        'MESSAGE_INVALID',
        'message.receive',
        false,
        'protocol.parse',
      ),
    }), true)
    logger.close()
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }

  assert.equal(stdoutWrites, 0)
  assert.equal(stderrWrites, 0)
  assert.equal(path.dirname(path.dirname(logger.file)), defaultDiagnosticRoot({ env, harnessName: 'pion' }))
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(logger.file)).mode & 0o777, 0o700)
    assert.equal(fs.statSync(logger.file).mode & 0o777, 0o600)
  }

  const [record] = readJsonLines(logger.file)
  assert.ok(record)
  assert.equal(record.schema, DIAGNOSTIC_SCHEMA)
  assert.equal(record.timestamp, '2026-01-02T03:04:05.678Z')
  assert.equal(record.event_name, 'synagent.pi.message.rejected')
  assert.equal(record['resource.service.name'], '@a4s/synagent')
  assert.equal(record['resource.a4s.harness.name'], 'pion')
  assert.equal(record['scope.name'], 'a4s.synagent.pi')
  assert.equal(record['attributes.a4s.operation_id'], 'operation-fixture')
  assert.equal(record['attributes.a4s.operation'], 'message.receive')
  assert.equal(record['messaging.message.id_hash'], digestIdentifier(rawMessage))
  assert.equal(record['a4s.queue.depth'], 2)
  assert.equal(record['a4s.connection.generation'], 4)
  assert.equal(record['a4s.client.role'], 'durable')
  assert.equal(record['a4s.delivery.mode'], 'followUp')
  assert.equal(record['a4s.timeout.ms'], 123)
  assert.equal(record['error.type'], 'Error')
  assert.equal(record['error.code'], 'MESSAGE_INVALID')
  assert.equal(record['error.phase'], 'message.receive')
  assert.equal(record['error.retryable'], false)

  const json = JSON.stringify(record)
  for (const forbidden of [
    rawSession,
    rawMessage,
    'host-secret',
    'prompt response transcript body must stay private',
    'SecretToken',
  ]) assert.equal(json.includes(forbidden), false, `found forbidden value: ${forbidden}`)
})

test('diagnostics contains creation and serialization failures', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synagent-pi-contained-failure-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const badEnv = new Proxy({}, {
    get() { throw new Error('broken environment reader') },
  }) as NodeJS.ProcessEnv
  let unavailable: ReturnType<typeof createDiagnostics> | undefined
  assert.doesNotThrow(() => {
    unavailable = createDiagnostics({ env: badEnv, harnessName: 'pion', instanceId: 'creation-failure' })
  })
  assert.equal(unavailable?.record('synagent.pi.started', { operation: 'lifecycle.start' }), false)

  const logger = createDiagnostics({
    env: { A4S_STATE_ROOT: temp },
    harnessName: 'pion',
    instanceId: 'serialization-failure',
    now: () => new Date(Number.NaN),
  })
  assert.doesNotThrow(() => {
    assert.equal(logger.record('synagent.pi.started', { operation: 'lifecycle.start' }), false)
  })
  logger.close()
  assert.equal(fs.statSync(logger.file).size, 0)
})

test('diagnostics completes short writes before reporting success', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synagent-pi-short-write-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const logger = createDiagnostics({
    env: { A4S_STATE_ROOT: temp },
    harnessName: 'pion',
    instanceId: 'short-write',
  })
  const original = fs.writeSync
  let calls = 0
  fs.writeSync = ((fd: number, buffer: Uint8Array, offset: number, length: number) => {
    calls += 1
    return (original as (...args: unknown[]) => number)(fd, buffer, offset, Math.min(length, 7))
  }) as typeof fs.writeSync
  try {
    assert.equal(logger.record('synagent.pi.started', { operation: 'lifecycle.start' }), true)
  } finally {
    fs.writeSync = original
  }
  assert.ok(calls > 1)

  let zeroWrites = 0
  fs.writeSync = ((..._args: unknown[]) => { zeroWrites += 1; return 0 }) as typeof fs.writeSync
  try {
    assert.equal(logger.record('synagent.pi.shutdown', { operation: 'lifecycle.shutdown' }), false)
    assert.equal(logger.record('synagent.pi.shutdown', { operation: 'lifecycle.shutdown' }), false)
  } finally {
    fs.writeSync = original
    logger.close()
  }
  assert.equal(zeroWrites, 1)
  const text = fs.readFileSync(logger.file, 'utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.split('\n').length, 2)
  assert.equal(JSON.parse(text.trim()).event_name, 'synagent.pi.started')
})

test('diagnostics stops before its fixed file quota without later event I/O', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synagent-pi-quota-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const originalFstat = fs.fstatSync
  fs.fstatSync = ((fd: number, options?: unknown) => {
    const stat = (originalFstat as (...args: unknown[]) => fs.Stats)(fd, options)
    Object.defineProperty(stat, 'size', { configurable: true, value: DIAGNOSTIC_FILE_QUOTA_BYTES - 8 })
    return stat
  }) as typeof fs.fstatSync
  let logger: ReturnType<typeof createDiagnostics>
  try {
    logger = createDiagnostics({
      env: { A4S_STATE_ROOT: temp },
      harnessName: 'pion',
      instanceId: 'quota',
    })
  } finally {
    fs.fstatSync = originalFstat
  }

  const originalWrite = fs.writeSync
  let writes = 0
  fs.writeSync = ((..._args: unknown[]) => { writes += 1; return 0 }) as typeof fs.writeSync
  try {
    assert.equal(logger.record('synagent.pi.started', { operation: 'lifecycle.start' }), false)
    assert.equal(logger.record('synagent.pi.shutdown', { operation: 'lifecycle.shutdown' }), false)
  } finally {
    fs.writeSync = originalWrite
    logger.close()
  }
  assert.equal(writes, 0)
  assert.equal(fs.statSync(logger.file).size, 0)
})

test('diagnostics drops writes for symlink and non-regular paths', {
  skip: process.platform === 'win32',
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synagent-pi-paths-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const harnessRoot = path.join(temp, 'log', 'synagent', 'pion')
  fs.mkdirSync(harnessRoot, { recursive: true })

  const linkedInstance = `pion-${digestIdentifier('linked').slice(0, 32)}`
  const outside = path.join(temp, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(harnessRoot, linkedInstance))
  let logger = createDiagnostics({ env: { A4S_STATE_ROOT: temp }, harnessName: 'pion', instanceId: 'linked' })
  assert.equal(logger.record('synagent.pi.started', { operation: 'lifecycle.start' }), false)
  logger.close()
  assert.equal(fs.existsSync(path.join(outside, 'operational.jsonl')), false)

  const fileInstance = `pion-${digestIdentifier('file-instance').slice(0, 32)}`
  fs.writeFileSync(path.join(harnessRoot, fileInstance), 'unchanged')
  logger = createDiagnostics({ env: { A4S_STATE_ROOT: temp }, harnessName: 'pion', instanceId: 'file-instance' })
  assert.equal(logger.record('synagent.pi.started', { operation: 'lifecycle.start' }), false)
  logger.close()
  assert.equal(fs.readFileSync(path.join(harnessRoot, fileInstance), 'utf8'), 'unchanged')

  const regularInstance = `pion-${digestIdentifier('linked-file').slice(0, 32)}`
  const regularDirectory = path.join(harnessRoot, regularInstance)
  const outsideFile = path.join(temp, 'outside.jsonl')
  fs.mkdirSync(regularDirectory)
  fs.writeFileSync(outsideFile, 'unchanged\n')
  fs.symlinkSync(outsideFile, path.join(regularDirectory, 'operational.jsonl'))
  logger = createDiagnostics({ env: { A4S_STATE_ROOT: temp }, harnessName: 'pion', instanceId: 'linked-file' })
  assert.equal(logger.record('synagent.pi.started', { operation: 'lifecycle.start' }), false)
  logger.close()
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'unchanged\n')
})

test('diagnostics writes nothing when private file mode cannot be guaranteed', {
  skip: process.platform === 'win32',
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synagent-pi-mode-failure-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const instance = `pi-${digestIdentifier('mode-failure').slice(0, 32)}`
  const directory = path.join(temp, 'log', 'synagent', 'pi', instance)
  const file = path.join(directory, 'operational.jsonl')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(file, '')
  fs.chmodSync(file, 0o666)

  const original = fs.fchmodSync
  fs.fchmodSync = () => { throw new Error('simulated mode failure') }
  try {
    const logger = createDiagnostics({
      componentName: 'pi',
      env: { A4S_STATE_ROOT: temp },
      harnessName: 'pion',
      instanceId: 'mode-failure',
    })
    assert.equal(logger.record('synagent.pi.started', { operation: 'lifecycle.start' }), false)
    logger.close()
  } finally {
    fs.fchmodSync = original
  }
  assert.equal(fs.statSync(file).size, 0)
})

test('diagnostic digests are deterministic and do not expose identifiers', () => {
  const first = digestIdentifier('same-message-id')
  assert.equal(first, digestIdentifier('same-message-id'))
  assert.notEqual(first, digestIdentifier('other-message-id'))
  assert.equal(first.includes('same-message-id'), false)
  assert.match(first, /^[a-f0-9]{64}$/)
})
