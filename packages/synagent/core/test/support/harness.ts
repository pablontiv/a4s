import net from 'node:net'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Aedes } from 'aedes'
import { connect } from 'mqtt'
import type { MqttClient } from 'mqtt'
import type { TSchema } from 'typebox'

import type { SynagentAdapterOptions } from '../../adapters/session/engine.ts'
import type { CanonicalMessage } from '../../protocol.ts'

export type AdapterFactory = (options?: SynagentAdapterOptions) => (api: never) => void

type EventName = 'session_start' | 'message_start' | 'message_end' | 'agent_end' | 'agent_settled' | 'session_shutdown'
type FakeContent = string | Array<{ type: string; text?: string }>
type FakeEvent =
  | { type: 'session_start' | 'agent_settled' | 'session_shutdown' }
  | { type: 'agent_end'; messages: [] }
  | { type: 'message_start'; message: { role: 'user'; content: FakeContent } }
  | { type: 'message_end'; message: { role: 'assistant' | 'toolResult' | 'user'; content: FakeContent } }
type Handler = (event: FakeEvent, context: FakeContext) => void | Promise<void>
type Command = { handler(args: string, context: FakeContext): void | Promise<void> }
type Tool = {
  parameters: TSchema
  execute(
    id: string,
    params: {
      to: string
      body: string
      kind?: string
      reply_to?: string
      correlation_id?: string
      causation_id?: string
    },
    signal: undefined,
    onUpdate: undefined,
    context: FakeContext,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>
}
type Notification = { message: string; type: 'info' | 'warning' | 'error' | undefined }
type Received = { text: string; options?: { deliverAs: 'steer' | 'followUp' } }
type FakeContext = {
  cwd: string
  hasUI: boolean
  isIdle(): boolean
  isProjectTrusted(): boolean
  sessionManager: { getBranch(): unknown[]; getSessionId(): string }
  ui: {
    confirm(title: string, message: string): Promise<boolean>
    input(title: string, placeholder?: string): Promise<string | undefined>
    notify(message: string, type?: Notification['type']): void
    select(title: string, options: string[]): Promise<string | undefined>
  }
}

interface StartedBroker {
  broker: Aedes
  server: net.Server
  url: string
}

export async function startBroker(): Promise<StartedBroker> {
  const broker = await Aedes.createBroker({})
  const server = net.createServer(broker.handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { broker, server, url: `mqtt://127.0.0.1:${port}` }
}

export function connectClient(url: string, clientId: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = connect(url, { clientId, clean: true })
    client.once('connect', () => resolve(client))
    client.once('error', reject)
  })
}

export function publish(client: MqttClient, topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1 }, (error?: Error) => error ? reject(error) : resolve())
  })
}

export function end(client: MqttClient): Promise<void> {
  // Force destroy the stream immediately and destroy the client
  try {
    client.stream?.destroy?.()
  } catch {
    // Ignore errors
  }

  // Attempt to end gracefully but don't wait for callback
  try {
    client.end(true, {})
  } catch {
    // Ignore errors
  }

  return Promise.resolve()
}

export async function closeBroker(broker: Aedes): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        resolve()
      }, 2000)

      broker.close(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  } catch {
    // Ignore errors
  }
}

export async function closeServer(server: net.Server): Promise<void> {
  try {
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        resolve()
      }, 2000)

      server.close(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  } catch {
    // Ignore errors
  }
}

export function createHarness(
  adapterFactory: AdapterFactory,
  overrides: Record<string, unknown>,
  initialEntries: Array<{ type: 'custom'; customType: string; data: Record<string, unknown> }> = [],
  sessionId = `session-${randomUUID()}`,
  deliveryStartTimeoutMs?: number,
  cwd?: string,
  diagnostics?: SynagentAdapterOptions['diagnostics'],
  trusted = true,
) {
  const events = new Map<EventName, Handler[]>()
  const commands = new Map<string, Command>()
  const tools = new Map<string, Tool>()
  const notifications: Notification[] = []
  const received: Received[] = []
  const entries = initialEntries.map(entry => ({ ...entry, data: { ...entry.data } }))
  const branch: unknown[] = [...entries]
  const appendFailures = new Set<string>()
  const ownedDiagnosticsRoot = diagnostics ? undefined : mkdtempSync(join(tmpdir(), 'synagent-test-log-'))
  const effectiveDiagnostics = diagnostics ?? { env: { A4S_STATE_ROOT: ownedDiagnosticsRoot } }
  const agentDir = mkdtempSync(join(tmpdir(), 'synagent-agent-'))
  const ownedCwd = cwd ? undefined : mkdtempSync(join(tmpdir(), 'synagent-cwd-'))
  const effectiveCwd = cwd ?? ownedCwd!
  if (ownedCwd) {
    execFileSync('git', ['init', '-q'], { cwd: effectiveCwd })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:pablontiv/a4s.git'], { cwd: effectiveCwd })
  }
  const globalSettingsPath = join(agentDir, 'synagent.json')
  const initialSettings = Object.fromEntries(Object.entries(overrides).map(([key, value]) => [
    key.replace(/^a4s\.synagent\./, ''),
    value,
  ]))
  writeFileSync(globalSettingsPath, `${JSON.stringify(initialSettings, null, 2)}\n`, { mode: 0o600 })
  const selections: string[] = []
  const selectionOptions: string[][] = []
  const inputs: Array<string | undefined> = []
  const confirmations: boolean[] = []
  let idle = true
  let failDelivery = false
  let currentSessionId = sessionId

  const createContext = (): FakeContext => ({
    cwd: effectiveCwd,
    hasUI: true,
    isIdle: () => idle,
    isProjectTrusted: () => trusted,
    sessionManager: { getBranch: () => branch, getSessionId: () => currentSessionId },
    ui: {
      confirm: async () => confirmations.shift() ?? false,
      input: async () => inputs.shift(),
      notify: (message, type) => notifications.push({ message, type }),
      select: async (_title, options) => {
        selectionOptions.push([...options])
        return selections.shift()
      },
    },
  })
  const api = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command)
    },
    registerTool(tool: Tool & { name: string }) {
      tools.set(tool.name, tool)
    },
    on(event: EventName, handler: Handler) {
      const handlers = events.get(event) ?? []
      handlers.push(handler)
      events.set(event, handlers)
      return () => {}
    },
    appendEntry(customType: string, data: Record<string, unknown>) {
      if (appendFailures.has(customType)) throw new Error(`simulated ${customType} append failure`)
      const entry = { type: 'custom' as const, customType, data }
      entries.push(entry)
      branch.push(entry)
    },
    sendUserMessage(text: string, options?: Received['options']) {
      if (failDelivery) throw new Error('simulated delivery failure with private detail')
      received.push({ text, ...(options ? { options } : {}) })
    },
  }
  const adapter = adapterFactory({
    ...(deliveryStartTimeoutMs !== undefined ? { deliveryStartTimeoutMs } : {}),
    diagnostics: effectiveDiagnostics,
  })
  adapter(api as never)

  async function withAgentDir(action: () => void | Promise<void>): Promise<void> {
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      await action()
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
    }
  }

  async function emit(eventName: EventName, event: FakeEvent): Promise<void> {
    for (const handler of events.get(eventName) ?? []) {
      await handler(event, createContext())
    }
  }

  return {
    notifications,
    received,
    entries,
    agentDir,
    cwd: effectiveCwd,
    globalSettingsPath,
    settingKeys: ([] as string[])[Symbol.iterator](),
    toolSchemas: { get: (name: string) => tools.get(name)?.parameters },
    selectionOptions,
    queueSelections(...values: string[]) { selections.push(...values) },
    queueInputs(...values: Array<string | undefined>) { inputs.push(...values) },
    queueConfirmations(...values: boolean[]) { confirmations.push(...values) },
    get idle() { return idle },
    set idle(value: boolean) { idle = value },
    get failDelivery() { return failDelivery },
    set failDelivery(value: boolean) { failDelivery = value },
    failAppend(customType: string, enabled = true) {
      if (enabled) appendFailures.add(customType)
      else appendFailures.delete(customType)
    },
    appendBranchUserMessage(text: string) {
      branch.push({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })
    },
    async start() {
      await withAgentDir(() => emit('session_start', { type: 'session_start' }))
    },
    async startSession(nextSessionId: string) {
      currentSessionId = nextSessionId
      await withAgentDir(() => emit('session_start', { type: 'session_start' }))
    },
    async messageStart(text: string) {
      await emit('message_start', {
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })
    },
    async messageEnd(
      role: 'assistant' | 'toolResult' | 'user',
      content: FakeContent,
    ) {
      await emit('message_end', { type: 'message_end', message: { role, content } })
    },
    async confirmDelivery(index = received.length - 1) {
      const delivery = received[index]
      assert.ok(delivery)
      await emit('message_start', {
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: delivery.text }] },
      })
    },
    async settle() {
      await emit('agent_settled', { type: 'agent_settled' })
    },
    agentEnd<Event extends { type: 'agent_end'; messages: [] }>(event: Event) {
      return emit('agent_end', event)
    },
    async shutdown() {
      await emit('session_shutdown', { type: 'session_shutdown' })
      if (ownedDiagnosticsRoot) rmSync(ownedDiagnosticsRoot, { recursive: true, force: true })
      rmSync(agentDir, { recursive: true, force: true })
      if (ownedCwd) rmSync(ownedCwd, { recursive: true, force: true })
    },
    async command(name: string, args: string) {
      const command = commands.get(name)
      assert.ok(command)
      await command.handler(args, createContext())
    },
    async tool(name: string, params: {
      to: string
      body: string
      kind?: string
      reply_to?: string
      correlation_id?: string
      causation_id?: string
    }) {
      const tool = tools.get(name)
      assert.ok(tool)
      return tool.execute('tool-call', params, undefined, undefined, createContext())
    },
  }
}

export function message(overrides: Partial<CanonicalMessage> & { id: string; to: string }): CanonicalMessage {
  return {
    id: overrides.id,
    from: overrides.from ?? 'a4s/claude-1',
    to: overrides.to,
    kind: overrides.kind ?? 'task.request',
    body: overrides.body ?? 'Done',
    ts: overrides.ts ?? Date.now(),
    ...(overrides.reply_to ? { reply_to: overrides.reply_to } : {}),
    ...(overrides.correlation_id ? { correlation_id: overrides.correlation_id } : {}),
    ...(overrides.causation_id ? { causation_id: overrides.causation_id } : {}),
    ...(overrides.deadline === undefined ? {} : { deadline: overrides.deadline }),
  }
}

export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export function pendingEntryMessageId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || !('data' in entry)) return undefined
  const data = entry.data
  if (typeof data !== 'object' || data === null || !('message' in data)) return undefined
  const persistedMessage = data.message
  if (typeof persistedMessage !== 'object' || persistedMessage === null || !('id' in persistedMessage)) return undefined
  return typeof persistedMessage.id === 'string' ? persistedMessage.id : undefined
}
