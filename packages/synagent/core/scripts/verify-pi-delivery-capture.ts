#!/usr/bin/env -S npx tsx

import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, type MqttClient } from 'mqtt'

type JsonRecord = Record<string, unknown>
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
type DeliveryEvidence = {
  busId: string
  deliveryText: string
  marker: string
  sawPreTool: boolean
  sawTool: boolean
}

const TIMEOUT_MS = 180_000
const BROKER_PORT = 18224
const EXPECTED_PI_VERSION = '1.0.3'
const coreRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(coreRoot, '../../..')
const adapterPath = join(coreRoot, 'adapters', 'pi', 'index.ts')
const brokerPath = join(repoRoot, 'packages', 'synagent', 'bus', 'broker.cjs')
const piBin = process.env.PI_BIN ?? join(homedir(), '.local', 'bin', 'pi')
const modelName = process.env.SYNAGENT_PI_MODEL ?? 'openai-codex/gpt-6.1-sol'
const modelSlash = modelName.indexOf('/')
if (modelSlash <= 0 || modelSlash === modelName.length - 1) {
  throw new Error('SYNAGENT_PI_MODEL must use provider/model-id')
}
const modelProvider = modelName.slice(0, modelSlash)
const modelId = modelName.slice(modelSlash + 1)
const root = process.env.SYNAGENT_LIVE_ROOT
  ? resolve(process.env.SYNAGENT_LIVE_ROOT)
  : mkdtempSync(join(tmpdir(), 'synagent-pi-delivery-capture-'))
mkdirSync(root, { recursive: true })

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(text: string): JsonRecord {
  const value: unknown = JSON.parse(text)
  if (!isJsonRecord(value)) throw new TypeError('expected a JSON object')
  return value
}

class RpcProcess {
  readonly records: JsonRecord[] = []
  readonly stderr: string[] = []
  readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private readonly responseWaiters = new Map<string, ResponseWaiter>()
  private readonly recordWaiters = new Set<RecordWaiter>()
  private requestSequence = 0

  constructor(readonly name: string, stateRoot: string, sessionDir: string) {
    mkdirSync(stateRoot, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    this.child = spawn(piBin, [
      '--mode', 'rpc',
      '--thinking', 'off',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--offline',
      '--approve',
      '--session-dir', sessionDir,
      '-e', adapterPath,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        A4S_STATE_ROOT: stateRoot,
        PI_TELEMETRY: '0',
        SYNAGENT_BROKER_URL: `mqtt://127.0.0.1:${BROKER_PORT}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.consume(String(chunk)))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => this.stderr.push(String(chunk)))
    this.child.once('exit', (code, signal) => {
      const error = new Error(`${this.name} exited code=${String(code)} signal=${String(signal)}: ${this.stderr.join('').slice(-2000)}`)
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
    const id = `${this.name}-${++this.requestSequence}`
    const payload = { ...command, id }
    const { promise, resolve: resolveResponse, reject: rejectResponse } = Promise.withResolvers<JsonRecord>()
    const timer = setTimeout(() => {
      this.responseWaiters.delete(id)
      rejectResponse(new Error(`${this.name} timed out waiting for response to ${String(command.type)}`))
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
        throw new Error(`${this.name} ${String(command.type)} failed: ${JSON.stringify(record)}`)
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
        rejectRecord(new Error(`${this.name} timed out waiting for event; stderr=${this.stderr.join('').slice(-2000)}`))
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
      let record: JsonRecord
      try {
        record = parseJsonRecord(line)
      } catch (error) {
        throw new Error(`${this.name} emitted invalid JSON: ${line}`, { cause: error })
      }
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

function assistantText(record: JsonRecord): string {
  const message = record.message
  if (record.type !== 'message_end' || !isJsonRecord(message)) return ''
  return message.role === 'assistant' ? messageText(message.content) : ''
}

function operationalRecords(stateRoot: string): JsonRecord[] {
  const harnessRoot = join(stateRoot, 'log', 'synagent', 'pi')
  const instances = readdirSync(harnessRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
  assert.equal(instances.length, 1, `expected one Pi diagnostics directory under ${harnessRoot}`)
  const file = join(harnessRoot, instances[0]!.name, 'operational.jsonl')
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(parseJsonRecord)
}

async function waitForBrokerReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let output = ''
  let errorOutput = ''
  child.stderr.on('data', chunk => { errorOutput += String(chunk) })
  const { promise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>()
  const timer = setTimeout(() => rejectReady(new Error(`broker readiness timed out: ${errorOutput}`)), 30_000)
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (!output.includes(`BROKER READY :${BROKER_PORT}`)) return
    clearTimeout(timer)
    resolveReady()
  })
  child.once('exit', (code, signal) => {
    clearTimeout(timer)
    rejectReady(new Error(`broker exited code=${String(code)} signal=${String(signal)}: ${errorOutput}`))
  })
  await promise
}

async function subscribeObserver(client: MqttClient): Promise<void> {
  const connected = Promise.withResolvers<void>()
  client.once('connect', () => connected.resolve())
  client.once('error', connected.reject)
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
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>()
  child.once('exit', () => resolveExit())
  child.kill('SIGTERM')
  await exited
}

async function main(): Promise<void> {
  const version = execFileSync(piBin, ['--version'], { encoding: 'utf8' }).trim()
  assert.equal(version, EXPECTED_PI_VERSION, `live verifier requires Pi ${EXPECTED_PI_VERSION}`)

  const broker = spawn(process.execPath, [brokerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SYNAGENT_DB: join(root, 'db'),
      SYNAGENT_PORT: String(BROKER_PORT),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const busMessages: JsonRecord[] = []
  let observer: MqttClient | undefined
  let a: RpcProcess | undefined
  let b: RpcProcess | undefined
  try {
    await waitForBrokerReady(broker)
    observer = connect(`mqtt://127.0.0.1:${BROKER_PORT}`, {
      clean: true,
      clientId: `synagent-live-124-${process.pid}`,
      reconnectPeriod: 0,
    })
    observer.on('message', (_topic, payload) => {
      busMessages.push(parseJsonRecord(payload.toString('utf8')))
    })
    await subscribeObserver(observer)
    a = new RpcProcess('a', join(root, 'state-a'), join(root, 'sessions-a'))
    b = new RpcProcess('b', join(root, 'state-b'), join(root, 'sessions-b'))

    await Promise.all([
      a.command({ type: 'set_model', provider: modelProvider, modelId }),
      b.command({ type: 'set_model', provider: modelProvider, modelId }),
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
    const destination = `a4s/${bSession}`

    const processIds = [a.child.pid, b.child.pid]
    assert.ok(processIds.every((pid): pid is number => typeof pid === 'number'))
    const lsofOutput = execFileSync('lsof', [
      '-nP',
      '-a',
      '-p', processIds.join(','),
      '-iTCP',
    ], { encoding: 'utf8' })
    const localConnections = lsofOutput.split('\n').filter(line =>
      line.includes('127.0.0.1') && line.includes('(ESTABLISHED)'),
    )
    for (const pid of processIds) {
      assert.ok(localConnections.some(line =>
        line.split(/\s+/)[1] === String(pid) && line.includes(`->127.0.0.1:${BROKER_PORT}`),
      ), `Pi process ${pid} has no connection to broker ${BROKER_PORT}`)
    }
    assert.ok(localConnections.every(line => !line.includes('->127.0.0.1:1884')))
    console.log(
      `LSOF a_pid=${processIds[0]} b_pid=${processIds[1]} broker=${BROKER_PORT} `
      + `connections=${localConnections.filter(line => line.includes(`->127.0.0.1:${BROKER_PORT}`)).length} forbidden_1884=false`,
    )

    const cases = [
      { label: 'ONE', command: 'printf TOOL_124_ONE', final: 'FINAL_124_ONE' },
      { label: 'TWO', command: 'sleep 4; printf TOOL_124_TWO', final: 'FINAL_124_TWO' },
      { label: 'THREE', command: 'printf TOOL_124_THREE', final: 'FINAL_124_THREE' },
    ] as const
    const evidence: DeliveryEvidence[] = []
    let userAfter = ''

    for (const testCase of cases) {
      const aStart = a.records.length
      const bStart = b.records.length
      const busStart = busMessages.length
      const body = `PoC 124 delivery ${testCase.label}: first say PRE_TOOL_124_${testCase.label}, then call bash with command "${testCase.command}", then answer exactly ${testCase.final}. Do not send any Synagent reply.`
      const sendPrompt = `Call synagent_send once with to="${destination}", kind="prompt", body=${JSON.stringify(body)}. Do not call any other tool.`
      const accepted = await a.command({ type: 'prompt', message: sendPrompt })
      assert.ok(isJsonRecord(accepted.data))
      assert.equal(accepted.data.disposition, 'started')

      if (testCase.label === 'TWO') {
        await b.waitFor(record => record.type === 'tool_execution_start' && record.toolName === 'bash', bStart)
        const followUpResponse: JsonRecord = await b.command({
          type: 'prompt',
          message: 'This is a separate user follow-up after delivery TWO. Answer exactly USER_AFTER_124_TWO and do not call tools.',
          streamingBehavior: 'followUp',
        })
        assert.ok(isJsonRecord(followUpResponse.data))
        assert.equal(followUpResponse.data.disposition, 'queued')
      }

      await Promise.all([
        a.waitFor(record => record.type === 'agent_settled', aStart),
        b.waitFor(record => record.type === 'agent_settled', bStart),
      ])
      const busMessage = busMessages.slice(busStart).find(record =>
        record.from === `a4s/${aSession}` && record.to === destination && record.body === body,
      )
      assert.ok(busMessage)
      const busId = busMessage.id
      assert.equal(typeof busId, 'string')
      const targetRecords: JsonRecord[] = b.records.slice(bStart)
      const deliveryStart: JsonRecord | undefined = targetRecords.find(record =>
        record.type === 'message_start'
        && eventMessageText(record).startsWith('[synagent-delivery ')
        && eventMessageText(record).includes(`id ${busId}`),
      )
      assert.ok(deliveryStart)
      const marker = eventMessageText(deliveryStart).split('\n', 1)[0]!
      const assistantTexts = targetRecords.map(assistantText).filter(text => text.trim())
      assert.ok(assistantTexts.some(text => text.trim() === `PRE_TOOL_124_${testCase.label}`))
      assert.ok(assistantTexts.includes(testCase.final))
      assert.ok(targetRecords.some(record => record.type === 'tool_execution_start' && record.toolName === 'bash'))
      if (testCase.label === 'TWO') {
        userAfter = assistantTexts.find(text => text === 'USER_AFTER_124_TWO') ?? ''
      }
      evidence.push({
        busId,
        deliveryText: testCase.final,
        marker,
        sawPreTool: true,
        sawTool: true,
      })
    }

    await Promise.all([a.close(), b.close()])
    const settled = operationalRecords(join(root, 'state-b'))
      .filter(record => record.event_name === 'synagent.pi.delivery.settled')
    for (const item of evidence) {
      const messageHash = createHash('sha256').update(item.busId).digest('hex')
      const record = settled.find(candidate => candidate['messaging.message.id_hash'] === messageHash)
      assert.ok(record, `missing delivery diagnostics for ${item.busId}`)
      assert.equal(record['a4s.delivery.text'], item.deliveryText)
      console.log(
        `LIVE ${item.deliveryText.slice('FINAL_124_'.length)} bus_id=${item.busId} marker=${item.marker} `
        + `pre_tool=${item.sawPreTool} tool_mid_turn=${item.sawTool} delivery_text=${JSON.stringify(record['a4s.delivery.text'])} matches=true`,
      )
    }
    assert.equal(userAfter, 'USER_AFTER_124_TWO')
    console.log(`LIVE TWO follow_up=${userAfter} frozen_delivery=${evidence[1]!.deliveryText} uncontaminated=true`)
    console.log(`PASS pi=${version} model=${modelName} broker=${BROKER_PORT} sessions=2 deliveries=3 evidence=${root}`)
  } finally {
    await a?.close().catch(() => undefined)
    await b?.close().catch(() => undefined)
    if (observer) await closeObserver(observer).catch(() => undefined)
    await stopBroker(broker).catch(() => undefined)
  }
}

await main()
