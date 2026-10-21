#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

import { parseCanonical, type CanonicalMessage } from '../protocol.ts'

type JsonRecord = Record<string, unknown>
type HostName = 'omp' | 'pi'
type HostConfig = {
  adapterPath: string
  agentDir?: string
  bin: string
  expectedVersion: string
  model: string
  name: HostName
  rpcArgs: (sessionDir: string) => string[]
  settleEvent: 'agent_end' | 'agent_settled'
}
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
const BROKER_PORT = 18_326
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const brokerPath = join(repoRoot, 'apps', 'message-bus', 'broker.cjs')
const rootOverride = process.env.SYNAGENT_LIVE_ROOT?.trim()
const root = rootOverride
  ? resolve(rootOverride)
  : mkdtempSync(join(tmpdir(), 'synagent-verify-delivery-events-'))
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
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`model must use provider/model-id: ${model}`)
  }
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
  if (!isJsonRecord(message)) return ''
  return messageText(message.content)
}

function delay(ms: number): Promise<void> {
  const { promise, resolve: resolveDelay } = Promise.withResolvers<void>()
  setTimeout(resolveDelay, ms)
  return promise
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
  ) {
    mkdirSync(stateRoot, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    this.child = spawn(config.bin, config.rpcArgs(sessionDir), {
      cwd: repoRoot,
      env: {
        ...process.env,
        A4S_STATE_ROOT: stateRoot,
        PI_TELEMETRY: '0',
        SYNAGENT_BROKER_URL: brokerUrl,
        ...(config.agentDir ? { PI_CODING_AGENT_DIR: config.agentDir } : {}),
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
    const payload = { ...command, id }
    const { promise, resolve: resolveResponse, reject: rejectResponse } = Promise.withResolvers<JsonRecord>()
    const timer = setTimeout(() => {
      this.responseWaiters.delete(id)
      rejectResponse(new Error(`${this.label} timed out waiting for ${String(command.type)}`))
    }, TIMEOUT_MS)
    this.responseWaiters.set(id, { reject: rejectResponse, resolve: resolveResponse, timer })
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
      if (!error) return
      clearTimeout(timer)
      this.responseWaiters.delete(id)
      rejectResponse(error)
    })
    return promise.then(record => {
      if (record.success !== true) {
        throw new Error(`${this.label} ${String(command.type)} failed: ${JSON.stringify(record)}`)
      }
      return record
    })
  }

  waitFor(predicate: (record: JsonRecord) => boolean, after = 0): Promise<JsonRecord> {
    const found = this.records.slice(after).find(predicate)
    if (found) return Promise.resolve(found)
    const { promise, resolve: resolveRecord, reject: rejectRecord } = Promise.withResolvers<JsonRecord>()
    const waiter: RecordWaiter = {
      after,
      predicate,
      reject: rejectRecord,
      resolve: resolveRecord,
      timer: setTimeout(() => {
        this.recordWaiters.delete(waiter)
        rejectRecord(new Error(
          `${this.label} timed out waiting for event; stderr=${this.stderr.join('').slice(-2000)}`,
        ))
      }, TIMEOUT_MS),
    }
    this.recordWaiters.add(waiter)
    return promise
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>()
    this.child.once('exit', () => resolveExit())
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 5_000)
    await exited
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
  const { promise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>()
  const timer = setTimeout(() => rejectReady(new Error(`broker readiness timed out: ${errors}`)), 30_000)
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (!output.includes(`BROKER READY :${BROKER_PORT}`)) return
    clearTimeout(timer)
    resolveReady()
  })
  child.once('exit', (code, signal) => {
    clearTimeout(timer)
    rejectReady(new Error(`broker exited code=${String(code)} signal=${String(signal)}: ${errors}`))
  })
  await promise
}

async function subscribeObserver(client: MqttClient): Promise<void> {
  const connected = Promise.withResolvers<void>()
  client.once('connect', () => connected.resolve())
  client.once('error', connected.reject)
  await connected.promise
  const subscribed = Promise.withResolvers<void>()
  client.subscribe('synagent/#', { qos: 1 }, error => {
    if (error) subscribed.reject(error)
    else subscribed.resolve()
  })
  await subscribed.promise
}

async function closeObserver(client: MqttClient): Promise<void> {
  const closed = Promise.withResolvers<void>()
  client.end(false, {}, () => closed.resolve())
  await closed.promise
}

async function stopBroker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>()
  child.once('exit', () => resolveExit())
  child.kill('SIGTERM')
  await exited
}

async function waitForBus(
  messages: CanonicalMessage[],
  predicate: (message: CanonicalMessage) => boolean,
  after: number,
): Promise<CanonicalMessage> {
  const deadline = Date.now() + TIMEOUT_MS
  while (true) {
    const found = messages.slice(after).find(predicate)
    if (found) return found
    if (Date.now() >= deadline) throw new Error('timed out waiting for canonical bus message')
    await delay(25)
  }
}

function assertBrokerIsolation(processes: readonly RpcProcess[], host: HostName): void {
  const pids = processes.map(process => process.child.pid)
  assert.ok(pids.every((pid): pid is number => typeof pid === 'number'))
  const output = execFileSync('lsof', [
    '-nP', '-a', '-p', pids.join(','), '-iTCP',
  ], { encoding: 'utf8' })
  const loopback = output.split('\n').filter(line =>
    line.includes('->127.0.0.1:') && line.includes('(ESTABLISHED)'),
  )
  for (const pid of pids) {
    assert.ok(loopback.some(line =>
      line.split(/\s+/)[1] === String(pid) && line.includes(`->127.0.0.1:${BROKER_PORT}`),
    ), `${host} process ${pid} has no connection to private broker ${BROKER_PORT}`)
  }
  assert.ok(loopback.every(line => !line.includes('->127.0.0.1:1884')), `${host} connected to operator broker 1884`)
  const privateConnections = loopback.filter(line => line.includes(`->127.0.0.1:${BROKER_PORT}`))
  console.log(
    `LSOF host=${host} pids=${pids.join(',')} broker=${BROKER_PORT} `
    + `connections=${privateConnections.length} forbidden_1884=false`,
  )
}

async function runHost(config: HostConfig, busMessages: CanonicalMessage[]): Promise<void> {
  const version = execFileSync(config.bin, ['--version'], { encoding: 'utf8' }).trim()
  assert.ok(version.includes(config.expectedVersion), `${config.name} must be ${config.expectedVersion}; got ${version}`)
  const hostRoot = join(root, config.name)
  const a = new RpcProcess('a', config, join(hostRoot, 'state-a'), join(hostRoot, 'sessions-a'))
  const b = new RpcProcess('b', config, join(hostRoot, 'state-b'), join(hostRoot, 'sessions-b'))
  try {
    const model = splitModel(config.model)
    await Promise.all([
      a.command({ type: 'set_model', provider: model.provider, modelId: model.modelId }),
      b.command({ type: 'set_model', provider: model.provider, modelId: model.modelId }),
    ])
    const [aState, bState] = await Promise.all([
      a.command({ type: 'get_state' }),
      b.command({ type: 'get_state' }),
    ])
    assert.ok(isJsonRecord(aState.data))
    assert.ok(isJsonRecord(bState.data))
    const aSession = aState.data.sessionId
    const bSession = bState.data.sessionId
    assert.equal(typeof aSession, 'string')
    assert.equal(typeof bSession, 'string')
    const aAddress = `a4s/${aSession}`
    const bAddress = `a4s/${bSession}`
    assertBrokerIsolation([a, b], config.name)

    const requestBody = `Use the bash tool exactly once with command "printf TOOL_${config.name.toUpperCase()}_126", then answer exactly FINAL_${config.name.toUpperCase()}_126. Do not call synagent_send.`
    const busStart = busMessages.length
    const aStart = a.records.length
    const bStart = b.records.length
    await a.command({
      type: 'prompt',
      message: `Call synagent_send exactly once with to=${JSON.stringify(bAddress)}, kind="task.request", and body=${JSON.stringify(requestBody)}. Do not call any other tool. Then answer exactly REQUEST_SENT.`,
    })
    const request = await waitForBus(busMessages, message =>
      message.from === aAddress
      && message.to === bAddress
      && message.kind === 'task.request'
      && message.body === requestBody,
    busStart)
    const [delivered, completed] = await Promise.all([
      waitForBus(busMessages, message =>
        message.kind === 'task.delivered' && message.causation_id === request.id,
      busStart),
      waitForBus(busMessages, message =>
        message.kind === 'task.completed' && message.causation_id === request.id,
      busStart),
    ])
    assert.equal(request.correlation_id, request.id)
    assert.equal(delivered.correlation_id, request.id)
    assert.equal(completed.correlation_id, request.id)
    assert.equal(completed.body.trim(), `FINAL_${config.name.toUpperCase()}_126`)
    assert.equal(delivered.to, aAddress)
    assert.equal(completed.to, aAddress)
    assert.ok(b.records.slice(bStart).some(record =>
      record.type === 'tool_execution_start' && record.toolName === 'bash'))
    assert.equal(b.records.slice(bStart).some(record =>
      record.type === 'tool_execution_start' && String(record.toolName).includes('synagent')),
    false)
    const injected = await a.waitFor(record =>
      record.type === 'message_start'
      && eventMessageText(record).includes('[bus:task.completed]')
      && eventMessageText(record).includes(request.id),
    aStart)
    await Promise.all([
      a.waitFor(record => record.type === config.settleEvent, a.records.indexOf(injected)),
      b.waitFor(record => record.type === config.settleEvent, bStart),
    ])
    console.log(
      `LIVE host=${config.name} request=${request.id} delivered=${delivered.id} completed=${completed.id} `
      + `correlation=${completed.correlation_id} body=${JSON.stringify(completed.body)} `
      + 'b_bash_calls=1 b_synagent_calls=0 sender_injected=true',
    )

    const mutualStart = busMessages.length
    const mutualAStart = a.records.length
    const mutualBStart = b.records.length
    const bodyToA = `Reply exactly MUTUAL_${config.name.toUpperCase()}_A. Do not use tools or call synagent_send.`
    const bodyToB = `Reply exactly MUTUAL_${config.name.toUpperCase()}_B. Do not use tools or call synagent_send.`
    await Promise.all([
      a.command({
        type: 'prompt',
        message: `Call synagent_send exactly once with to=${JSON.stringify(bAddress)}, kind="task.request", and body=${JSON.stringify(bodyToB)}. Do not call any other tool.`,
      }),
      b.command({
        type: 'prompt',
        message: `Call synagent_send exactly once with to=${JSON.stringify(aAddress)}, kind="task.request", and body=${JSON.stringify(bodyToA)}. Do not call any other tool.`,
      }),
    ])
    const [requestA, requestB] = await Promise.all([
      waitForBus(busMessages, message =>
        message.from === aAddress && message.to === bAddress
        && message.kind === 'task.request' && message.body === bodyToB,
      mutualStart),
      waitForBus(busMessages, message =>
        message.from === bAddress && message.to === aAddress
        && message.kind === 'task.request' && message.body === bodyToA,
      mutualStart),
    ])
    const completedA = await waitForBus(busMessages, message =>
      message.kind === 'task.completed' && message.causation_id === requestA.id,
    mutualStart)
    const completedB = await waitForBus(busMessages, message =>
      message.kind === 'task.completed' && message.causation_id === requestB.id,
    mutualStart)
    const [injectedA, injectedB] = await Promise.all([
      a.waitFor(record =>
        record.type === 'message_start'
        && eventMessageText(record).includes('[bus:task.completed]')
        && eventMessageText(record).includes(requestA.id),
      mutualAStart),
      b.waitFor(record =>
        record.type === 'message_start'
        && eventMessageText(record).includes('[bus:task.completed]')
        && eventMessageText(record).includes(requestB.id),
      mutualBStart),
    ])
    await Promise.all([
      a.waitFor(record => record.type === config.settleEvent, a.records.indexOf(injectedA)),
      b.waitFor(record => record.type === config.settleEvent, b.records.indexOf(injectedB)),
    ])
    await delay(1_000)
    const mutualMessages = busMessages.slice(mutualStart).filter(message =>
      (message.from === aAddress || message.from === bAddress)
      && (message.to === aAddress || message.to === bAddress),
    )
    assert.deepEqual(
      Object.fromEntries(['task.request', 'task.delivered', 'task.completed'].map(kind => [
        kind, mutualMessages.filter(message => message.kind === kind).length,
      ])),
      { 'task.request': 2, 'task.delivered': 2, 'task.completed': 2 },
    )
    assert.equal(mutualMessages.length, 6)
    for (const event of mutualMessages.filter(message =>
      message.kind === 'task.delivered' || message.kind === 'task.completed')) {
      assert.ok(event.causation_id === requestA.id || event.causation_id === requestB.id)
      assert.equal(event.correlation_id, event.causation_id)
    }
    assert.equal(completedA.correlation_id, requestA.id)
    assert.equal(completedB.correlation_id, requestB.id)
    console.log(
      `MUTUAL host=${config.name} requests=2 delivered=2 completed=2 total=6 `
      + 'event_caused_events=0 loop=false',
    )
    console.log(`PASS host=${config.name} version=${config.expectedVersion} model=${config.model}`)
  } finally {
    await Promise.all([a.close().catch(() => undefined), b.close().catch(() => undefined)])
  }
}

async function main(): Promise<void> {
  mkdirSync(root, { recursive: true })
  rmSync(dbPath, { recursive: true, force: true })
  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      A4S_MESSAGE_BUS_DB: dbPath,
      A4S_MESSAGE_BUS_PORT: String(BROKER_PORT),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let observer: MqttClient | undefined
  const busMessages: CanonicalMessage[] = []
  try {
    await waitForBrokerReady(broker)
    observer = connect(brokerUrl, {
      clean: true,
      clientId: `synagent-live-126-${process.pid}`,
      reconnectPeriod: 0,
    })
    observer.on('message', (_topic, payload) => {
      busMessages.push(parseCanonical(payload.toString('utf8')))
    })
    await subscribeObserver(observer)
    const ompAdapterPath = join(coreRoot, 'adapters', 'omp', 'index.ts')
    const piAdapterPath = join(coreRoot, 'adapters', 'pi', 'index.ts')
    const configs: HostConfig[] = [
      {
        name: 'omp',
        expectedVersion: '18.11.0',
        bin: process.env.OMP_BIN ?? join(homedir(), '.bun', 'bin', 'omp'),
        adapterPath: ompAdapterPath,
        agentDir: join(homedir(), '.omp', 'agent'),
        model: process.env.SYNAGENT_OMP_MODEL ?? 'anthropic/claude-haiku-5-5',
        settleEvent: 'agent_end',
        rpcArgs(sessionDir) {
          return [
            '--mode', 'rpc', '--no-ui', '--no-extensions', '--no-skills', '--no-rules', '--no-title',
            '--no-lsp', '--no-pty', '--tools', 'bash', '--auto-approve', '--thinking', 'off',
            '--session-dir', sessionDir, '-e', ompAdapterPath,
          ]
        },
      },
      {
        name: 'pi',
        expectedVersion: '1.0.3',
        bin: process.env.PI_BIN ?? join(homedir(), '.local', 'bin', 'pi'),
        adapterPath: piAdapterPath,
        model: process.env.SYNAGENT_PI_MODEL ?? 'openai-codex/gpt-6.1-sol',
        settleEvent: 'agent_settled',
        rpcArgs(sessionDir) {
          return [
            '--mode', 'rpc', '--thinking', 'off', '--no-extensions', '--no-skills', '--no-prompt-templates',
            '--no-context-files', '--offline', '--approve', '--session-dir', sessionDir, '-e', piAdapterPath,
          ]
        },
      },
    ]
    for (const config of configs) await runHost(config, busMessages)
    console.log(`PASS all_hosts=2 broker=${BROKER_PORT} forbidden_1884=false evidence=${root}`)
  } finally {
    if (observer) await closeObserver(observer).catch(() => undefined)
    await stopBroker(broker).catch(() => undefined)
  }
}

await main()
