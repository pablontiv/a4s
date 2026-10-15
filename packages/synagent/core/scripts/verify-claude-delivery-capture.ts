#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

import {
  assertSupportedTopicVersion,
  parseCanonical,
  serialize,
  toTopic,
  type CanonicalMessage,
} from '../protocol.ts'

type JsonRecord = Record<string, unknown>
type DeliveryCase = {
  body: string
  expected: string
  id: string
  interrupt?: true
}

const TIMEOUT_MS = 180_000
const BROKER_PORT = Number(process.env.SYNAGENT_CLAUDE_BROKER_PORT ?? 18_125)
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const pluginRoot = join(coreRoot, 'adapters', 'claude')
const brokerPath = join(repoRoot, 'packages', 'synagent', 'bus', 'broker.cjs')
const ptyDriver = join(coreRoot, 'scripts', 'support', 'claude-pty.py')
const claudeBin = process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude')
const model = process.env.SYNAGENT_CLAUDE_MODEL ?? 'haiku'
const brokerUrl = `mqtt://127.0.0.1:${BROKER_PORT}`
const root = process.env.SYNAGENT_LIVE_ROOT
  ? resolve(process.env.SYNAGENT_LIVE_ROOT)
  : mkdtempSync(join(tmpdir(), 'synagent-claude-delivery-capture-'))
const stateRoot = join(root, 'state')
const sourceSessionId = randomUUID()
const destinationSessionId = randomUUID()
const sourceAddress = `a4s/${sourceSessionId}`
const destinationAddress = `a4s/${destinationSessionId}`

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(text: string): JsonRecord {
  const value: unknown = JSON.parse(text)
  if (!isJsonRecord(value)) throw new TypeError('expected a JSON object')
  return value
}

function delay(ms: number): Promise<void> {
  const delayed = Promise.withResolvers<void>()
  setTimeout(delayed.resolve, ms)
  return delayed.promise
}

async function waitFor<T>(description: string, read: () => T | undefined, timeoutMs = TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await delay(100)
  }
  throw new Error(`timed out waiting for ${description}`)
}

class ClaudePty {
  readonly child: ChildProcessWithoutNullStreams
  private readonly debugPath: string
  private output = ''

  constructor(readonly name: string, readonly sessionId: string, cwd: string, settingsPath: string) {
    this.debugPath = join(root, `${name}-debug.log`)
    const claudeArgs = [
      claudeBin,
      '--session-id', sessionId,
      '--name', `synagent-live-125-${name}`,
      '--model', model,
      '--effort', 'low',
      '--setting-sources', '',
      '--settings', settingsPath,
      '--plugin-dir', pluginRoot,
      '--strict-mcp-config',
      '--tools', 'Bash',
      '--allowedTools', 'Bash(printf *)', 'Bash(sleep *)',
      '--ax-screen-reader',
      '--debug-file', this.debugPath,
      `Reply with exactly READY_125_${name.toUpperCase()} and nothing else.`,
    ]
    this.child = spawn('python3', [ptyDriver, JSON.stringify(claudeArgs), cwd], {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, A4S_STATE_ROOT: stateRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => { this.output += String(chunk) })
    this.child.stderr.on('data', chunk => { this.output += String(chunk) })
  }

  async ready(): Promise<void> {
    const token = `READY_125_${this.name.toUpperCase()}`
    await waitFor(`${this.name} plugin startup and initial answer`, () => {
      let debug = ''
      try { debug = readFileSync(this.debugPath, 'utf8') } catch {}
      const loadFailure = debug.match(/hooks module synagent-adapter-mqtt@inline failed to load:[^\n]*/)
      if (loadFailure) throw new Error(loadFailure[0])
      if (
        this.output.includes(token)
        && debug.includes('hooks module synagent-adapter-mqtt@inline loaded')
        && debug.includes(`synagent: a4s/${this.sessionId}`)
      ) return true
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`${this.name} exited during startup: ${this.output.slice(-4000)}`)
      }
      return undefined
    })
  }

  interrupt(): void {
    this.child.stdin.write('\u001b')
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = Promise.withResolvers<void>()
    this.child.once('exit', () => exited.resolve())
    const pid = this.child.pid
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGTERM') } catch {}
    }
    const killTimer = setTimeout(() => {
      if (pid !== undefined) {
        try { process.kill(-pid, 'SIGKILL') } catch {}
      }
    }, 5_000)
    await Promise.race([exited.promise, delay(10_000)])
    clearTimeout(killTimer)
  }
}

async function waitForBrokerReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  await waitFor('broker readiness', () => {
    if (stdout.includes(`BROKER READY :${BROKER_PORT}`)) return true
    if (child.exitCode !== null) throw new Error(`broker exited: ${stderr}`)
    return undefined
  }, 30_000)
}

async function connectObserver(messages: JsonRecord[]): Promise<MqttClient> {
  const client = connect(brokerUrl, {
    clean: true,
    clientId: `synagent-live-125-${process.pid}`,
    reconnectPeriod: 0,
  })
  const connected = Promise.withResolvers<void>()
  client.once('connect', () => connected.resolve())
  client.once('error', error => connected.reject(error))
  await connected.promise
  const subscribed = Promise.withResolvers<void>()
  client.subscribe('synagent/#', { qos: 1 }, error => error ? subscribed.reject(error) : subscribed.resolve())
  await subscribed.promise
  client.on('message', (topic, payload) => {
    assertSupportedTopicVersion(topic)
    messages.push(parseCanonical(payload.toString('utf8')) as unknown as JsonRecord)
  })
  return client
}

async function publish(client: MqttClient, message: CanonicalMessage): Promise<void> {
  const published = Promise.withResolvers<void>()
  client.publish(toTopic(message.to), serialize(message), { qos: 1 }, error => {
    if (error) published.reject(error)
    else published.resolve()
  })
  await published.promise
}

async function closeMqtt(client: MqttClient): Promise<void> {
  const closed = Promise.withResolvers<void>()
  client.end(false, {}, error => {
    if (error) closed.reject(error)
    else closed.resolve()
  })
  await closed.promise
}

async function stopBroker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('exit', () => exited.resolve())
  child.kill('SIGTERM')
  await Promise.race([exited.promise, delay(10_000)])
}

function diagnosticRecords(): JsonRecord[] {
  const directory = join(stateRoot, 'log', 'synagent', 'claude')
  let instances: string[]
  try {
    instances = readdirSync(directory)
  } catch {
    return []
  }
  const records: JsonRecord[] = []
  for (const instance of instances) {
    const file = join(directory, instance, 'operational.jsonl')
    try {
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        records.push(parseJsonRecord(line))
      }
    } catch {}
  }
  return records
}

function eventFor(messages: JsonRecord[], kind: string, requestId: string): JsonRecord | undefined {
  return messages.find(message => message.kind === kind && message.causation_id === requestId)
}

function resultFor(requestId: string): JsonRecord | undefined {
  const hash = createHash('sha256').update(requestId).digest('hex')
  return diagnosticRecords().find(record =>
    record['messaging.message.id_hash'] === hash
    && (record.event_name === 'synagent.claude.delivery.settled'
      || record.event_name === 'synagent.claude.delivery.failed'))
}

function removeClaudeSession(sessionId: string): void {
  try {
    execFileSync(claudeBin, ['rm', sessionId], { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' })
  } catch {}
}

async function main(): Promise<void> {
  assert.ok(Number.isInteger(BROKER_PORT) && BROKER_PORT > 0 && BROKER_PORT <= 65_535)
  mkdirSync(root, { recursive: true })
  mkdirSync(stateRoot, { recursive: true })
  const settingsPath = join(root, 'settings.json')
  writeFileSync(settingsPath, `${JSON.stringify({
    pluginConfigs: {
      'synagent-adapter-mqtt@inline': { options: { brokerUrl } },
    },
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })

  const version = execFileSync(claudeBin, ['--version'], { encoding: 'utf8' }).trim()
  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: { ...process.env, SYNAGENT_DB: join(root, 'db'), SYNAGENT_PORT: String(BROKER_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const busMessages: JsonRecord[] = []
  let observer: MqttClient | undefined
  let source: ClaudePty | undefined
  let destination: ClaudePty | undefined
  try {
    await waitForBrokerReady(broker)
    observer = await connectObserver(busMessages)
    source = new ClaudePty('source', sourceSessionId, repoRoot, settingsPath)
    destination = new ClaudePty('destination', destinationSessionId, repoRoot, settingsPath)
    await Promise.all([source.ready(), destination.ready()])

    const cases: DeliveryCase[] = [
      {
        id: `claude-125-one-${Date.now()}`,
        body: 'Use the Bash tool once to run printf TOOL_125_ONE. Then reply with exactly FINAL_125_ONE and nothing else.',
        expected: 'FINAL_125_ONE',
      },
      {
        id: `claude-125-two-${Date.now() + 1}`,
        body: 'Use the Bash tool once to run printf TOOL_125_TWO. Then reply with exactly FINAL_125_TWO and nothing else.',
        expected: 'FINAL_125_TWO',
      },
      {
        id: `claude-125-aborted-${Date.now() + 2}`,
        body: 'Use the Bash tool to run sleep 30 synchronously. Wait for it to finish before replying SHOULD_NOT_COMPLETE_125.',
        expected: '',
        interrupt: true,
      },
    ]

    const publicationOrder: string[] = []
    for (const item of cases) {
      const request: CanonicalMessage = {
        id: item.id,
        from: sourceAddress,
        to: destinationAddress,
        kind: 'task.request',
        body: item.body,
        correlation_id: item.id,
        ts: Date.now(),
      }
      await publish(observer, request)
      const delivered = await waitFor(`task.delivered for ${item.id}`, () => eventFor(busMessages, 'task.delivered', item.id))
      assert.equal(delivered.reply_to, item.id)
      assert.equal(delivered.correlation_id, item.id)
      assert.equal(delivered.to, sourceAddress)
      publicationOrder.push(`delivered:${item.id}`)

      if (item.interrupt) {
        await delay(1_500)
        destination.interrupt()
        const failed = await waitFor(`failed diagnostic for ${item.id}`, () => resultFor(item.id))
        assert.equal(failed.schema, 'a4s.log/1')
        assert.equal(failed['a4s.delivery.status'], 'failed')
        assert.equal(failed['a4s.delivery.reason'], 'aborted')
        assert.equal(failed['a4s.delivery.cause'], 'aborted')
        assert.equal(failed['a4s.delivery.text'], '')
        await delay(2_000)
        assert.equal(eventFor(busMessages, 'task.completed', item.id), undefined)
        console.log(`LIVE ABORTED request=${item.id} delivered=${String(delivered.id)} status=failed cause=aborted completed=false`)
        continue
      }

      const completed = await waitFor(`task.completed for ${item.id}`, () => eventFor(busMessages, 'task.completed', item.id))
      assert.equal(completed.reply_to, item.id)
      assert.equal(completed.correlation_id, item.id)
      assert.equal(completed.to, sourceAddress)
      assert.equal(completed.body, item.expected)
      publicationOrder.push(`completed:${item.id}`)
      const state = await waitFor(`settled diagnostic for ${item.id}`, () => resultFor(item.id))
      assert.equal(state.schema, 'a4s.log/1')
      assert.equal(state['a4s.delivery.status'], 'complete')
      assert.equal(state['a4s.delivery.reason'], 'answer')
      assert.equal(state['a4s.delivery.text'], item.expected)
      console.log(`LIVE COMPLETE request=${item.id} delivered=${String(delivered.id)} completed=${String(completed.id)} text=${JSON.stringify(item.expected)}`)
    }

    assert.deepEqual(publicationOrder, [
      `delivered:${cases[0]!.id}`,
      `completed:${cases[0]!.id}`,
      `delivered:${cases[1]!.id}`,
      `completed:${cases[1]!.id}`,
      `delivered:${cases[2]!.id}`,
    ])
    console.log(`PASS claude=${version} model=${model} broker=${BROKER_PORT} sessions=2 deliveries=3 order=verified evidence=${root}`)
  } finally {
    await source?.close().catch(() => undefined)
    await destination?.close().catch(() => undefined)
    if (observer) await closeMqtt(observer).catch(() => undefined)
    await stopBroker(broker).catch(() => undefined)
    removeClaudeSession(sourceSessionId)
    removeClaudeSession(destinationSessionId)
  }
}

await main()
