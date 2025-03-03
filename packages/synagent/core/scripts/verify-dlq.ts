#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

import {
  parseDeadLetter,
  serialize,
  type CanonicalMessage,
  type DeadLetterCause,
  type DeadLetterRecord,
} from '../protocol.ts'

type JsonRecord = Record<string, unknown>
type HostName = 'omp' | 'pi'
type HostConfig = {
  adapterPath: string
  agentDir: string
  bin: string
  expectedVersion: string
  model: string
  name: HostName
  rpcArgs: (sessionDir: string, extensionPath: string) => string[]
}
type BusRecord = { payload: string; qos: number; topic: string }
type RecordWaiter = {
  after: number
  predicate: (record: JsonRecord) => boolean
  reject: (error: Error) => void
  resolve: (record: JsonRecord) => void
  timer: NodeJS.Timeout
}
type ResponseWaiter = {
  reject: (error: Error) => void
  resolve: (record: JsonRecord) => void
  timer: NodeJS.Timeout
}

const TIMEOUT_MS = 240_000
const BROKER_PORT = 18_329
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const brokerPath = join(repoRoot, 'apps', 'message-bus', 'broker.cjs')
const rootOverride = process.env.SYNAGENT_LIVE_ROOT?.trim()
const root = rootOverride
  ? resolve(rootOverride)
  : mkdtempSync(join(tmpdir(), 'synagent-verify-dlq-'))
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

function splitModel(model: string): { modelId: string; provider: string } {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) throw new Error(`model must use provider/model-id: ${model}`)
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const text: string[] = []
  for (const part of content) {
    if (
      typeof part === 'object'
      && part !== null
      && 'type' in part
      && part.type === 'text'
      && 'text' in part
      && typeof part.text === 'string'
    ) text.push(part.text)
  }
  return text.join('\n')
}

function eventMessageText(record: JsonRecord): string {
  const message = record.message
  return isJsonRecord(message) ? messageText(message.content) : ''
}

function delay(ms: number): Promise<void> {
  const deferred = Promise.withResolvers<void>()
  setTimeout(deferred.resolve, ms)
  return deferred.promise
}

class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly records: JsonRecord[] = []
  readonly stderr: string[] = []
  private buffer = ''
  private requestSequence = 0
  private readonly responseWaiters = new Map<string, ResponseWaiter>()
  private readonly recordWaiters = new Set<RecordWaiter>()

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
      for (const waiter of this.recordWaiters) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.recordWaiters.clear()
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

  waitFor(predicate: (record: JsonRecord) => boolean, after = 0): Promise<JsonRecord> {
    const found = this.records.slice(after).find(predicate)
    if (found) return Promise.resolve(found)
    const deferred = Promise.withResolvers<JsonRecord>()
    const waiter: RecordWaiter = {
      after,
      predicate,
      reject: deferred.reject,
      resolve: deferred.resolve,
      timer: setTimeout(() => {
        this.recordWaiters.delete(waiter)
        deferred.reject(new Error(
          `${this.label} timed out waiting for event; stderr=${this.stderr.join('').slice(-2000)}`,
        ))
      }, TIMEOUT_MS),
    }
    this.recordWaiters.add(waiter)
    return deferred.promise
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
      this.records.push(record)
      const responseId = typeof record.id === 'string' ? record.id : undefined
      if (record.type === 'response' && responseId) {
        const waiter = this.responseWaiters.get(responseId)
        if (waiter) {
          clearTimeout(waiter.timer)
          this.responseWaiters.delete(responseId)
          waiter.resolve(record)
        }
      }
      for (const waiter of this.recordWaiters) {
        if (this.records.length <= waiter.after || !waiter.predicate(record)) continue
        clearTimeout(waiter.timer)
        this.recordWaiters.delete(waiter)
        waiter.resolve(record)
      }
    }
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

async function subscribeObserver(client: MqttClient): Promise<void> {
  await waitForConnect(client)
  const subscribed = Promise.withResolvers<void>()
  client.subscribe('synagent/#', { qos: 1 }, error => error ? subscribed.reject(error) : subscribed.resolve())
  await subscribed.promise
}

async function publishRaw(client: MqttClient, topic: string, payload: string): Promise<void> {
  const published = Promise.withResolvers<void>()
  client.publish(topic, payload, { qos: 1 }, error => error ? published.reject(error) : published.resolve())
  await published.promise
}

async function closeClient(client: MqttClient): Promise<void> {
  const closed = Promise.withResolvers<void>()
  client.end(false, {}, () => closed.resolve())
  await closed.promise
}

async function stopBroker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('exit', exited.resolve)
  child.kill('SIGTERM')
  await exited.promise
}

function capturedNotifications(path: string): JsonRecord[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      return [parseJsonRecord(line)]
    } catch {
      return []
    }
  })
}

async function waitForCondition(description: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await delay(25)
  }
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

function writeDispatchFailureExtension(config: HostConfig, hostRoot: string, capturePath: string): string {
  const path = join(hostRoot, `verify-dlq-${config.name}.ts`)
  const adapterUrl = pathToFileURL(config.adapterPath).href
  writeFileSync(path, `
import { appendFileSync } from 'node:fs'
import adapter from ${JSON.stringify(adapterUrl)}

export default function verifyDlq(api) {
  let failed = false
  const wrapped = new Proxy(api, {
    get(target, property, receiver) {
      if (property === 'sendUserMessage') {
        return (text, options) => {
          if (!failed && text.includes('FORCE_DISPATCH_129')) {
            failed = true
            throw new Error('deterministic live dispatch failure')
          }
          return target.sendUserMessage(text, options)
        }
      }
      if (property === 'registerCommand') {
        return (name, command) => target.registerCommand(name, {
          ...command,
          handler: async (args, context) => {
            const ui = new Proxy(context.ui, {
              get(uiTarget, uiProperty, uiReceiver) {
                if (uiProperty === 'notify') {
                  return (message, type) => {
                    appendFileSync(
                      ${JSON.stringify(capturePath)},
                      JSON.stringify({ name, args, message, type }) + '\\n',
                    )
                    return uiTarget.notify(message, type)
                  }
                }
                const value = Reflect.get(uiTarget, uiProperty, uiReceiver)
                return typeof value === 'function' ? value.bind(uiTarget) : value
              },
            })
            const wrappedContext = new Proxy(context, {
              get(contextTarget, contextProperty, contextReceiver) {
                if (contextProperty === 'ui') return ui
                const value = Reflect.get(contextTarget, contextProperty, contextReceiver)
                return typeof value === 'function' ? value.bind(contextTarget) : value
              },
            })
            return command.handler(args, wrappedContext)
          },
        })
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  adapter(wrapped)
}
`, { flag: 'wx', mode: 0o600 })
  return path
}

async function waitForDlq(
  bus: BusRecord[],
  topic: string,
  cause: DeadLetterCause,
  after: number,
): Promise<DeadLetterRecord> {
  let found: DeadLetterRecord | undefined
  await waitForCondition(`${cause} on ${topic}`, () => {
    for (const record of bus.slice(after)) {
      if (record.topic !== topic) continue
      const parsed = parseDeadLetter(record.payload)
      if (parsed.cause === cause) {
        assert.equal(record.qos, 1)
        found = parsed
        return true
      }
    }
    return false
  })
  assert.ok(found)
  return found
}

async function runHost(config: HostConfig, bus: BusRecord[], publisher: MqttClient): Promise<void> {
  const version = execFileSync(config.bin, ['--version'], { encoding: 'utf8' }).trim()
  assert.ok(version.includes(config.expectedVersion), `${config.name} must be ${config.expectedVersion}; got ${version}`)
  const hostRoot = join(root, config.name)
  mkdirSync(hostRoot, { recursive: true })
  const sessionDir = join(hostRoot, 'sessions')
  const capturePath = join(hostRoot, 'command-notifications.jsonl')
  const extensionPath = writeDispatchFailureExtension(config, hostRoot, capturePath)
  const process = new RpcProcess(`${config.name}-dlq`, config, join(hostRoot, 'state'), sessionDir, extensionPath)
  try {
    const model = splitModel(config.model)
    await process.command({ type: 'set_model', provider: model.provider, modelId: model.modelId })
    const state = await process.command({ type: 'get_state' })
    assert.ok(isJsonRecord(state.data))
    assert.equal(typeof state.data.sessionId, 'string')
    const sessionId = state.data.sessionId
    const topic = `synagent/v2/a4s/${sessionId}`
    const dlqTopic = `synagent/v2/dlq/a4s/${sessionId}`
    await waitForCondition(`${config.name} private broker connection`, () => {
      try {
        assertBrokerIsolation(process, config.name)
        return true
      } catch {
        return false
      }
    })
    assertBrokerIsolation(process, config.name)

    const invalidPayload = `  {"broken":"INVALID_${config.name.toUpperCase()}_129" `
    const invalidStart = bus.length
    await publishRaw(publisher, topic, invalidPayload)
    const invalid = await waitForDlq(bus, dlqTopic, 'INVALID_JSON', invalidStart)
    assert.equal(invalid.payload, invalidPayload)

    const dispatchMessage: CanonicalMessage = {
      id: `dispatch-${config.name}-129`,
      from: `a4s/verify-${config.name}`,
      to: `a4s/${sessionId}`,
      kind: 'task.request',
      body: `FORCE_DISPATCH_129_${config.name.toUpperCase()}`,
      ts: Date.now(),
    }
    const dispatchPayload = ` ${serialize(dispatchMessage)} `
    const dispatchStart = bus.length
    await publishRaw(publisher, topic, dispatchPayload)
    const dispatch = await waitForDlq(bus, dlqTopic, 'DELIVERY_DISPATCH_FAILED', dispatchStart)
    assert.equal(dispatch.payload, dispatchPayload)
    assert.equal(dispatch.harness, config.name === 'pi' ? 'pion' : 'omp')

    const listStart = process.records.length
    await process.command({ type: 'prompt', message: '/synagent dlq' })
    await waitForCondition(`${config.name} /synagent dlq listing`, () =>
      capturedNotifications(capturePath).some(record =>
        typeof record.message === 'string'
        && record.message.includes('INVALID_JSON')
        && record.message.includes('DELIVERY_DISPATCH_FAILED')))
    const listingRecord = process.records.slice(listStart).find(record => {
      const text = JSON.stringify(record)
      return text.includes('INVALID_JSON') && text.includes('DELIVERY_DISPATCH_FAILED')
    })
    const listingRpcVisible = listingRecord !== undefined
    const directBeforeRetry = bus.filter(record => record.topic === topic && record.payload === dispatchPayload).length
    assert.equal(directBeforeRetry, 1)
    const retryStart = process.records.length
    await process.command({ type: 'prompt', message: `/synagent dlq retry ${dispatch.id}` })
    await waitForCondition(`${config.name} exact DLQ reinjection`, () =>
      bus.filter(record => record.topic === topic && record.payload === dispatchPayload).length === 2)
    await process.waitFor(record =>
      record.type === 'message_start' && eventMessageText(record).includes(dispatchMessage.body), retryStart)
    await waitForCondition(`${config.name} successful retry command`, () =>
      capturedNotifications(capturePath).some(record =>
        typeof record.message === 'string' && record.message.includes(`reinjected: ${dispatch.id}`)))
    await process.command({ type: 'prompt', message: `/synagent dlq retry ${dispatch.id}` })
    await waitForCondition(`${config.name} duplicate retry rejection`, () =>
      capturedNotifications(capturePath).some(record =>
        typeof record.message === 'string' && record.message.includes(`already retried: ${dispatch.id}`)))
    assert.equal(bus.filter(record => record.topic === topic && record.payload === dispatchPayload).length, 2)

    const canonicalDlqDelivery = process.records.some(record =>
      record.type === 'message_start'
      && (eventMessageText(record).includes(invalid.id) || eventMessageText(record).includes(dispatch.id)))
    assert.equal(canonicalDlqDelivery, false)
    console.log(
      `PASS host=${config.name} version=${version} dlq=${dlqTopic} `
      + `invalid=${invalid.cause} dispatch=${dispatch.cause} qos=1 unchanged=true `
      + `list_causes=true listing_rpc_visible=${listingRpcVisible} retry_count=1 canonical_dlq_delivery=0`,
    )
  } finally {
    await process.close().catch(() => undefined)
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
    env: { ...process.env, A4S_MESSAGE_BUS_DB: dbPath, A4S_MESSAGE_BUS_PORT: String(BROKER_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let observer: MqttClient | undefined
  let publisher: MqttClient | undefined
  const bus: BusRecord[] = []
  try {
    await waitForBrokerReady(broker)
    observer = connect(brokerUrl, {
      clean: true,
      clientId: `synagent-live-129-observer-${process.pid}`,
      reconnectPeriod: 0,
    })
    observer.on('message', (topic, payload, packet) => {
      bus.push({ topic, payload: payload.toString('utf8'), qos: packet.qos })
    })
    await subscribeObserver(observer)
    publisher = connect(brokerUrl, {
      clean: true,
      clientId: `synagent-live-129-publisher-${process.pid}`,
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
        model: process.env.SYNAGENT_OMP_MODEL ?? 'anthropic/claude-haiku-5-5',
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
        model: process.env.SYNAGENT_PI_MODEL ?? 'openai-codex/gpt-6.1-sol',
        rpcArgs(sessionDir, extensionPath) {
          return [
            '--mode', 'rpc', '--thinking', 'off', '--no-extensions', '--no-skills', '--no-prompt-templates',
            '--no-context-files', '--offline', '--approve', '--session-dir', sessionDir, '-e', extensionPath,
          ]
        },
      },
    ]
    for (const config of configs) await runHost(config, bus, publisher)
    console.log(`PASS all_hosts=2 broker=${BROKER_PORT} forbidden_1884=false evidence=${root}`)
  } finally {
    if (publisher) await closeClient(publisher).catch(() => undefined)
    if (observer) await closeClient(observer).catch(() => undefined)
    await stopBroker(broker).catch(() => undefined)
  }
}

await main()
