#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

import { parseCanonical, type CanonicalMessage } from '../protocol.ts'

type JsonRecord = Record<string, unknown>
type RecordWaiter = {
  after: number
  predicate: (record: JsonRecord) => boolean
  reject: (error: Error) => void
  resolve: (record: JsonRecord) => void
  timer: NodeJS.Timeout
}
type Session = {
  address: string
  close(): Promise<void>
  command(text: string): Promise<void>
  pids(): number[]
}

const TIMEOUT_MS = 180_000
const BROKER_PORT = 18_332
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const brokerPath = join(repoRoot, 'apps', 'message-bus', 'broker.cjs')
const rootOverride = process.env.SYNAGENT_LIVE_ROOT?.trim()
const root = rootOverride
  ? resolve(rootOverride)
  : mkdtempSync(join(tmpdir(), 'synagent-verify-offer-race-'))
const dbPath = join(root, 'db')
const brokerUrl = `mqtt://127.0.0.1:${BROKER_PORT}`
const runtimeNodeModules = resolve(createRequire(import.meta.url).resolve('mqtt/package.json'), '../..')
const agentDirs = new Map<'omp' | 'pi', string>()

const PYTHON_PTY_DRIVER = String.raw`
import os, pty, select, signal, sys, time

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

stopping = False
def request_stop(_signum, _frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGINT, request_stop)
status = None
try:
    while not stopping:
        waited, value = os.waitpid(pid, os.WNOHANG)
        if waited:
            status = value
            break
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            os.write(master, data)
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    deadline = time.monotonic() + 5
    while status is None and time.monotonic() < deadline:
        waited, value = os.waitpid(pid, os.WNOHANG)
        if waited:
            status = value
            break
        time.sleep(0.05)
    if status is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        _, status = os.waitpid(pid, 0)
    os.close(master)

sys.exit(os.waitstatus_to_exitcode(status))
`
function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  const deferred = Promise.withResolvers<void>()
  setTimeout(deferred.resolve, ms)
  return deferred.promise
}

function prepareAgentDir(host: 'omp' | 'pi'): string {
  const existing = agentDirs.get(host)
  if (existing) return existing
  const source = join(homedir(), host === 'pi' ? '.pi' : '.omp', 'agent')
  const destination = join(root, 'config', host)
  if (existsSync(source)) cpSync(source, destination, { recursive: true })
  else mkdirSync(destination, { recursive: true, mode: 0o700 })
  const settingsPath = join(destination, 'synagent.json')
  rmSync(settingsPath, { force: true })
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ 'accept-offers': true }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  )
  agentDirs.set(host, destination)
  return destination
}

function processFamily(pid: number | undefined): number[] {
  if (pid === undefined) return []
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map(row => row.trim().split(/\s+/).map(Number))
  const family = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const [child, parent] of rows) {
      if (child && parent && family.has(parent) && !family.has(child)) {
        family.add(child)
        changed = true
      }
    }
  }
  return [...family]
}

class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly records: JsonRecord[] = []
  readonly stderr: string[] = []
  private buffer = ''
  private readonly waiters = new Set<RecordWaiter>()

  constructor(label: string, bin: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(bin, args, {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.consume(String(chunk)))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => this.stderr.push(String(chunk)))
    this.child.once('exit', (code, signal) => {
      const error = new Error(
        `${label} exited code=${String(code)} signal=${String(signal)} stderr=${this.stderr.join('').slice(-4000)}`,
      )
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.waiters.clear()
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
        this.waiters.delete(waiter)
        deferred.reject(new Error(`record timeout stderr=${this.stderr.join('').slice(-4000)}`))
      }, TIMEOUT_MS),
    }
    this.waiters.add(waiter)
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
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (!isJsonRecord(value)) continue
      this.records.push(value)
      for (const waiter of this.waiters) {
        if (this.records.length <= waiter.after || !waiter.predicate(value)) continue
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve(value)
      }
    }
  }
}

class RpcSession implements Session {
  readonly process: JsonLineProcess
  address = ''
  private sequence = 0

  private constructor(readonly host: 'omp' | 'pi', process: JsonLineProcess) {
    this.process = process
  }

  static async start(host: 'omp' | 'pi', name: string): Promise<RpcSession> {
    const adapterPath = join(coreRoot, 'adapters', host, 'index.ts')
    const sessionDir = join(root, 'sessions', name)
    mkdirSync(sessionDir, { recursive: true })
    const bin = host === 'pi'
      ? process.env.PI_BIN ?? join(homedir(), '.local', 'bin', 'pi')
      : process.env.OMP_BIN ?? join(homedir(), '.bun', 'bin', 'omp')
    const args = host === 'pi'
      ? [
          '--mode', 'rpc', '--thinking', 'off', '--no-extensions', '--no-skills', '--no-prompt-templates',
          '--no-context-files', '--offline', '--approve', '--session-dir', sessionDir, '-e', adapterPath,
        ]
      : [
          '--mode', 'rpc', '--no-ui', '--no-extensions', '--no-skills', '--no-rules', '--no-title',
          '--no-lsp', '--no-pty', '--tools', 'bash', '--auto-approve', '--thinking', 'off',
          '--session-dir', sessionDir, '-e', adapterPath,
        ]
    const runner = new JsonLineProcess(name, bin, args, {
      ...process.env,
      A4S_STATE_ROOT: join(root, 'state', name),
      PI_CODING_AGENT_DIR: prepareAgentDir(host),
      PI_TELEMETRY: '0',
      SYNAGENT_BROKER_URL: brokerUrl,
    })
    const session = new RpcSession(host, runner)
    const state = await session.request({ type: 'get_state' })
    assert.ok(isJsonRecord(state.data) && typeof state.data.sessionId === 'string')
    session.address = `a4s/${state.data.sessionId}`
    return session
  }

  async command(text: string): Promise<void> {
    await this.request({ type: 'prompt', message: text })
  }

  close(): Promise<void> {
    return this.process.close()
  }

  pids(): number[] {
    return processFamily(this.process.child.pid)
  }

  private request(command: JsonRecord): Promise<JsonRecord> {
    const id = `${this.host}-${++this.sequence}`
    const response = this.process.waitFor(record => record.type === 'response' && record.id === id)
    this.process.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    return response.then(record => {
      if (record.success !== true) throw new Error(`${this.host} command failed: ${JSON.stringify(record)}`)
      return record
    })
  }
}

class TerminalProcess {
  readonly child: ChildProcessWithoutNullStreams
  output = ''
  stderr = ''

  constructor(label: string, argv: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.env.PYTHON_BIN ?? 'python3', ['-u', '-c', PYTHON_PTY_DRIVER, ...argv], {
      cwd: repoRoot,
      detached: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      this.output = `${this.output}${String(chunk)}`.slice(-1_000_000)
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-100_000)
    })
    this.child.once('error', error => {
      this.stderr += `${label}: ${error.message}`
    })
  }

  async waitForText(text: string, count = 1): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.output.split(text).length - 1 >= count) return
      if (this.child.exitCode !== null) {
        throw new Error(
          `Claude exited ${this.child.exitCode}: stderr=${this.stderr} output=${this.output.slice(-4000)}`,
        )
      }
      await delay(20)
    }
    throw new Error(`Claude output timeout for ${text}: ${this.stderr || this.output.slice(-4000)}`)
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return
    const exited = Promise.withResolvers<void>()
    this.child.once('exit', exited.resolve)
    const pid = this.child.pid
    this.child.stdin.write('\u0003')
    await delay(100)
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {}
    }
    const force = setTimeout(() => {
      if (pid === undefined) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }, 5_000)
    await exited.promise
    clearTimeout(force)
  }
}

class ClaudeSession implements Session {
  readonly address: string

  private constructor(readonly process: TerminalProcess, readonly sessionId: string) {
    this.address = `a4s/${sessionId}`
  }

  static async start(name: string, pluginRoot: string, settingsPath: string): Promise<ClaudeSession> {
    const sessionId = randomUUID()
    const model = process.env.SYNAGENT_CLAUDE_MODEL ?? 'haiku'
    const debugPath = join(root, `${name}-debug.log`)
    writeFileSync(debugPath, '', { flag: 'wx', mode: 0o600 })
    const runner = new TerminalProcess(name, [
      process.env.CLAUDE_BIN ?? 'claude',
      '--model', model,
      '--effort', 'low',
      '--setting-sources', '',
      '--settings', settingsPath,
      '--plugin-dir', pluginRoot,
      '--strict-mcp-config',
      '--tools', '',
      '--permission-mode', 'dontAsk',
      '--ax-screen-reader',
      '--debug-file', debugPath,
      '--session-id', sessionId,
      'Reply exactly CLAUDE_READY. Do not use tools.',
    ], {
      ...process.env,
      A4S_STATE_ROOT: join(root, 'state', name),
    })
    const session = new ClaudeSession(runner, sessionId)
    await runner.waitForText('CLAUDE_READY', 2)
    await delay(500)
    const debug = readFileSync(debugPath, 'utf8')
    if (!debug.includes('hooks module synagent-adapter-mqtt@inline')) {
      throw new Error(`Claude did not load Synagent plugin: ${debug.slice(-4000)}`)
    }
    if (debug.includes('Cannot find module')) {
      throw new Error(`Claude Synagent plugin dependency failure: ${debug.slice(-4000)}`)
    }
    console.log('CLAUDE PLUGIN synagent-adapter-mqtt@inline loaded=true')
    console.log(`CLAUDE READY address=${session.address} model=${model} interactive=true`)
    return session
  }

  async command(text: string): Promise<void> {
    if (this.process.child.exitCode !== null) throw new Error(`Claude exited before command: ${this.process.stderr}`)
    this.process.child.stdin.write(`${text}\r`)
  }

  async close(): Promise<void> {
    await this.process.close()
    const claudeRoot = join(homedir(), '.claude')
    if (!existsSync(claudeRoot)) return
    for (const path of globSync(`**/*${this.sessionId}*`, { cwd: claudeRoot })) {
      rmSync(join(claudeRoot, path), { recursive: true, force: true })
    }
  }

  pids(): number[] {
    return processFamily(this.process.child.pid)
  }
}

function prepareClaudePlugin(): string {
  const source = join(coreRoot, 'adapters', 'claude')
  const destination = join(root, 'claude-plugin')
  cpSync(source, destination, { recursive: true })
  symlinkSync(runtimeNodeModules, join(destination, 'node_modules'), 'dir')
  const manifestPath = join(destination, '.claude-plugin', 'plugin.json')
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(isJsonRecord(manifest) && isJsonRecord(manifest.userConfig))
  const broker = manifest.userConfig.brokerUrl
  const acceptOffers = manifest.userConfig.acceptOffers
  assert.ok(isJsonRecord(broker) && isJsonRecord(acceptOffers))
  broker.default = brokerUrl
  acceptOffers.default = true
  const temporaryManifest = join(destination, `.plugin-${process.pid}.tmp`)
  writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temporaryManifest, manifestPath)
  return destination
}

function prepareClaudeSettings(): string {
  const settingsPath = join(root, 'claude-settings.json')
  writeFileSync(settingsPath, `${JSON.stringify({
    pluginConfigs: {
      'synagent-adapter-mqtt@inline': {
        options: { acceptOffers: true, brokerUrl, global: true },
      },
    },
    permissions: { defaultMode: 'dontAsk' },
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return settingsPath
}

async function waitForBrokerReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let output = ''
  let errors = ''
  const ready = Promise.withResolvers<void>()
  const timer = setTimeout(() => ready.reject(new Error(`broker timeout: ${errors}`)), TIMEOUT_MS)
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (!output.includes(`BROKER READY :${BROKER_PORT}`)) return
    clearTimeout(timer)
    ready.resolve()
  })
  child.stderr.on('data', chunk => { errors += String(chunk) })
  child.once('exit', (code, signal) => ready.reject(
    new Error(`broker exited code=${String(code)} signal=${String(signal)}: ${errors}`),
  ))
  await ready.promise
}

async function connectObserver(messages: CanonicalMessage[]): Promise<MqttClient> {
  const observer = connect(brokerUrl, {
    clean: true,
    clientId: `synagent-offer-race-${process.pid}`,
    reconnectPeriod: 0,
  })
  const connected = Promise.withResolvers<void>()
  observer.once('connect', () => connected.resolve())
  observer.once('error', connected.reject)
  await connected.promise
  await observer.subscribeAsync('synagent/#', { qos: 1 })
  observer.on('message', (_topic, payload) => messages.push(parseCanonical(payload.toString('utf8'))))
  return observer
}

async function waitForMessages(
  messages: CanonicalMessage[],
  predicate: (message: CanonicalMessage) => boolean,
  count: number,
  after: number,
): Promise<CanonicalMessage[]> {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const found = messages.slice(after).filter(predicate)
    if (found.length >= count) return found
    await delay(10)
  }
  throw new Error(`timed out waiting for ${count} MQTT messages`)
}

function assertBrokerIsolation(sessions: Session[]): void {
  const pids = [...new Set(sessions.flatMap(session => session.pids()))]
  assert.ok(pids.length >= sessions.length)
  const sockets = execFileSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP'], { encoding: 'utf8' })
  for (const session of sessions) {
    assert.ok(session.pids().some(pid => sockets.split('\n').some(line =>
      line.split(/\s+/)[1] === String(pid)
      && line.includes(`->127.0.0.1:${BROKER_PORT}`)
      && line.includes('(ESTABLISHED)'))), `${session.address} pids=${session.pids().join(',')} sockets=${sockets}`)
  }
  assert.equal(sockets.includes('->127.0.0.1:1884'), false)
  console.log(`CONNECTIONS pids=${pids.join(',')} broker=${BROKER_PORT} established=true operator_1884=false`)
}

async function runRace(
  label: string,
  offerer: Session,
  claimants: [Session, Session],
  messages: CanonicalMessage[],
): Promise<void> {
  const sessions = [offerer, ...claimants]
  await delay(1_000)
  assertBrokerIsolation(sessions)
  const start = messages.length
  const body = `ISSUE_132 ${label} offered work`
  await offerer.command(offerer instanceof ClaudeSession
    ? `/synagent-offer ${body}`
    : `/synagent offer ${body}`)
  const [offer] = await waitForMessages(
    messages,
    message => message.kind === 'task.offer' && message.from === offerer.address && message.body === body,
    1,
    start,
  )
  assert.ok(offer)
  const claims = await waitForMessages(
    messages,
    message => message.kind === 'task.claim' && message.reply_to === offer.id,
    2,
    start,
  )
  assert.deepEqual(new Set(claims.map(claim => claim.from)), new Set(claimants.map(session => session.address)))
  const outcomes = await waitForMessages(
    messages,
    message => message.correlation_id === offer.id
      && (message.kind === 'task.request' || message.kind === 'task.offer.closed'),
    2,
    start,
  )
  await delay(200)
  const related = messages.slice(start).filter(message => message.correlation_id === offer.id)
  const assignments = related.filter(message => message.kind === 'task.request')
  const closed = related.filter(message => message.kind === 'task.offer.closed')
  assert.equal(assignments.length, 1)
  assert.equal(closed.length, 1)
  assert.equal(outcomes.length, 2)
  assert.equal(assignments[0]?.to, claims[0]?.from)
  assert.equal(assignments[0]?.body, body)
  assert.equal(assignments[0]?.reply_to, offer.id)
  assert.equal(closed[0]?.to, claims[1]?.from)
  assert.equal(closed[0]?.reply_to, claims[1]?.id)
  assert.equal(closed[0]?.body, `Oferta ya asignada: ${offer.id}`)
  console.log(
    `RACE label=${label} offerer=${offerer.address} offer=${offer.id} claims=${claims.map(claim => claim.from).join(',')} `
    + `assigned=${assignments[0]?.to} closed=${closed[0]?.to} task_requests=1 already_assigned=1`,
  )
}

function closeMqtt(client: MqttClient): Promise<void> {
  const closed = Promise.withResolvers<void>()
  client.end(false, {}, error => error ? closed.reject(error) : closed.resolve())
  return closed.promise
}

function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  const exited = Promise.withResolvers<void>()
  child.once('exit', exited.resolve)
  child.kill('SIGTERM')
  return exited.promise
}

async function main(): Promise<void> {
  if (rootOverride) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  chmodSync(root, 0o700)
  const claudePlugin = prepareClaudePlugin()
  const claudeSettings = prepareClaudeSettings()
  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: { ...process.env, A4S_MESSAGE_BUS_DB: dbPath, A4S_MESSAGE_BUS_PORT: String(BROKER_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const messages: CanonicalMessage[] = []
  let observer: MqttClient | undefined
  const active = new Set<Session>()
  try {
    await waitForBrokerReady(broker)
    console.log(`BROKER READY :${BROKER_PORT} db=${dbPath}`)
    observer = await connectObserver(messages)

    const piOfferer = await RpcSession.start('pi', 'race-one-offerer-pi')
    const ompClaimant = await RpcSession.start('omp', 'race-one-claimant-omp')
    const claudeClaimant = await ClaudeSession.start(
      'race-one-claimant-claude', claudePlugin, claudeSettings,
    )
    ;[piOfferer, ompClaimant, claudeClaimant].forEach(session => active.add(session))
    await runRace('pi-offers', piOfferer, [ompClaimant, claudeClaimant], messages)
    await Promise.all([...active].map(session => session.close()))
    active.clear()

    const claudeOfferer = await ClaudeSession.start(
      'race-two-offerer-claude', claudePlugin, claudeSettings,
    )
    const piClaimant = await RpcSession.start('pi', 'race-two-claimant-pi')
    const ompClaimantTwo = await RpcSession.start('omp', 'race-two-claimant-omp')
    ;[claudeOfferer, piClaimant, ompClaimantTwo].forEach(session => active.add(session))
    await runRace('claude-offers', claudeOfferer, [piClaimant, ompClaimantTwo], messages)
    console.log('PASS races=2 hosts=pi,omp,claude task_requests=2 already_assigned=2 claims_without_llm=true')
  } finally {
    await Promise.all([...active].map(session => session.close().catch(() => undefined)))
    if (observer) await closeMqtt(observer).catch(() => undefined)
    await stopProcess(broker).catch(() => undefined)
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    console.log(`CLEANUP root=${root} removed=${!existsSync(root)}`)
  }
}

await main()
