#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

import { serialize, type CanonicalMessage } from '../protocol.ts'

type JsonRecord = Record<string, unknown>
type HostName = 'omp' | 'pi'
type HostConfig = {
  agentDir?: string
  bin: string
  expectedVersion: string
  model: string
  name: HostName
  rpcArgs: (sessionDir: string, sessionFile?: string) => string[]
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
const BROKER_PORT = 18_327
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const brokerPath = join(repoRoot, 'packages', 'synagent', 'bus', 'broker.cjs')
const rootOverride = process.env.SYNAGENT_LIVE_ROOT?.trim()
const root = rootOverride
  ? resolve(rootOverride)
  : mkdtempSync(join(tmpdir(), 'synagent-verify-delivery-recovery-'))
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
    sessionFile?: string,
  ) {
    mkdirSync(stateRoot, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    this.child = spawn(config.bin, config.rpcArgs(sessionDir, sessionFile), {
      cwd: repoRoot,
      detached: true,
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

  async kill(signal: NodeJS.Signals): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const pid = this.child.pid
    if (pid === undefined) throw new Error(`${this.label} has no process id`)
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>()
    this.child.once('exit', () => resolveExit())
    process.kill(-pid, signal)
    await exited
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const pid = this.child.pid
    if (pid === undefined) throw new Error(`${this.label} has no process id`)
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>()
    this.child.once('exit', () => resolveExit())
    this.child.stdin.end()
    const timer = setTimeout(() => process.kill(-pid, 'SIGTERM'), 5_000)
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

async function connectPublisher(client: MqttClient): Promise<void> {
  const connected = Promise.withResolvers<void>()
  client.once('connect', () => connected.resolve())
  client.once('error', connected.reject)
  await connected.promise
}

async function publish(client: MqttClient, topic: string, message: CanonicalMessage): Promise<void> {
  const published = Promise.withResolvers<void>()
  client.publish(topic, serialize(message), { qos: 1 }, error => {
    if (error) published.reject(error)
    else published.resolve()
  })
  await published.promise
}

async function closePublisher(client: MqttClient): Promise<void> {
  const closed = Promise.withResolvers<void>()
  client.end(false, {}, () => closed.resolve())
  await closed.promise
}

async function stopBroker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>()
  child.once('exit', () => resolveExit())
  child.kill('SIGTERM')
  await exited
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

function sessionEntries(sessionFile: string): JsonRecord[] {
  return readFileSync(sessionFile, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      return [parseJsonRecord(line)]
    } catch {
      return []
    }
  })
}

function persistedPending(sessionFile: string, id: string): JsonRecord | undefined {
  return sessionEntries(sessionFile).find(entry => {
    if (entry.type !== 'custom' || entry.customType !== 'synagent-pending') return false
    const data = entry.data
    if (!isJsonRecord(data) || !isJsonRecord(data.message)) return false
    return data.message.id === id && typeof data.marker === 'string'
  })
}

function persistedDelivered(sessionFile: string, id: string): boolean {
  return sessionEntries(sessionFile).some(entry => {
    if (entry.type !== 'custom' || entry.customType !== 'synagent-delivered') return false
    return isJsonRecord(entry.data) && entry.data.id === id
  })
}

function persistedUserCount(sessionFile: string, marker: string): number {
  return sessionEntries(sessionFile).filter(entry => {
    if (entry.type !== 'message' || !isJsonRecord(entry.message) || entry.message.role !== 'user') return false
    return messageText(entry.message.content).startsWith(`${marker}\n`)
  }).length
}

async function waitForCondition(description: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await delay(25)
  }
}

async function assertBrokerIsolation(process: RpcProcess, host: HostName, phase: string): Promise<void> {
  const pid = process.child.pid
  assert.equal(typeof pid, 'number')
  let output = ''
  await waitForCondition(`${host} ${phase} private broker connection`, () => {
    try {
      output = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP'], { encoding: 'utf8' })
    } catch {
      return false
    }
    return output.includes(`->127.0.0.1:${BROKER_PORT}`)
  })
  const loopback = output.split('\n').filter(line =>
    line.includes('->127.0.0.1:') && line.includes('(ESTABLISHED)'),
  )
  assert.ok(loopback.some(line => line.includes(`->127.0.0.1:${BROKER_PORT}`)))
  assert.ok(loopback.every(line => !line.includes('->127.0.0.1:1884')), `${host} connected to operator broker 1884`)
  console.log(
    `LSOF host=${host} phase=${phase} pid=${pid} broker=${BROKER_PORT} `
    + `connections=${loopback.filter(line => line.includes(`->127.0.0.1:${BROKER_PORT}`)).length} forbidden_1884=false`,
  )
}

function diagnosticCount(stateRoot: string, eventName: string): number {
  if (!statSync(stateRoot, { throwIfNoEntry: false })) return 0
  let count = 0
  for (const path of listFiles(stateRoot).filter(path => path.endsWith('.jsonl'))) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        if (parseJsonRecord(line).event_name === eventName) ++count
      } catch {}
    }
  }
  return count
}

async function runHost(config: HostConfig, publisher: MqttClient): Promise<void> {
  const version = execFileSync(config.bin, ['--version'], { encoding: 'utf8' }).trim()
  assert.ok(version.includes(config.expectedVersion), `${config.name} must be ${config.expectedVersion}; got ${version}`)
  const hostRoot = join(root, config.name)
  const stateRoot = join(hostRoot, 'state')
  const sessionDir = join(hostRoot, 'sessions')
  const initial = new RpcProcess(`${config.name}-initial`, config, stateRoot, sessionDir)
  let resumed: RpcProcess | undefined
  try {
    await assertBrokerIsolation(initial, config.name, 'initial')
    const model = splitModel(config.model)
    await initial.command({ type: 'set_model', provider: model.provider, modelId: model.modelId })
    const state = await initial.command({ type: 'get_state' })
    assert.ok(isJsonRecord(state.data))
    const sessionId = state.data.sessionId
    assert.equal(typeof sessionId, 'string')
    const busyStart = initial.records.length
    await initial.command({
      type: 'prompt',
      message: 'Use the bash tool exactly once with command "sleep 120" and timeout 0. Do not answer before it finishes.',
    })
    await initial.waitFor(record =>
      record.type === 'tool_execution_start'
      && record.toolName === 'bash'
      && isJsonRecord(record.args)
      && record.args.command === 'sleep 120',
    busyStart)
    const sessionFile = await waitForSessionFile(sessionDir)

    const message: CanonicalMessage = {
      id: `impl127-${config.name}-${Date.now()}`,
      from: 'a4s/impl127-source',
      to: `a4s/${sessionId}`,
      kind: 'note.published',
      body: `Reply exactly RECOVERED_${config.name.toUpperCase()}_127. Do not use tools.`,
      ts: Date.now(),
    }
    await publish(publisher, `synagent/v2/a4s/${sessionId}`, message)
    await waitForCondition(`${config.name} pending session entry`, () => persistedPending(sessionFile, message.id) !== undefined)
    const pending = persistedPending(sessionFile, message.id)
    assert.ok(pending)
    assert.ok(isJsonRecord(pending.data))
    const marker = pending.data.marker
    if (typeof marker !== 'string') throw new TypeError('pending marker must be a string')
    assert.equal(persistedUserCount(sessionFile, marker), 0)
    console.log(`PERSISTED host=${config.name} id=${message.id} marker=${marker} user_injections=0`)

    await initial.kill('SIGKILL')
    console.log(`SIGKILL host=${config.name} signal=SIGKILL`)

    resumed = new RpcProcess(`${config.name}-resume`, config, stateRoot, sessionDir, sessionFile)
    await assertBrokerIsolation(resumed, config.name, 'resume')
    const injection = await resumed.waitFor(record =>
      record.type === 'message_start' && eventMessageText(record).startsWith(`${marker}\n`))
    const injectionIndex = resumed.records.indexOf(injection)
    await resumed.waitFor(record => record.type === config.settleEvent, injectionIndex)
    await waitForCondition(`${config.name} delivered session entry`, () => persistedDelivered(sessionFile, message.id))
    await waitForCondition(`${config.name} persisted user turn`, () => persistedUserCount(sessionFile, marker) === 1)

    const duplicateEvent = `synagent.${config.name}.message.duplicate`
    const duplicatesBefore = diagnosticCount(stateRoot, duplicateEvent)
    await publish(publisher, `synagent/v2/a4s/${sessionId}`, message)
    await waitForCondition(`${config.name} duplicate diagnostic`, () =>
      diagnosticCount(stateRoot, duplicateEvent) > duplicatesBefore)
    assert.equal(
      resumed.records.filter(record =>
        record.type === 'message_start' && eventMessageText(record).startsWith(`${marker}\n`)).length,
      1,
    )
    assert.equal(persistedUserCount(sessionFile, marker), 1)
    console.log(
      `LIVE host=${config.name} session=${sessionId} id=${message.id} sigkill=true resumed=true `
      + 'injections=1 resend_seen=discarded duplicate_diagnostic=true',
    )
    console.log(`PASS host=${config.name} version=${config.expectedVersion} model=${config.model}`)
  } finally {
    await initial.close().catch(() => undefined)
    await resumed?.close().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  if (rootOverride) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  }
  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SYNAGENT_DB: dbPath,
      SYNAGENT_PORT: String(BROKER_PORT),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let publisher: MqttClient | undefined
  try {
    await waitForBrokerReady(broker)
    publisher = connect(brokerUrl, {
      clean: true,
      clientId: `synagent-live-127-${process.pid}`,
      reconnectPeriod: 0,
    })
    await connectPublisher(publisher)
    const ompAdapterPath = join(coreRoot, 'adapters', 'omp', 'index.ts')
    const piAdapterPath = join(coreRoot, 'adapters', 'pi', 'index.ts')
    const configs: HostConfig[] = [
      {
        name: 'omp',
        expectedVersion: '18.11.0',
        bin: process.env.OMP_BIN ?? join(homedir(), '.bun', 'bin', 'omp'),
        agentDir: join(homedir(), '.omp', 'agent'),
        model: process.env.SYNAGENT_OMP_MODEL ?? 'anthropic/claude-haiku-5-5',
        settleEvent: 'agent_end',
        rpcArgs(sessionDir, sessionFile) {
          return [
            '--mode', 'rpc', '--no-ui', '--no-extensions', '--no-skills', '--no-rules', '--no-title',
            '--no-lsp', '--no-pty', '--tools', 'bash', '--auto-approve', '--thinking', 'off',
            '--session-dir', sessionDir,
            ...(sessionFile ? ['--resume', sessionFile] : []),
            '-e', ompAdapterPath,
          ]
        },
      },
      {
        name: 'pi',
        expectedVersion: '1.0.3',
        bin: process.env.PI_BIN ?? join(homedir(), '.local', 'bin', 'pi'),
        model: process.env.SYNAGENT_PI_MODEL ?? 'openai-codex/gpt-6.1-sol',
        settleEvent: 'agent_settled',
        rpcArgs(sessionDir, sessionFile) {
          return [
            '--mode', 'rpc', '--thinking', 'off', '--no-extensions', '--no-skills', '--no-prompt-templates',
            '--no-context-files', '--offline', '--approve', '--session-dir', sessionDir,
            ...(sessionFile ? ['--session', sessionFile] : []),
            '-e', piAdapterPath,
          ]
        },
      },
    ]
    for (const config of configs) await runHost(config, publisher)
    console.log(`PASS all_hosts=2 broker=${BROKER_PORT} forbidden_1884=false evidence=${root}`)
  } finally {
    if (publisher) await closePublisher(publisher).catch(() => undefined)
    await stopBroker(broker).catch(() => undefined)
  }
}

await main()
