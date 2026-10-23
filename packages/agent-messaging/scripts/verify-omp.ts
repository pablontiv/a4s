#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { connectAsync, type MqttClient } from 'mqtt'

import { instanceFromHostSession, repoNameFromOrigin, serialize, type CanonicalMessage } from '../protocol.ts'
import { execFileSync } from 'node:child_process'

type RecordData = Record<string, any>
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(packageRoot, '../..')
const root = mkdtempSync(join(tmpdir(), 'a4s-agent-messaging-smoke-'))
const timeout = 120_000
const model = process.env.A4S_AGENT_MESSAGING_SMOKE_MODEL ?? 'openai/gpt-4.1-mini'
const project = repoNameFromOrigin(execFileSync('git', ['config', '--get', 'remote.origin.url'], {
  cwd: repoRoot, encoding: 'utf8',
}).trim())
assert.ok(project, 'candidate cwd must have a valid repository origin')
console.log(`EVIDENCE ${root}`)

function jsonLines(path: string): RecordData[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

function files(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

async function until<T>(label: string, get: () => T | undefined, duration = timeout): Promise<T> {
  const deadline = Date.now() + duration
  while (Date.now() < deadline) {
    const result = get()
    if (result !== undefined) return result
    await delay(25)
  }
  throw new Error(`Timed out: ${label}; evidence=${root}`)
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('exit', () => exited.resolve())
  child.stdin.end()
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited.promise } finally { clearTimeout(timer) }
}

class Peer {
  readonly child: ChildProcessWithoutNullStreams
  readonly records: RecordData[] = []
  readonly directory: string
  readonly sessions: string
  sessionId = ''
  address = ''
  private sequence = 0

  constructor(readonly name: string, brokerUrl: string, resume?: string) {
    this.directory = join(root, name)
    this.sessions = join(this.directory, 'sessions')
    const agent = join(this.directory, 'agent')
    mkdirSync(agent, { recursive: true, mode: 0o700 })
    mkdirSync(this.sessions, { recursive: true, mode: 0o700 })
    if (!resume) {
      writeFileSync(join(agent, 'config.yml'), `disabledProviders: ["claude-plugins"]\nskills:\n  customDirectories: [${JSON.stringify(join(repoRoot, 'skills'))}]\n`, { mode: 0o600 })
      writeFileSync(join(agent, 'agent-messaging.json'), JSON.stringify({
        'broker-url': brokerUrl, global: false, 'accept-offers': true,
      }), { mode: 0o600 })
    }
    const args = ['--mode', 'rpc', '--no-ui', '--no-extensions', '--no-rules', '--no-title',
      '--no-lsp', '--no-pty', '--tools', 'bash', '--auto-approve', '--thinking', 'off',
      '--model', model, '--session-dir', this.sessions, '-e', packageRoot,
      ...(resume ? ['--resume', resume] : [])]
    writeFileSync(join(this.directory, 'command.json'), JSON.stringify({
      bin: process.env.OMP_BIN ?? 'omp', args, cwd: repoRoot, agentDir: agent, model,
    }, null, 2), { mode: 0o600 })
    this.child = spawn(process.env.OMP_BIN ?? 'omp', args, {
      cwd: repoRoot,
      env: { ...process.env,
        PATH: process.env.PATH?.split(':').filter(directory => !directory.endsWith('/node_modules/.bin')).join(':'),
        PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: this.sessions,
        A4S_STATE_ROOT: join(this.directory, 'state'), PI_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      appendFileSync(join(this.directory, 'rpc-output.jsonl'), chunk, { mode: 0o600 })
      buffer += chunk
      for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          try { this.records.push(JSON.parse(line)) } catch { /* Raw startup output is retained above. */ }
        }
      }
    })
    this.child.stderr.on('data', chunk => appendFileSync(join(this.directory, 'stderr.log'), chunk, { mode: 0o600 }))
  }

  async request(command: RecordData): Promise<RecordData> {
    const id = `${this.name}-${++this.sequence}`
    const input = JSON.stringify({ ...command, id }) + '\n'
    appendFileSync(join(this.directory, 'rpc-input.jsonl'), input, { mode: 0o600 })
    this.child.stdin.write(input)
    const response = await until(`${this.name} ${command.type}`, () => {
      if (this.child.exitCode !== null) throw new Error(`${this.name} exited; evidence=${root}`)
      return this.records.find(record => record.type === 'response' && record.id === id)
    })
    assert.equal(response.success, true, JSON.stringify(response))
    return response
  }

  async start(): Promise<void> {
    const response = await this.request({ type: 'get_state' })
    this.sessionId = response.data.sessionId
    this.address = `${project}/${instanceFromHostSession(this.sessionId)}`
    await until(`${this.name} native MQTT connection`, () => this.diagnostics().some(entry =>
      entry.event_name === 'a4s.agent-messaging.omp.mqtt.connected'
      && entry['a4s.client.role'] === 'durable') ? true : undefined)
    await delay(100)
    console.log(`PEER ${this.name} address=${this.address} source=origin candidate=${packageRoot}`)
  }

  assertHealthy(): void {
    const failed = this.records.find(record => (record.type === 'response' && record.success === false)
      || (record.type === 'prompt_result' && record.status === 'error')
      || (record.type === 'message_end' && record.message?.errorMessage))
    if (failed) throw new Error(`${this.name} native acceptance blocked: ${JSON.stringify(failed)}; evidence=${root}`)
  }

  sessionFile(): string {
    const path = files(this.sessions).find(path => path.endsWith('.jsonl')
      && jsonLines(path).some(entry => entry.type === 'session' && entry.id === this.sessionId))
    assert.ok(path, `${this.name} persisted native session`)
    return path
  }

  entries(): RecordData[] { return files(this.sessions).filter(path => path.endsWith('.jsonl')).flatMap(jsonLines) }
  diagnostics(): RecordData[] { return files(join(this.directory, 'state')).filter(path => path.endsWith('.jsonl')).flatMap(jsonLines) }
  prompt(message: string) { return this.request({ type: 'prompt', message }) }
  close() { return stop(this.child) }
}

const socket = net.createServer()
const listening = Promise.withResolvers<void>()
socket.listen(0, '127.0.0.1', listening.resolve)
await listening.promise
const port = (socket.address() as net.AddressInfo).port
const closed = Promise.withResolvers<void>()
socket.close(error => error ? closed.reject(error) : closed.resolve())
await closed.promise
const brokerUrl = `mqtt://127.0.0.1:${port}`
const broker = spawn(process.execPath, [join(repoRoot, 'apps/message-bus/broker.cjs')], {
  cwd: repoRoot,
  env: { ...process.env, A4S_MESSAGE_BUS_PORT: String(port), A4S_MESSAGE_BUS_DB: join(root, 'broker-db'),
    A4S_STATE_ROOT: join(root, 'broker-state') },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let brokerOutput = ''
broker.stdout.on('data', chunk => {
  brokerOutput += String(chunk)
  appendFileSync(join(root, 'broker.stdout'), chunk, { mode: 0o600 })
})
broker.stderr.on('data', chunk => appendFileSync(join(root, 'broker.stderr'), chunk, { mode: 0o600 }))
const peers: Peer[] = []
let observer: MqttClient | undefined
const wire: Array<{ topic: string; message: CanonicalMessage }> = []
function bus(kind: string, id: string): CanonicalMessage | undefined {
  return wire.find(record => record.message.kind === kind
    && (record.message.reply_to === id || record.message.id === id))?.message
}
function deliveries(peer: Peer, id: string): number {
  return peer.entries().filter(entry => entry.type === 'message' && entry.message?.role === 'user'
    && JSON.stringify(entry.message.content).includes(`id ${id}`)).length
}
async function publish(message: CanonicalMessage, version = 'v2') {
  await observer!.publishAsync(`synagent/${version}/${message.to}`, serialize(message), { qos: 1 })
}
function message(to: string, kind: CanonicalMessage['kind'], body: string): CanonicalMessage {
  const id = randomUUID()
  return { id, from: `${project}/smoke-observer`, to, kind, body, correlation_id: id, ts: Date.now() }
}
async function completed(id: string): Promise<CanonicalMessage> {
  return until(`completion ${id}`, () => {
    for (const peer of peers) {
      peer.assertHealthy()
    }
    return bus('task.completed', id)
  })
}

try {
  await until('canonical broker readiness', () => brokerOutput.includes(`BROKER READY :${port}`) ? true : undefined)
  observer = await connectAsync(brokerUrl, { clientId: `a4s-agent-messaging-smoke-${process.pid}`, reconnectPeriod: 0 })
  observer.on('message', (topic, payload) => {
    const received = { topic, received_at: new Date().toISOString(), payload: payload.toString() }
    appendFileSync(join(root, 'observer.jsonl'), JSON.stringify(received) + '\n', { mode: 0o600 })
    try { wire.push({ topic, message: JSON.parse(received.payload) }) } catch { /* Preserve rejected payloads too. */ }
  })
  await observer.subscribeAsync('synagent/#', { qos: 1 })
  const a = new Peer('a', brokerUrl)
  const b = new Peer('b', brokerUrl)
  peers.push(a, b)
  await Promise.all([a.start(), b.start()])
  assert.notEqual(a.address, b.address)
  await a.prompt('/agent-messaging status')
  await a.prompt(`/agent-messaging set default-peer ${b.address}`)
  assert.equal(JSON.parse(readFileSync(join(a.directory, 'agent/agent-messaging.json'), 'utf8'))['default-peer'], b.address)
  const unsupported = message(b.address, 'task.request', 'UNSUPPORTED_VERSION_MUST_NOT_RUN')
  await publish(unsupported, 'v99')
  await until('version rejection', () => b.diagnostics().some(record => record['error.code'] === 'VERSION_UNSUPPORTED') ? true : undefined)
  assert.equal(deliveries(b, unsupported.id), 0)
  console.log('PASS native package-root loading, canonical settings/commands, observer wire addresses, pre-delivery version rejection')

  const requestStart = wire.length
  await a.prompt(`Call agent_messaging_send exactly once with to=${JSON.stringify(b.address)}, kind="task.request", body="Reply exactly A4S_424_FINAL. Do not use tools." Then answer exactly SENT.`)
  const request = await until('native agent_messaging_send request', () => {
    a.assertHealthy()
    return wire.slice(requestStart).find(record => record.message.from === a.address && record.message.kind === 'task.request')?.message
  })
  const result = await completed(request.id)
  assert.equal(result.body.trim(), 'A4S_424_FINAL')
  for (const event of [bus('task.delivered', request.id), result]) {
    assert.ok(event)
    assert.equal(event.correlation_id, request.id)
    assert.equal(event.causation_id, request.id)
  }
  assert.equal(deliveries(b, request.id), 1)
  await publish(request)
  await delay(500)
  assert.equal(deliveries(b, request.id), 1)
  console.log('PASS real tool request, one recipient turn, correlated delivered/completed, final reply and deduplication')

  const busyStart = b.records.length
  await b.prompt('Use bash exactly once to run "sleep 12". Then reply exactly BUSY_DONE.')
  await until('busy tool execution', () => b.records.slice(busyStart).find(record => record.type === 'tool_execution_start'))
  const queued = message(b.address, 'task.request', 'Reply exactly QUEUE_DONE. Do not use tools.')
  queued.deadline = Date.now() + 120_000
  await publish(queued)
  await until('busy pending persistence', () => b.entries().some(entry => entry.customType === 'synagent-pending'
    && entry.data.message.id === queued.id) ? true : undefined)
  assert.equal(deliveries(b, queued.id), 0)
  await completed(queued.id)
  assert.equal(deliveries(b, queued.id), 1)
  assert.ok(b.records.slice(busyStart).some(record => record.type === 'agent_end' && record.willContinue !== true))
  console.log('PASS busy terminal-agent_end queued delivery')

  await b.prompt('Use bash exactly once to run "sleep 60". Then reply exactly RESUME_BUSY_DONE.')
  await until('resume busy tool execution', () => b.records.slice(busyStart).findLast(record =>
    record.type === 'tool_execution_start' && JSON.stringify(record).includes('sleep 60')))
  const pending = message(b.address, 'task.request', 'Reply exactly RESUMED_ONCE. Do not use tools.')
  pending.deadline = Date.now() + 120_000
  await publish(pending)
  await until('resume pending persistence', () => b.entries().some(entry => entry.customType === 'synagent-pending'
    && entry.data.message.id === pending.id) ? true : undefined)
  const sessionFile = b.sessionFile()
  await b.close()
  const resumed = new Peer('b', brokerUrl, sessionFile)
  peers.push(resumed)
  await resumed.start()
  assert.equal(resumed.address, b.address)
  await completed(pending.id)
  await publish(pending)
  await delay(500)
  assert.equal(deliveries(resumed, pending.id), 1)
  console.log('PASS persisted native pending-message resume and deduplication')

  // A single eligible OMP claimant produces claim and assignment mechanically.
  const beforeOffer = resumed.records.length
  await a.prompt('/agent-messaging offer Reply exactly OFFER_DONE. Do not use tools.')
  const offer = await until('native offer', () => wire.findLast(record => record.message.from === a.address
    && record.message.kind === 'task.offer')?.message)
  const claim = await until('mechanical claim', () => bus('task.claim', offer.id))
  assert.equal(claim.from, resumed.address)
  const assignment = await until('mechanical assignment', () => wire.find(record => record.message.kind === 'task.request'
    && record.message.reply_to === offer.id)?.message)
  await completed(assignment.id)
  const turns = resumed.records.slice(beforeOffer).filter(record => record.type === 'message_start' && record.message?.role === 'user')
  assert.equal(turns.length, 1, 'only the assigned request opens a model turn')
  assert.equal(deliveries(resumed, offer.id), 0)
  assert.equal(deliveries(resumed, claim.id), 0)
  console.log('PASS mechanical offer arbitration with one assigned request and no offer/claim model turns')
  writeFileSync(join(root, 'result.json'), JSON.stringify({ verdict: 'PASS', candidate: packageRoot, model, brokerUrl }, null, 2))
  console.log(`PASS all OMP slice acceptance; evidence=${root}`)
} catch (error) {
  writeFileSync(join(root, 'result.json'), JSON.stringify({ verdict: 'FAIL', error: String(error), candidate: packageRoot, model }, null, 2))
  throw error
} finally {
  await Promise.all(peers.map(peer => peer.close()))
  if (observer) await observer.endAsync()
  await stop(broker)
}
