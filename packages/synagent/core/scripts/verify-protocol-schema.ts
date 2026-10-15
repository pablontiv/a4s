#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

import { parseDeadLetter, serialize, type CanonicalMessage } from '../protocol.ts'

type JsonRecord = Record<string, unknown>
type HostName = 'omp' | 'pi'
type HostConfig = {
  adapterPath: string
  agentDir: string
  bin: string
  expectedVersion: string
  name: HostName
  rpcArgs: (sessionDir: string, extensionPath: string) => string[]
}
type ResponseWaiter = {
  reject: (error: Error) => void
  resolve: (record: JsonRecord) => void
  timer: NodeJS.Timeout
}
type BusRecord = { payload: string; topic: string }

const TIMEOUT_MS = 240_000
const BROKER_PORT = 18_330
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const brokerPath = join(repoRoot, 'packages', 'synagent', 'bus', 'broker.cjs')
const rootOverride = process.env.SYNAGENT_LIVE_ROOT?.trim()
const root = rootOverride
  ? resolve(rootOverride)
  : mkdtempSync(join(tmpdir(), 'synagent-verify-protocol-schema-'))
const dbPath = join(root, 'db')
const brokerUrl = `mqtt://127.0.0.1:${BROKER_PORT}`

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(text: string): JsonRecord {
  const value: unknown = JSON.parse(text)
  if (!isJsonRecord(value)) throw new TypeError('expected a JSON object')
  return value
}

function delay(ms: number): Promise<void> {
  const deferred = Promise.withResolvers<void>()
  setTimeout(deferred.resolve, ms)
  return deferred.promise
}

class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly stderr: string[] = []
  private buffer = ''
  private requestSequence = 0
  private readonly responseWaiters = new Map<string, ResponseWaiter>()

  constructor(
    readonly label: string,
    config: HostConfig,
    stateRoot: string,
    sessionDir: string,
    extensionPath: string,
  ) {
    mkdirSync(stateRoot, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    this.child = spawn(config.bin, config.rpcArgs(sessionDir, extensionPath), {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        A4S_STATE_ROOT: stateRoot,
        PI_CODING_AGENT_DIR: config.agentDir,
        PI_TELEMETRY: '0',
        SYNAGENT_BROKER_URL: brokerUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.consume(String(chunk)))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => this.stderr.push(String(chunk)))
    this.child.once('exit', (code, signal) => {
      const error = new Error(
        `${this.label} exited code=${String(code)} signal=${String(signal)}: ${this.stderr.join('').slice(-2000)}`,
      )
      for (const waiter of this.responseWaiters.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.responseWaiters.clear()
    })
  }

  command(command: JsonRecord): Promise<JsonRecord> {
    const id = `${this.label}-${++this.requestSequence}`
    const deferred = Promise.withResolvers<JsonRecord>()
    const timer = setTimeout(() => {
      this.responseWaiters.delete(id)
      deferred.reject(new Error(`${this.label} timed out waiting for ${String(command.type)}`))
    }, TIMEOUT_MS)
    this.responseWaiters.set(id, { reject: deferred.reject, resolve: deferred.resolve, timer })
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, error => {
      if (!error) return
      clearTimeout(timer)
      this.responseWaiters.delete(id)
      deferred.reject(error)
    })
    return deferred.promise.then(record => {
      if (record.success !== true) throw new Error(`${this.label} command failed: ${JSON.stringify(record)}`)
      return record
    })
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const pid = this.child.pid
    if (pid === undefined) throw new Error(`${this.label} has no process id`)
    const exited = Promise.withResolvers<void>()
    this.child.once('exit', exited.resolve)
    this.child.stdin.end()
    const timer = setTimeout(() => process.kill(-pid, 'SIGTERM'), 5_000)
    await exited.promise
    clearTimeout(timer)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const record = parseJsonRecord(line)
      const responseId = typeof record.id === 'string' ? record.id : undefined
      if (record.type !== 'response' || !responseId) continue
      const waiter = this.responseWaiters.get(responseId)
      if (!waiter) continue
      clearTimeout(waiter.timer)
      this.responseWaiters.delete(responseId)
      waiter.resolve(record)
    }
  }
}

function writeCaptureExtension(config: HostConfig, hostRoot: string, capturePath: string): string {
  writeFileSync(capturePath, '', { flag: 'wx', mode: 0o600 })
  const extensionPath = join(hostRoot, `verify-protocol-${config.name}.ts`)
  const adapterUrl = pathToFileURL(config.adapterPath).href
  writeFileSync(extensionPath, `
import { appendFileSync } from 'node:fs'
import adapter from ${JSON.stringify(adapterUrl)}

export default function verifyProtocol(api) {
  const wrapContext = context => {
    if (!context || !context.ui) return context
    const ui = new Proxy(context.ui, {
      get(target, property, receiver) {
        if (property === 'notify') {
          return (message, type) => {
            appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ message, type }) + '\\n')
            return target.notify(message, type)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return new Proxy(context, {
      get(target, property, receiver) {
        if (property === 'ui') return ui
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  const wrapped = new Proxy(api, {
    get(target, property, receiver) {
      if (property === 'on') {
        return (eventName, handler) => target.on(eventName, (event, context) => handler(event, wrapContext(context)))
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  adapter(wrapped)
}
`, { flag: 'wx', mode: 0o600 })
  return extensionPath
}

function readJsonLines(path: string): JsonRecord[] {
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      return [parseJsonRecord(line)]
    } catch {
      return []
    }
  })
}

function readDiagnostics(stateRoot: string): JsonRecord[] {
  const records: JsonRecord[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) records.push(...readJsonLines(path))
    }
  }
  visit(stateRoot)
  return records
}

async function waitForCondition(description: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await delay(25)
  }
}

async function waitForBrokerReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let output = ''
  let errors = ''
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const ready = Promise.withResolvers<void>()
  const timer = setTimeout(() => ready.reject(new Error(`broker readiness timed out: ${errors}`)), 30_000)
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (!output.includes(`BROKER READY :${BROKER_PORT}`)) return
    clearTimeout(timer)
    ready.resolve()
  })
  child.once('exit', (code, signal) => {
    clearTimeout(timer)
    ready.reject(new Error(`broker exited code=${String(code)} signal=${String(signal)}: ${errors}`))
  })
  await ready.promise
}

async function waitForConnect(client: MqttClient): Promise<void> {
  const connected = Promise.withResolvers<void>()
  client.once('connect', () => connected.resolve())
  client.once('error', error => connected.reject(error))
  await connected.promise
}

async function publishRaw(client: MqttClient, topic: string, payload: string): Promise<void> {
  const published = Promise.withResolvers<void>()
  client.publish(topic, payload, { qos: 1 }, error => error ? published.reject(error) : published.resolve())
  await published.promise
}

async function closeClient(client: MqttClient): Promise<void> {
  const closed = Promise.withResolvers<void>()
  client.end(false, {}, error => error ? closed.reject(error) : closed.resolve())
  await closed.promise
}

async function stopBroker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('exit', exited.resolve)
  child.kill('SIGTERM')
  await exited.promise
}

function assertBrokerIsolation(process: RpcProcess, host: HostName): void {
  const pid = process.child.pid
  assert.equal(typeof pid, 'number')
  const output = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP'], { encoding: 'utf8' })
  const established = output.split('\n').filter(line => line.includes('(ESTABLISHED)'))
  assert.ok(established.some(line => line.includes(`->127.0.0.1:${BROKER_PORT}`)))
  assert.ok(established.every(line => !line.includes('->127.0.0.1:1884')))
  const loopbackPorts = established.flatMap(line => line.match(/->127\.0\.0\.1:(\d+)/)?.[1] ?? [])
  assert.deepEqual([...new Set(loopbackPorts)], [String(BROKER_PORT)])
  console.log(`LSOF host=${host} pid=${pid} only_broker=${BROKER_PORT} forbidden_1884=false`)
}

async function runHost(config: HostConfig, publisher: MqttClient, bus: BusRecord[]): Promise<void> {
  const version = execFileSync(config.bin, ['--version'], { encoding: 'utf8' }).trim()
  assert.ok(version.includes(config.expectedVersion), `${config.name} must be ${config.expectedVersion}; got ${version}`)
  const hostRoot = join(root, config.name)
  const stateRoot = join(hostRoot, 'state')
  const capturePath = join(hostRoot, 'notifications.jsonl')
  mkdirSync(hostRoot, { recursive: true })
  const extensionPath = writeCaptureExtension(config, hostRoot, capturePath)
  const rpc = new RpcProcess(
    `${config.name}-protocol`,
    config,
    stateRoot,
    join(hostRoot, 'sessions'),
    extensionPath,
  )
  try {
    const state = await rpc.command({ type: 'get_state' })
    assert.ok(isJsonRecord(state.data))
    assert.equal(typeof state.data.sessionId, 'string')
    const sessionId = state.data.sessionId
    await waitForCondition(`${config.name} wildcard subscriptions`, () => {
      const notifications = readJsonLines(capturePath)
      return notifications.some(record =>
        typeof record.message === 'string'
        && record.message.includes(`filters=synagent/+/a4s/${sessionId}`))
        && notifications.some(record =>
          typeof record.message === 'string'
          && record.message.includes('filters=synagent/+/a4s/all, synagent/+/all'))
    })
    await waitForCondition(`${config.name} private broker connection`, () => {
      try {
        assertBrokerIsolation(rpc, config.name)
        return true
      } catch {
        return false
      }
    })
    assertBrokerIsolation(rpc, config.name)

    const malformed = `  {"broken":"${config.name}" `
    const validBase = {
      from: `a4s/verify-${config.name}`,
      kind: 'task.delivered',
      body: '',
      ts: 1,
    } as const
    const validMessages: CanonicalMessage[] = [
      { ...validBase, id: `${config.name}-direct-v2`, to: `a4s/${sessionId}` },
      { ...validBase, id: `${config.name}-project-v2`, to: 'a4s/all' },
      { ...validBase, id: `${config.name}-global-v2`, to: 'all' },
    ]
    const unknownMessages: CanonicalMessage[] = [
      { ...validBase, id: `${config.name}-direct-v99`, to: `a4s/${sessionId}` },
      { ...validBase, id: `${config.name}-project-v99`, to: 'a4s/all' },
      { ...validBase, id: `${config.name}-global-v99`, to: 'all' },
    ]
    const diagnosticsBefore = readDiagnostics(stateRoot).length
    const busBefore = bus.length
    await publishRaw(publisher, `synagent/v2/a4s/${sessionId}`, malformed)
    const v2Topics = [
      `synagent/v2/a4s/${sessionId}`,
      'synagent/v2/a4s/all',
      'synagent/v2/all',
    ]
    const v99Topics = [
      `synagent/v99/a4s/${sessionId}`,
      'synagent/v99/a4s/all',
      'synagent/v99/all',
    ]
    for (let index = 0; index < v2Topics.length; index++) {
      await publishRaw(publisher, v2Topics[index] as string, serialize(validMessages[index] as CanonicalMessage))
    }
    for (let index = 0; index < v99Topics.length; index++) {
      await publishRaw(publisher, v99Topics[index] as string, serialize(unknownMessages[index] as CanonicalMessage))
    }

    await waitForCondition(`${config.name} stable protocol diagnostics`, () => {
      const current = readDiagnostics(stateRoot).slice(diagnosticsBefore)
      const codes = current.flatMap(record => typeof record['error.code'] === 'string' ? [record['error.code']] : [])
      return codes.filter(code => code === 'MESSAGE_INVALID').length === 1
        && codes.filter(code => code === 'VERSION_UNSUPPORTED').length === 3
        && current.filter(record => typeof record.event_name === 'string' && record.event_name.endsWith('.message.received')).length === 3
    })
    await waitForCondition(`${config.name} malformed DLQ only`, () => {
      const dlqRecords = bus.slice(busBefore)
        .filter(record => record.topic === `synagent/v2/dlq/a4s/${sessionId}`)
        .map(record => parseDeadLetter(record.payload))
      return dlqRecords.length === 1 && dlqRecords[0]?.cause === 'INVALID_JSON'
    })
    const notifications = readJsonLines(capturePath)
    assert.ok(notifications.some(record =>
      typeof record.message === 'string' && record.message.includes('MESSAGE_INVALID')))
    assert.equal(notifications.filter(record =>
      typeof record.message === 'string' && record.message.includes('VERSION_UNSUPPORTED')).length, 3)
    console.log(
      `PASS host=${config.name} version=${version} subscriptions=version-wildcard `
      + 'malformed=MESSAGE_INVALID unknown=VERSION_UNSUPPORTED unknown_count=3 '
      + 'v2_received=3 duplicates=false version_dlq=false',
    )
  } finally {
    await rpc.close().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  if (rootOverride) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  chmodSync(root, 0o700)
  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: { ...process.env, SYNAGENT_DB: dbPath, SYNAGENT_PORT: String(BROKER_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let observer: MqttClient | undefined
  let publisher: MqttClient | undefined
  const bus: BusRecord[] = []
  try {
    await waitForBrokerReady(broker)
    observer = connect(brokerUrl, {
      clean: true,
      clientId: `synagent-live-130-observer-${process.pid}`,
      reconnectPeriod: 0,
    })
    observer.on('message', (topic, payload) => {
      bus.push({ topic, payload: payload.toString('utf8') })
    })
    await waitForConnect(observer)
    const subscribed = Promise.withResolvers<void>()
    observer.subscribe('synagent/#', { qos: 1 }, error => error ? subscribed.reject(error) : subscribed.resolve())
    await subscribed.promise
    publisher = connect(brokerUrl, {
      clean: true,
      clientId: `synagent-live-130-publisher-${process.pid}`,
      reconnectPeriod: 0,
    })
    await waitForConnect(publisher)
    const configs: HostConfig[] = [
      {
        name: 'omp',
        expectedVersion: '18.11.0',
        bin: process.env.OMP_BIN ?? join(homedir(), '.bun', 'bin', 'omp'),
        adapterPath: join(coreRoot, 'adapters', 'omp', 'index.ts'),
        agentDir: join(homedir(), '.omp', 'agent'),
        rpcArgs(sessionDir, extensionPath) {
          return [
            '--mode', 'rpc', '--no-ui', '--no-extensions', '--no-skills', '--no-rules', '--no-title',
            '--no-lsp', '--no-pty', '--tools', 'bash', '--auto-approve', '--thinking', 'off',
            '--session-dir', sessionDir, '-e', extensionPath,
          ]
        },
      },
      {
        name: 'pi',
        expectedVersion: '1.0.3',
        bin: process.env.PI_BIN ?? join(homedir(), '.local', 'bin', 'pi'),
        adapterPath: join(coreRoot, 'adapters', 'pi', 'index.ts'),
        agentDir: join(homedir(), '.pi', 'agent'),
        rpcArgs(sessionDir, extensionPath) {
          return [
            '--mode', 'rpc', '--thinking', 'off', '--no-extensions', '--no-skills', '--no-prompt-templates',
            '--no-context-files', '--offline', '--approve', '--session-dir', sessionDir, '-e', extensionPath,
          ]
        },
      },
    ]
    for (const config of configs) await runHost(config, publisher, bus)
    console.log(`PASS all_hosts=2 broker=${BROKER_PORT} forbidden_1884=false evidence=${root}`)
  } finally {
    if (publisher) await closeClient(publisher).catch(() => undefined)
    if (observer) await closeClient(observer).catch(() => undefined)
    await stopBroker(broker).catch(() => undefined)
  }
}

await main()
