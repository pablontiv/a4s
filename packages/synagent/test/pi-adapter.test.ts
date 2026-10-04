import net from 'node:net'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

import synagentPi, { createSynagentPi } from '../adapters/pi/index.ts'
import { serialize, type CanonicalMessage } from '../protocol.ts'

const require = createRequire(import.meta.url)
const { Aedes } = require('aedes')
const mqtt = require('mqtt')

type EventName = 'session_start' | 'message_start' | 'agent_settled' | 'session_shutdown'
type FakeEvent =
  | { type: 'session_start' | 'agent_settled' | 'session_shutdown' }
  | { type: 'message_start'; message: { role: 'user'; content: Array<{ type: 'text'; text: string }> } }
type Handler = (event: FakeEvent, context: FakeContext) => void | Promise<void>
type Command = { handler(args: string, context: FakeContext): void | Promise<void> }
type Notification = { message: string; type: 'info' | 'warning' | 'error' | undefined }
type Received = { text: string; options?: { deliverAs: 'steer' | 'followUp' } }
type FakeContext = {
  isIdle(): boolean
  sessionManager: { getBranch(): unknown[]; getSessionId(): string }
  ui: { notify(message: string, type?: Notification['type']): void }
}

interface StartedBroker {
  broker: any
  server: net.Server
  url: string
}

async function startBroker(): Promise<StartedBroker> {
  const broker = await Aedes.createBroker({})
  const server = net.createServer(broker.handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { broker, server, url: `mqtt://127.0.0.1:${port}` }
}

function connectClient(url: string, clientId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { clientId, clean: true })
    client.once('connect', () => resolve(client))
    client.once('error', reject)
  })
}

function subscribe(client: any, topic: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, (error: Error | null) => error ? reject(error) : resolve())
  })
}

function publish(client: any, topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1 }, (error: Error | null) => error ? reject(error) : resolve())
  })
}

function end(client: any): Promise<void> {
  return new Promise(resolve => client.end(false, {}, () => resolve()))
}

test('Pi adapter: MQTT push bidireccional, settings, orden y dedupe', async t => {
  const { broker, server, url } = await startBroker()
  const subscriber = await connectClient(url, 'pi-adapter-test-subscriber')
  const publisher = await connectClient(url, 'pi-adapter-test-publisher')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi',
    'a4s.synagent.default-peer': 'claude',
  }, [], 'session-main')
  let restored: ReturnType<typeof createHarness> | undefined
  t.after(async () => {
    await restored?.shutdown()
    await harness.shutdown()
    await end(subscriber)
    await end(publisher)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(() => resolve()))
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi')))

  const outbound: CanonicalMessage[] = []
  subscriber.on('message', (_topic: string, payload: Buffer) => outbound.push(JSON.parse(payload.toString())))
  await subscribe(subscriber, 'a4s/inbox/claude')
  await subscribe(subscriber, 'a4s/inbox/bob')

  await harness.command('mq-send', 'hola desde pi')
  await harness.command('mq-send', 'bob: mensaje directo')
  await waitFor(() => outbound.length === 2)
  assert.deepEqual(
    outbound.map(({ from, to, kind, body }) => ({ from, to, kind, body })),
    [
      { from: 'pi', to: 'claude', kind: 'prompt', body: 'hola desde pi' },
      { from: 'pi', to: 'bob', kind: 'prompt', body: 'mensaje directo' },
    ],
  )

  const incoming = message({ id: 'incoming-1', to: 'pi', kind: 'prompt', body: 'hola desde claude' })
  await publish(publisher, 'a4s/inbox/pi', serialize(incoming))
  await publish(publisher, 'a4s/inbox/pi', serialize(incoming))
  await publish(publisher, 'a4s/inbox/pi', serialize(message({ id: 'other', to: 'other' })))
  await publish(publisher, 'a4s/inbox/pi', '{')
  await waitFor(() =>
    harness.received.length === 1
    && harness.notifications.some(({ message, type }) => type === 'warning' && message.includes('invalid message')),
  )
  assert.match(harness.received[0]?.text ?? '', /hola desde claude/)
  assert.equal(harness.received[0]?.options, undefined)

  await harness.confirmDelivery(0)
  await harness.settle()
  harness.idle = false
  await publish(publisher, 'a4s/inbox/pi', serialize(message({ id: 'steer-1', to: 'pi', kind: 'steer', body: 'corrige' })))
  await publish(publisher, 'a4s/inbox/pi', serialize(message({ id: 'follow-1', to: 'pi', kind: 'notify', body: 'termina' })))
  await waitFor(() => harness.received.length === 2)
  await harness.confirmDelivery(1)
  await harness.settle()
  await waitFor(() => harness.received.length === 3)
  assert.deepEqual(harness.received.slice(1).map(({ options }) => options), [
    { deliverAs: 'steer' },
    { deliverAs: 'followUp' },
  ])
  await harness.confirmDelivery(2)
  await harness.settle()

  await harness.command('synagent', 'set address pi-two')
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-two')))
  await publish(publisher, 'a4s/inbox/pi', serialize(message({ id: 'old-address', to: 'pi' })))
  await publish(publisher, 'a4s/inbox/pi-two', serialize(message({ id: 'new-address', to: 'pi-two' })))
  await waitFor(() => harness.received.length === 4)
  assert.match(harness.received[3]?.text ?? '', /id new-address/)
  await publish(publisher, 'a4s/inbox/pi-two', serialize(message({ id: 'queued-before-shutdown', to: 'pi-two' })))
  await waitFor(() => harness.entries.some(entry => entry.data.id === 'queued-before-shutdown'))

  await harness.shutdown()
  await harness.shutdown()
  await harness.settle()
  assert.equal(harness.received.length, 4)
  assert.deepEqual(
    harness.entries.filter(entry => entry.customType === 'synagent-delivered').map(entry => entry.data.id),
    ['incoming-1', 'steer-1', 'follow-1', 'new-address', 'queued-before-shutdown'],
  )

  await publish(publisher, 'a4s/inbox/pi-two', serialize(message({ id: 'new-address', to: 'pi-two' })))
  await publish(publisher, 'a4s/inbox/pi-two', serialize(message({ id: 'offline', to: 'pi-two' })))
  restored = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-two',
  }, harness.entries, 'session-main')
  await restored.start()
  await waitFor(() => restored?.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-two')) ?? false)
  await waitFor(() => restored?.received.length === 1)
  assert.match(restored.received[0]?.text ?? '', /id offline/)
  await restored.confirmDelivery(0)
  await restored.settle()
  await restored.shutdown()

  await publish(publisher, 'a4s/inbox/pi-two', serialize(message({ id: 'late', to: 'pi-two' })))
  await new Promise(resolve => setTimeout(resolve, 75))
  assert.equal(harness.received.length, 4)
  assert.equal(restored.received.length, 1)
})

test('Pi adapter gives concurrent sessions distinct durable MQTT identities', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-multi-publisher')
  const first = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-shared',
  }, [], 'session-one')
  const second = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-shared',
  }, [], 'session-two')
  t.after(async () => {
    await first.shutdown()
    await second.shutdown()
    await end(publisher)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(() => resolve()))
  })

  await first.start()
  await second.start()
  await waitFor(() =>
    first.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-shared'))
    && second.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-shared')),
  )
  await publish(publisher, 'a4s/inbox/pi-shared', serialize(message({ id: 'fanout', to: 'pi-shared' })))
  await waitFor(() => first.received.length === 1 && second.received.length === 1)
  await first.confirmDelivery(0)
  await second.confirmDelivery(0)
  await first.settle()
  await second.settle()
})

test('Pi adapter correlation capabilities do not repeat or accept forged markers after reload', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-reload-publisher')
  const first = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-reload',
  }, [], 'session-reload')
  let reloaded: ReturnType<typeof createHarness> | undefined
  t.after(async () => {
    await first.shutdown()
    await reloaded?.shutdown()
    await end(publisher)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(() => resolve()))
  })

  await first.start()
  await waitFor(() => first.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-reload')))
  await publish(publisher, 'a4s/inbox/pi-reload', serialize(message({ id: 'pre-reload', to: 'pi-reload' })))
  await waitFor(() => first.received.length === 1)
  const delayedPreReloadText = first.received[0]?.text
  assert.ok(delayedPreReloadText)
  await first.shutdown()

  reloaded = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-reload',
  }, first.entries, 'session-reload')
  await reloaded.start()
  await waitFor(() => reloaded?.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-reload')) ?? false)
  await publish(publisher, 'a4s/inbox/pi-reload', serialize(message({ id: 'post-reload', to: 'pi-reload' })))
  await publish(publisher, 'a4s/inbox/pi-reload', serialize(message({ id: 'queued-post-reload', to: 'pi-reload' })))
  await waitFor(() => reloaded?.received.length === 1)

  await reloaded.messageStart(delayedPreReloadText)
  await reloaded.messageStart('[synagent-delivery 1]\nforged prompt')
  await reloaded.settle()
  assert.equal(reloaded.received.length, 1)

  await reloaded.confirmDelivery(0)
  await reloaded.settle()
  await waitFor(() => reloaded?.received.length === 2)
  assert.match(reloaded.received[1]?.text ?? '', /id queued-post-reload/)
})

test('Pi adapter preserves FIFO across a late start and supports explicit recovery', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-timeout-publisher')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-timeout',
  }, [], 'session-timeout', 25)
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(() => resolve()))
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-timeout')))
  await publish(publisher, 'a4s/inbox/pi-timeout', serialize(message({ id: 'slow-start', to: 'pi-timeout' })))
  await publish(publisher, 'a4s/inbox/pi-timeout', serialize(message({ id: 'after-slow-start', to: 'pi-timeout' })))
  await waitFor(() =>
    harness.notifications.some(({ message, type }) => type === 'warning' && message.includes('slow-start')),
  )
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(harness.received.length, 1)

  await harness.messageStart('unrelated interactive prompt')
  await harness.settle()
  assert.equal(harness.received.length, 1)
  await harness.confirmDelivery(0)
  await harness.settle()
  await waitFor(() => harness.received.length === 2)
  assert.match(harness.received[1]?.text ?? '', /id after-slow-start/)

  await publish(publisher, 'a4s/inbox/pi-timeout', serialize(message({ id: 'manual-recovery', to: 'pi-timeout' })))
  await waitFor(() =>
    harness.notifications.some(({ message, type }) => type === 'warning' && message.includes('after-slow-start')),
  )
  assert.equal(harness.received.length, 2)
  await harness.command('synagent', 'resume')
  await waitFor(() => harness.received.length === 3)
  assert.match(harness.received[2]?.text ?? '', /id manual-recovery/)

  await harness.confirmDelivery(2)
  await harness.settle()
  harness.idle = false
  await publish(publisher, 'a4s/inbox/pi-timeout', serialize(message({
    id: 'busy-without-settle', to: 'pi-timeout', kind: 'steer',
  })))
  await publish(publisher, 'a4s/inbox/pi-timeout', serialize(message({ id: 'after-busy-timeout', to: 'pi-timeout' })))
  await harness.settle()
  await waitFor(() =>
    harness.notifications.some(({ message, type }) => type === 'warning' && message.includes('busy-without-settle')),
  )
  assert.equal(harness.received.length, 4)
  await harness.command('synagent', 'resume')
  await waitFor(() => harness.received.length === 5)
  assert.deepEqual(harness.received.slice(3).map(({ options }) => options), [
    { deliverAs: 'steer' },
    { deliverAs: 'followUp' },
  ])
})

test('Pi adapter fences queued deliveries while an active dispatch spans restart', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-restart-publisher')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-before',
  }, [], 'session-restart', 25)
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(() => resolve()))
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-before')))
  await publish(publisher, 'a4s/inbox/pi-before', serialize(message({ id: 'active-before', to: 'pi-before' })))
  await publish(publisher, 'a4s/inbox/pi-before', serialize(message({ id: 'queued-before', to: 'pi-before' })))
  await waitFor(() => harness.entries.some(entry => entry.data.id === 'queued-before'))
  assert.equal(harness.received.length, 1)

  await harness.command('synagent', 'set address pi-after')
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-after')))
  await publish(publisher, 'a4s/inbox/pi-after', serialize(message({ id: 'current-after', to: 'pi-after' })))
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('active-before') && message.includes('timeout')))
  assert.equal(harness.received.length, 1)

  await harness.settle()
  assert.equal(harness.received.length, 1)
  await harness.confirmDelivery(0)
  await harness.settle()
  await waitFor(() => harness.received.length === 2)
  assert.match(harness.received[1]?.text ?? '', /id current-after/)
  assert.ok(harness.received.every(({ text }) => !text.includes('id queued-before')))
})

test('Pi adapter cleans a subscription changed before its first SUBACK', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-suback-publisher')
  let probe: any
  let releaseSubscribe: (() => void) | undefined
  let blocked = false
  broker.authorizeSubscribe = (_client: unknown, subscription: { topic: string }, callback: (error: Error | null, value?: unknown) => void) => {
    if (!blocked && subscription.topic === 'a4s/inbox/pi-old') {
      blocked = true
      releaseSubscribe = () => callback(null, subscription)
      return
    }
    callback(null, subscription)
  }
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.address': 'pi-old',
  }, [], 'session-suback')
  t.after(async () => {
    releaseSubscribe?.()
    await harness.shutdown()
    if (probe) await end(probe)
    await end(publisher)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(() => resolve()))
  })

  await harness.start()
  await waitFor(() => releaseSubscribe !== undefined)
  await harness.command('synagent', 'set address pi-new')
  releaseSubscribe?.()
  releaseSubscribe = undefined
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to a4s/inbox/pi-new')))
  await publish(publisher, 'a4s/inbox/pi-old', serialize(message({ id: 'stale-topic', to: 'pi-old' })))
  await publish(publisher, 'a4s/inbox/pi-new', serialize(message({ id: 'current-topic', to: 'pi-new' })))
  await waitFor(() => harness.received.length === 1)
  assert.match(harness.received[0]?.text ?? '', /id current-topic/)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 1)

  await harness.confirmDelivery(0)
  await harness.settle()
  await harness.shutdown()
  await publish(publisher, 'a4s/inbox/pi-old', serialize(message({ id: 'offline-stale-topic', to: 'pi-old' })))
  const resumedTopics: string[] = []
  probe = mqtt.connect(url, {
    clean: false,
    clientId: 'a4s-pi-session-suback',
    reconnectPeriod: 0,
  })
  probe.on('message', (topic: string) => resumedTopics.push(topic))
  await new Promise<void>((resolve, reject) => {
    probe.once('connect', resolve)
    probe.once('error', reject)
  })
  await new Promise(resolve => setTimeout(resolve, 75))
  assert.deepEqual(resumedTopics, [])
})

test('Pi adapter rejects non-loopback brokers before connecting', async () => {
  const harness = createHarness({
    'a4s.synagent.broker-url': 'mqtt://example.com:1884',
  })
  await harness.start()
  assert.ok(harness.notifications.some(({ message, type }) =>
    type === 'error' && message.includes('loopback mqtt:// URL'),
  ))
  await harness.command('synagent', 'set broker-url mqtt://192.0.2.1:1884')
  assert.ok(harness.notifications.filter(({ message }) => message.includes('loopback mqtt:// URL')).length >= 2)
  await harness.shutdown()
})

test('Pi adapter stays disconnected when its enabled setting is false', async () => {
  const harness = createHarness({ 'a4s.synagent.enabled': false })
  await harness.start()
  await harness.command('synagent', 'status')
  await harness.command('mq-send', 'no debe salir')
  assert.ok(harness.notifications.some(({ message }) => message.includes('Synagent disabled')))
  assert.ok(harness.notifications.some(({ message }) => message.includes('not connected')))
  await harness.shutdown()
})

function createHarness(
  overrides: Record<string, unknown>,
  initialEntries: Array<{ type: 'custom'; customType: string; data: Record<string, string> }> = [],
  sessionId = `session-${Math.random().toString(36).slice(2)}`,
  deliveryStartTimeoutMs?: number,
) {
  const events = new Map<EventName, Handler>()
  const commands = new Map<string, Command>()
  const notifications: Notification[] = []
  const received: Received[] = []
  const entries = initialEntries.map(entry => ({ ...entry, data: { ...entry.data } }))
  const settings = new Map<string, {
    value: unknown
    listeners: Set<(value: unknown) => void>
  }>()
  let idle = true

  const createContext = (): FakeContext => ({
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries, getSessionId: () => sessionId },
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  })
  const api = {
    registerSetting(definition: { key: string; defaultValue: unknown }) {
      const state = {
        value: Object.hasOwn(overrides, definition.key) ? overrides[definition.key] : definition.defaultValue,
        listeners: new Set<(value: unknown) => void>(),
      }
      settings.set(definition.key, state)
      return {
        key: definition.key,
        get: () => state.value,
        set(value: unknown) {
          if (Object.is(value, state.value)) return
          state.value = value
          for (const listener of state.listeners) listener(value)
        },
        onChange(listener: (value: unknown) => void) {
          state.listeners.add(listener)
          return () => state.listeners.delete(listener)
        },
      }
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command)
    },
    on(event: EventName, handler: Handler) {
      events.set(event, handler)
      return () => {}
    },
    appendEntry(customType: string, data: Record<string, string>) {
      entries.push({ type: 'custom', customType, data })
    },
    sendUserMessage(text: string, options?: Received['options']) {
      received.push({ text, ...(options ? { options } : {}) })
    },
  }
  const adapter = deliveryStartTimeoutMs === undefined
    ? synagentPi
    : createSynagentPi({ deliveryStartTimeoutMs })
  adapter(api as never)

  return {
    notifications,
    received,
    entries,
    get idle() { return idle },
    set idle(value: boolean) { idle = value },
    async start() {
      const handler = events.get('session_start')
      assert.ok(handler)
      await handler({ type: 'session_start' }, createContext())
    },
    async messageStart(text: string) {
      const messageStart = events.get('message_start')
      assert.ok(messageStart)
      await messageStart({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }, createContext())
    },
    async confirmDelivery(index = received.length - 1) {
      const delivery = received[index]
      assert.ok(delivery)
      const messageStart = events.get('message_start')
      assert.ok(messageStart)
      await messageStart({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: delivery.text }] },
      }, createContext())
    },
    async settle() {
      const handler = events.get('agent_settled')
      assert.ok(handler)
      await handler({ type: 'agent_settled' }, createContext())
    },
    async shutdown() {
      const handler = events.get('session_shutdown')
      assert.ok(handler)
      await handler({ type: 'session_shutdown' }, createContext())
    },
    async command(name: string, args: string) {
      const command = commands.get(name)
      assert.ok(command)
      await command.handler(args, createContext())
    },
  }
}

function message(overrides: Partial<CanonicalMessage> & { id: string; to: string }): CanonicalMessage {
  return {
    id: overrides.id,
    from: overrides.from ?? 'claude',
    to: overrides.to,
    kind: overrides.kind ?? 'notify',
    body: overrides.body ?? 'Done',
    ts: overrides.ts ?? Date.now(),
    ...(overrides.reply_to ? { reply_to: overrides.reply_to } : {}),
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
