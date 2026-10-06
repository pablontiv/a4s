'use strict'

const assert = require('node:assert/strict')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { classifyError, createLogger, defaultLogDir, SCHEMA } = require('../logging.cjs')

const REQUIRED_FIELDS = [
  'schema',
  'timestamp',
  'severity_text',
  'severity_number',
  'event_name',
  'body',
  'resource.service.name',
  'resource.service.instance.id',
  'resource.host.id_hash',
  'resource.a4s.harness.name',
  'resource.a4s.harness.kind',
  'resource.a4s.harness.role',
  'scope.name',
  'attributes.a4s.correlation_id',
  'attributes.a4s.operation_id',
  'a4s.logging.lossy',
  'a4s.logging.dropped_count',
  'a4s.logging.flush_status',
]

async function readJsonLines(file) {
  const text = await fs.readFile(file, 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line))
}

test('JSONL logger emits valid RCA records with required OTel-aligned fields', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-logging-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const instanceDir = path.join(temp, 'fixture-instance')
  const existingFile = path.join(instanceDir, 'operational.jsonl')
  await fs.mkdir(instanceDir, { recursive: true })
  await fs.chmod(instanceDir, 0o777)
  await fs.writeFile(existingFile, '')
  await fs.chmod(existingFile, 0o666)

  const env = {
    A4S_SYNAGENT_BUS_LOG_DIR: temp,
    A4S_SERVICE_INSTANCE_ID: 'fixture-instance',
    A4S_OPERATION_ID: 'fixture-operation',
    A4S_CORRELATION_ID: 'fixture-correlation',
  }
  const logger = createLogger({
    env,
    hostname: 'fixture-host',
    now: () => new Date('2026-01-02T03:04:05.678Z'),
    scopeName: 'a4s.synagent-bus.fixture',
    harnessKind: 'test',
    harnessRole: 'fixture',
  })
  const externalError = Object.assign(new Error('secret payload token=/do-not-log'), { code: 'ETIMEDOUT' })
  logger.error('fixture.failed', {
    body: 'Fixture operation failed',
    error: classifyError(externalError, 'fixture.probe'),
    protocol: { channel: 'test', contaminated: false },
    flushStatus: 'pending',
  })
  logger.close()

  const records = await readJsonLines(logger.file)
  assert.equal(records.length, 1)
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(instanceDir)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(logger.file)).mode & 0o777, 0o600)
  }
  const [record] = records
  for (const field of REQUIRED_FIELDS) assert.ok(Object.hasOwn(record, field), `missing ${field}`)
  assert.equal(record.schema, SCHEMA)
  assert.equal(record.timestamp, '2026-01-02T03:04:05.678Z')
  assert.equal(record.event_name, 'fixture.failed')
  assert.equal(record['resource.service.name'], '@a4s/synagent-bus')
  assert.equal(record['resource.service.instance.id'], 'fixture-instance')
  assert.equal(record['attributes.a4s.operation_id'], 'fixture-operation')
  assert.equal(record['attributes.a4s.correlation_id'], 'fixture-correlation')
  assert.equal(record['error.type'], 'Error')
  assert.equal(record['error.code'], 'ETIMEDOUT')
  assert.equal(record['error.source'], 'fixture.probe')
  assert.equal(record['error.retryable'], true)
  assert.equal(record['a4s.protocol.channel'], 'test')
  assert.equal(record['a4s.protocol.contaminated'], false)
  assert.doesNotMatch(JSON.stringify(record), /secret|do-not-log/)
})

test('instance identifiers cannot escape or collapse the configured log root', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-log-path-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'root')
  const dangerous = ['.', '..', '../escape', '../../outside', '/absolute/path', '\\..\\escape']

  for (const instanceId of dangerous) {
    const env = {
      A4S_SYNAGENT_BUS_LOG_DIR: root,
      A4S_SERVICE_INSTANCE_ID: instanceId,
    }
    const directory = defaultLogDir({ env, instanceId })
    const relative = path.relative(path.resolve(root), directory)
    assert.notEqual(relative, '')
    assert.equal(path.isAbsolute(relative), false)
    assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`), false)

    const logger = createLogger({ env, hostname: 'fixture-host' })
    logger.info('fixture.path_safe')
    logger.close()
    assert.equal(path.dirname(logger.file).startsWith(`${path.resolve(root)}${path.sep}`), true)
  }
})

test('logger rejects symlink and non-directory instance paths without fallback writes', {
  skip: process.platform === 'win32',
}, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-log-instance-type-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'root')
  const outside = path.join(temp, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)

  await fs.symlink(outside, path.join(root, 'linked-instance'))
  let logger = createLogger({
    env: { A4S_SYNAGENT_BUS_LOG_DIR: root, A4S_SERVICE_INSTANCE_ID: 'linked-instance' },
  })
  assert.equal(logger.info('fixture.must_drop'), false)
  logger.close()
  await assert.rejects(fs.access(path.join(outside, 'operational.jsonl')))

  await fs.writeFile(path.join(root, 'file-instance'), 'unchanged')
  logger = createLogger({
    env: { A4S_SYNAGENT_BUS_LOG_DIR: root, A4S_SERVICE_INSTANCE_ID: 'file-instance' },
  })
  assert.equal(logger.info('fixture.must_drop'), false)
  logger.close()
  assert.equal(await fs.readFile(path.join(root, 'file-instance'), 'utf8'), 'unchanged')
})

test('logger rejects symlink and non-regular log files', { skip: process.platform === 'win32' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-log-file-type-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'root')
  const outsideFile = path.join(temp, 'outside.jsonl')
  const linkedDir = path.join(root, 'linked-file')
  await fs.mkdir(linkedDir, { recursive: true })
  await fs.writeFile(outsideFile, 'unchanged\n')
  await fs.symlink(outsideFile, path.join(linkedDir, 'operational.jsonl'))

  let logger = createLogger({
    env: { A4S_SYNAGENT_BUS_LOG_DIR: root, A4S_SERVICE_INSTANCE_ID: 'linked-file' },
  })
  assert.equal(logger.info('fixture.must_drop'), false)
  logger.close()
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'unchanged\n')

  const nonRegularDir = path.join(root, 'non-regular-file')
  await fs.mkdir(path.join(nonRegularDir, 'operational.jsonl'), { recursive: true })
  logger = createLogger({
    env: { A4S_SYNAGENT_BUS_LOG_DIR: root, A4S_SERVICE_INSTANCE_ID: 'non-regular-file' },
  })
  assert.equal(logger.info('fixture.must_drop'), false)
  logger.close()
})

test('logger writes no bytes when descriptor chmod cannot guarantee 0600', {
  skip: process.platform === 'win32',
}, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-log-fchmod-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const instanceDir = path.join(temp, 'fchmod-failure')
  const file = path.join(instanceDir, 'operational.jsonl')
  await fs.mkdir(instanceDir, { recursive: true })
  await fs.writeFile(file, '')
  await fs.chmod(file, 0o666)

  const originalFchmodSync = fsSync.fchmodSync
  fsSync.fchmodSync = () => { throw new Error('simulated fchmod failure') }
  try {
    const logger = createLogger({
      env: { A4S_SYNAGENT_BUS_LOG_DIR: temp, A4S_SERVICE_INSTANCE_ID: 'fchmod-failure' },
    })
    assert.equal(logger.info('fixture.must_drop'), false)
    logger.close()
  } finally {
    fsSync.fchmodSync = originalFchmodSync
  }
  assert.equal((await fs.stat(file)).size, 0)
})
