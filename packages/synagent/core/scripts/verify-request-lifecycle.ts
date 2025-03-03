#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

import { parseCanonical, type CanonicalMessage } from '../protocol.ts'

type JsonRecord = Record<string, unknown>
type HostName = 'omp' | 'pi'
type HostConfig = {
  adapterPath: string
  agentDir: string
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
type FileDigest = {
  digest: string
  path: string
}

const TIMEOUT_MS = 240_000
const BROKER_PORT = 18_328
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const brokerPath = join(repoRoot, 'apps', 'message-bus', 'broker.cjs')
const rootOverride = process.env.SYNAGENT_LIVE_ROOT?.trim()
const root = rootOverride
  ? resolve(rootOverride)
  : mkdtempSync(join(tmpdir(), 'synagent-verify-request-lifecycle-'))
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
  ) {
    mkdirSync(stateRoot, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    this.child = spawn(config.bin, config.rpcArgs(sessionDir), {
      cwd: repoRoot,
      env: {
        ...process.env,
        A4S_STATE_ROOT: stateRoot,
        PI_CODING_AGENT_DIR: config.agentDir,
        PI_TELEMETRY: '0',
        SYNAGENT_BROKER_URL: brokerUrl,
        SYNAGENT_REQUEST_TTL: '5',
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
    const deferred = Promise.withResolvers<JsonRecord>()
    const timer = setTimeout(() => {
      this.responseWaiters.delete(id)
      deferred.reject(new Error(`${this.label} timed out waiting for ${String(command.type)}`))
    }, TIMEOUT_MS)
    this.responseWaiters.set(id, { reject: deferred.reject, resolve: deferred.resolve, timer })
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
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
    if (this.child.exitCode !== null) return
    const exited = Promise.withResolvers<void>()
    this.child.once('exit', exited.resolve)
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 5_000)
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

function configDigest(path: string): FileDigest {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { digest: 'absent', path }
    throw error
  }
  try {
    const mode = (fstatSync(fd).mode & 0o777).toString(8).padStart(3, '0')
    const sha256 = createHash('sha256').update(readFileSync(fd)).digest('hex')
    return { digest: `sha256=${sha256},mode=${mode}`, path }
  } finally {
    closeSync(fd)
  }
}

function assertConfigDigests(
  phase: 'before' | 'during' | 'after',
  baseline: readonly FileDigest[],
  host?: HostName,
): void {
  for (const expected of baseline) {
    const actual = configDigest(expected.path)
    assert.equal(actual.digest, expected.digest, `${actual.path} changed ${phase}`)
    console.log(
      `CONFIG phase=${phase}${host ? ` host=${host}` : ''} path=${actual.path} ${actual.digest}`,
    )
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

async function subscribeObserver(client: MqttClient): Promise<void> {
  const connected = Promise.withResolvers<void>()
  client.once('connect', () => connected.resolve())
  client.once('error', error => connected.reject(error))
  await connected.promise
  const subscribed = Promise.withResolvers<void>()
  client.subscribe('synagent/#', { qos: 1 }, error => error ? subscribed.reject(error) : subscribed.resolve())
  await subscribed.promise
}

async function closeObserver(client: MqttClient): Promise<void> {
  const closed = Promise.withResolvers<void>()
  client.end(false, {}, () => closed.resolve())
  await closed.promise
}

async function stopBroker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('exit', exited.resolve)
  child.kill('SIGTERM')
  await exited.promise
}

function listFiles(directory: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) files.push(...listFiles(path))
    else files.push(path)
  }
  return files
}

async function waitForSessionFile(sessionDir: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS
  while (true) {
    const sessionFile = listFiles(sessionDir).find(path => path.endsWith('.jsonl'))
    if (sessionFile) return sessionFile
    if (Date.now() >= deadline) throw new Error(`session file not created under ${sessionDir}`)
    await delay(25)
  }
}

function persistedRequestStatus(sessionFile: string, id: string): string | undefined {
  const entries = readFileSync(sessionFile, 'utf8').split('\n')
  for (let index = entries.length - 1; index >= 0; index--) {
    const line = entries[index]
    if (!line?.trim()) continue
    try {
      const entry = parseJsonRecord(line)
      if (entry.type !== 'custom' || entry.customType !== 'synagent-request' || !isJsonRecord(entry.data)) continue
      if (entry.data.id === id && typeof entry.data.status === 'string') return entry.data.status
    } catch {}
  }
  return undefined
}

async function waitForRequestStatus(sessionFile: string, id: string, status: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (persistedRequestStatus(sessionFile, id) !== status) {
    if (Date.now() >= deadline) throw new Error(`request ${id} did not reach persisted status ${status}`)
    await delay(25)
  }
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
  const output = execFileSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP'], { encoding: 'utf8' })
  const loopback = output.split('\n').filter(line =>
    line.includes('->127.0.0.1:') && line.includes('(ESTABLISHED)'),
  )
  for (const pid of pids) {
    assert.ok(loopback.some(line =>
      line.split(/\s+/)[1] === String(pid) && line.includes(`->127.0.0.1:${BROKER_PORT}`),
    ), `${host} process ${pid} has no connection to private broker ${BROKER_PORT}`)
  }
  assert.ok(loopback.every(line => !line.includes('->127.0.0.1:1884')), `${host} connected to operator broker 1884`)
  console.log(`LSOF host=${host} broker=${BROKER_PORT} forbidden_1884=false`)
}

async function runHost(
  config: HostConfig,
  busMessages: CanonicalMessage[],
  configBaseline: readonly FileDigest[],
): Promise<void> {
  const version = execFileSync(config.bin, ['--version'], { encoding: 'utf8' }).trim()
  assert.ok(version.includes(config.expectedVersion), `${config.name} must be ${config.expectedVersion}; got ${version}`)
  const hostRoot = join(root, config.name)
  const senderSessionDir = join(hostRoot, 'sessions-sender')
  const targetSessionDir = join(hostRoot, 'sessions-target')
  let sender: RpcProcess | undefined
  let target: RpcProcess | undefined
  try {
    sender = new RpcProcess(`${config.name}-sender`, config, join(hostRoot, 'state-sender'), senderSessionDir)
    target = new RpcProcess(`${config.name}-target`, config, join(hostRoot, 'state-target'), targetSessionDir)
    const model = splitModel(config.model)
    await Promise.all([
      sender.command({ type: 'set_model', provider: model.provider, modelId: model.modelId }),
      target.command({ type: 'set_model', provider: model.provider, modelId: model.modelId }),
    ])
    const [senderState, targetState] = await Promise.all([
      sender.command({ type: 'get_state' }),
      target.command({ type: 'get_state' }),
    ])
    assert.ok(isJsonRecord(senderState.data) && isJsonRecord(targetState.data))
    assert.equal(typeof senderState.data.sessionId, 'string')
    assert.equal(typeof targetState.data.sessionId, 'string')
    const senderAddress = `a4s/${senderState.data.sessionId}`
    const targetAddress = `a4s/${targetState.data.sessionId}`
    assertBrokerIsolation([sender, target], config.name)
    assertConfigDigests('during', configBaseline, config.name)

    const expiredPayload = `EXPIRED_PAYLOAD_${config.name.toUpperCase()}_128`
    const expiredBusStart = busMessages.length
    const expiredTargetStart = target.records.length
    const busyExpired = target.command({
      type: 'prompt',
      message: `Use the bash tool exactly once with command "sleep 8; printf BUSY_EXPIRED_${config.name.toUpperCase()}_128", then answer exactly BUSY_EXPIRED_DONE.`,
    })
    await target.waitFor(record => record.type === 'tool_execution_start' && record.toolName === 'bash', expiredTargetStart)
    await sender.command({
      type: 'prompt',
      message: `/mq-send ${targetAddress}: ${expiredPayload}: answer INJECTED only if received.`,
    })
    const expiredRequest = await waitForBus(busMessages, message =>
      message.from === senderAddress && message.to === targetAddress
      && message.kind === 'task.request' && message.body.includes(expiredPayload),
    expiredBusStart)
    const senderSessionFile = await waitForSessionFile(senderSessionDir)
    assert.equal(expiredRequest.deadline, expiredRequest.ts + 5000)
    const expiredEvent = await waitForBus(busMessages, message =>
      message.kind === 'task.expired' && message.reply_to === expiredRequest.id,
    expiredBusStart)
    await busyExpired
    await target.waitFor(record => record.type === config.settleEvent, expiredTargetStart)
    assert.equal(target.records.slice(expiredTargetStart).some(record =>
      record.type === 'message_start' && eventMessageText(record).includes(expiredPayload)), false)
    await sender.command({ type: 'prompt', message: '/synagent pending' })
    await waitForRequestStatus(senderSessionFile, expiredRequest.id, 'expired')
    console.log(
      `EXPIRED host=${config.name} request=${expiredRequest.id} event=${expiredEvent.id} `
      + `reply_to=${expiredEvent.reply_to} injected=false pending=vencido deadline_delta=5000`,
    )

    const cancelledPayload = `CANCELLED_PAYLOAD_${config.name.toUpperCase()}_128`
    const cancelledBusStart = busMessages.length
    const cancelledTargetStart = target.records.length
    const busyCancelled = target.command({
      type: 'prompt',
      message: `Use the bash tool exactly once with command "sleep 8; printf BUSY_CANCEL_${config.name.toUpperCase()}_128", then answer exactly BUSY_CANCEL_DONE.`,
    })
    await target.waitFor(record => record.type === 'tool_execution_start' && record.toolName === 'bash', cancelledTargetStart)
    await sender.command({
      type: 'prompt',
      message: `/mq-send ${targetAddress}: ${cancelledPayload}: answer INJECTED only if received.`,
    })
    const cancelledRequest = await waitForBus(busMessages, message =>
      message.from === senderAddress && message.to === targetAddress
      && message.kind === 'task.request' && message.body.includes(cancelledPayload),
    cancelledBusStart)
    await sender.command({ type: 'prompt', message: `/synagent cancel ${cancelledRequest.id}` })
    const cancel = await waitForBus(busMessages, message =>
      message.from === senderAddress && message.to === targetAddress
      && message.kind === 'task.cancel' && message.reply_to === cancelledRequest.id,
    cancelledBusStart)
    await busyCancelled
    await target.waitFor(record => record.type === config.settleEvent, cancelledTargetStart)
    assert.equal(target.records.slice(cancelledTargetStart).some(record =>
      record.type === 'message_start' && eventMessageText(record).includes(cancelledPayload)), false)
    await sender.command({ type: 'prompt', message: '/synagent pending' })
    await waitForRequestStatus(senderSessionFile, cancelledRequest.id, 'cancelled')
    console.log(
      `CANCELLED host=${config.name} request=${cancelledRequest.id} cancel=${cancel.id} `
      + `reply_to=${cancel.reply_to} injected=false pending=cancelado`,
    )
    console.log(`PASS host=${config.name} version=${config.expectedVersion} model=${config.model}`)
  } finally {
    await Promise.all([
      sender?.close().catch(() => undefined),
      target?.close().catch(() => undefined),
    ])
    assertConfigDigests('during', configBaseline, config.name)
  }
}

async function main(): Promise<void> {
  if (rootOverride) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  }
  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: { ...process.env, A4S_MESSAGE_BUS_DB: dbPath, A4S_MESSAGE_BUS_PORT: String(BROKER_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let observer: MqttClient | undefined
  const busMessages: CanonicalMessage[] = []
  try {
    await waitForBrokerReady(broker)
    observer = connect(brokerUrl, {
      clean: true,
      clientId: `synagent-live-128-${process.pid}`,
      reconnectPeriod: 0,
    })
    observer.on('message', (_topic, payload) => busMessages.push(parseCanonical(payload.toString('utf8'))))
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
        agentDir: join(homedir(), '.pi', 'agent'),
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
    const configBaseline = configs.map(config => configDigest(join(config.agentDir, 'synagent.json')))
    assertConfigDigests('before', configBaseline)
    for (const config of configs) await runHost(config, busMessages, configBaseline)
    assertConfigDigests('after', configBaseline)
    console.log(`PASS all_hosts=2 broker=${BROKER_PORT} forbidden_1884=false configs_unchanged=true evidence=${root}`)
  } finally {
    if (observer) await closeObserver(observer).catch(() => undefined)
    await stopBroker(broker).catch(() => undefined)
  }
}

await main()
