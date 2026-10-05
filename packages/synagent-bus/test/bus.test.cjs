'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const mqtt = require('mqtt')
const { defaultDbDir, parseArgs } = require('../broker.cjs')

const BROKER = path.join(__dirname, '..', 'broker.cjs')

function waitForOutput(proc, stream, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pattern}; saw ${output}`)), timeoutMs)
    proc[stream].setEncoding('utf8')
    const onData = chunk => {
      output += chunk
      const match = output.match(pattern)
      if (match) {
        clearTimeout(timer)
        proc[stream].off('data', onData)
        resolve(match)
      }
    }
    proc[stream].on('data', onData)
  })
}

function exited(proc) {
  return new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })))
}

function outputAndExit(proc) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    proc.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function connect(url, clientId) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { clientId, clean: true, reconnectPeriod: 0 })
    client.once('connect', () => resolve(client))
    client.once('error', reject)
  })
}

function end(client) {
  return new Promise(resolve => client.end(false, {}, resolve))
}

async function roundTrip(url, suffix) {
  const subscriber = await connect(url, `synagent-bus-sub-${suffix}`)
  const publisher = await connect(url, `synagent-bus-pub-${suffix}`)
  try {
    await new Promise((resolve, reject) => subscriber.subscribe(
      'a4s/inbox/claude', { qos: 1 }, error => error ? reject(error) : resolve(),
    ))
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT round-trip timed out')), 5000)
      subscriber.once('message', (_topic, payload) => {
        clearTimeout(timer)
        resolve(JSON.parse(payload.toString()))
      })
    })
    const message = { id: suffix, from: 'pi', to: 'claude', kind: 'prompt', body: 'hola', ts: 1 }
    await new Promise((resolve, reject) => publisher.publish(
      'a4s/inbox/claude', JSON.stringify(message), { qos: 1 }, error => error ? reject(error) : resolve(),
    ))
    assert.deepEqual(await received, message)
  } finally {
    await end(subscriber)
    await end(publisher)
  }
}

async function startRealBroker(t, executable = process.execPath, leadingArgs = [BROKER]) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-bus-real-'))
  const db = path.join(temp, 'mqtt-db')
  const proc = spawn(executable, [...leadingArgs, '0', '--db', db], { env: process.env })
  t.after(async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM')
      await exited(proc)
    }
    await fs.rm(temp, { recursive: true, force: true })
  })
  const match = await waitForOutput(proc, 'stdout', /BROKER READY :(\d+) db=(.+)/)
  return { proc, db, url: `mqtt://127.0.0.1:${match[1]}` }
}

test('database defaults and precedence are OS-aware', () => {
  assert.equal(
    defaultDbDir({ platform: 'darwin', env: {}, home: '/Users/tester' }),
    '/Users/tester/Library/Application Support/a4s/synagent/mqtt-db',
  )
  assert.equal(
    defaultDbDir({ platform: 'linux', env: {}, home: '/home/tester' }),
    '/home/tester/.local/state/a4s/synagent/mqtt-db',
  )
  assert.equal(
    defaultDbDir({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/tester' }),
    '/state/a4s/synagent/mqtt-db',
  )

  const options = { platform: 'linux', home: '/home/tester' }
  assert.equal(parseArgs([], { SYNAGENT_DB: '/env' }, options).dbdir, '/env')
  assert.equal(parseArgs(['1885', '/legacy'], { SYNAGENT_DB: '/env' }, options).dbdir, '/legacy')
  assert.equal(parseArgs(['1885', '/legacy', '--db', '/flag'], { SYNAGENT_DB: '/env' }, options).dbdir, '/flag')
  assert.equal(parseArgs(['0'], {}, options).port, 0)
})

test('real CLI uses an ephemeral port, durable LevelDB, and MQTT round-trip', async t => {
  const { proc, db, url } = await startRealBroker(t)
  await roundTrip(url, 'real-cli')
  const entries = await fs.readdir(db)
  assert.ok(entries.length > 0, 'LevelDB should create files')
  if (process.platform !== 'win32') {
    const mode = (await fs.stat(db)).mode & 0o777
    assert.equal(mode, 0o700)
  }
  proc.kill('SIGTERM')
  assert.deepEqual(await exited(proc), { code: 0, signal: null })
})

test('EADDRINUSE exits zero before creating or opening LevelDB', async t => {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => listener.close(resolve)))
  const port = listener.address().port
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-bus-inuse-'))
  const db = path.join(temp, 'must-not-exist')
  t.after(() => fs.rm(temp, { recursive: true, force: true }))

  const proc = spawn(process.execPath, [BROKER, String(port), '--db', db])
  const output = await waitForOutput(proc, 'stdout', new RegExp(`BROKER ALREADY RUNNING :${port}`))
  assert.ok(output)
  assert.deepEqual(await exited(proc), { code: 0, signal: null })
  assert.equal(existsSync(db), false)
})

test('LevelDB initialization failure exits nonzero instead of degrading to memory', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-bus-db-failure-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const notDirectory = path.join(temp, 'file')
  await fs.writeFile(notDirectory, 'not a directory')
  const result = await outputAndExit(spawn(process.execPath, [BROKER, '0', '--db', notDirectory]))
  assert.equal(result.code, 1)
  assert.doesNotMatch(result.stdout, /BROKER READY/)
  assert.match(result.stderr, /\[broker\] ERROR/)
})

test('npm tarball installs globally into an isolated prefix and its real bin works', { timeout: 120000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-bus-global-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const packageRoot = path.join(__dirname, '..')

  const packed = spawn('npm', ['pack', '--json', '--pack-destination', temp, packageRoot])
  let packOut = ''
  packed.stdout.setEncoding('utf8').on('data', chunk => { packOut += chunk })
  const packResult = await exited(packed)
  assert.equal(packResult.code, 0)
  const [{ filename }] = JSON.parse(packOut)
  const tarball = path.join(temp, filename)
  const prefix = path.join(temp, 'prefix')

  const install = spawn('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', tarball])
  assert.equal((await exited(install)).code, 0)
  const bin = path.join(prefix, 'bin', 'synagent-bus')
  assert.equal(existsSync(bin), true)

  const { proc, url } = await startRealBroker(t, bin, [])
  await roundTrip(url, 'global-bin')
  proc.kill('SIGTERM')
  assert.deepEqual(await exited(proc), { code: 0, signal: null })
})
