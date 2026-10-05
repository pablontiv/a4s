import net from 'node:net'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { Check } from 'typebox/value'

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
type Tool = {
  execute(
    id: string,
    params: { to: string; body: string; kind?: string; reply_to?: string },
    signal: undefined,
    onUpdate: undefined,
    context: FakeContext,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>
}
type Notification = { message: string; type: 'info' | 'warning' | 'error' | undefined }
type Received = { text: string; options?: { deliverAs: 'steer' | 'followUp' } }
type FakeContext = {
  cwd: string
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

async function closeBroker(broker: any): Promise<void> {
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

async function closeServer(server: any): Promise<void> {
  try {
    server.closeAllConnections?.()
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

// Direcciones y topics v1 fijos usados por el harness (project=a4s, instance=pi-1).
const DIRECT_TOPIC = 'synagent/v1/a4s/pi-1'
const PROJECT_TOPIC = 'synagent/v1/a4s/all'
const GLOBAL_TOPIC = 'synagent/v1/all'
const LEGACY_TOPIC = 'a4s/inbox/pi'

test('Pi adapter: v1 push bidireccional, dual-read, broadcast, orden y dedupe', async t => {
  const { broker, server, url } = await startBroker()
  const subscriber = await connectClient(url, 'pi-adapter-test-subscriber')
  const publisher = await connectClient(url, 'pi-adapter-test-publisher')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
    'a4s.synagent.address': 'pi',
    'a4s.synagent.default-peer': 'a4s/claude-1',
  }, [], 'pi-1')
  let restored: ReturnType<typeof createHarness> | undefined
  t.after(async () => {
    await restored?.shutdown()
    await harness.shutdown()
    await end(subscriber)
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  await harness.start()
  // El cliente durable suscribe directo + legacy; el transient, el broadcast de proyecto.
  await waitFor(() =>
    harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(DIRECT_TOPIC))
    && harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(PROJECT_TOPIC)),
  )

  const outbound: CanonicalMessage[] = []
  subscriber.on('message', (_topic: string, payload: Buffer) => outbound.push(JSON.parse(payload.toString())))
  await subscribe(subscriber, 'synagent/v1/a4s/claude-1')
  await subscribe(subscriber, 'synagent/v1/a4s/bob')

  await harness.command('mq-send', 'hola desde pi')
  await harness.command('mq-send', 'bob: mensaje directo')
  await waitFor(() => outbound.length === 2)
  assert.deepEqual(
    outbound.map(({ from, to, kind, body }) => ({ from, to, kind, body })),
    [
      // default-peer ya es una dirección v1 completa; el token suelto `bob` se cualifica con el proyecto.
      { from: 'a4s/pi-1', to: 'a4s/claude-1', kind: 'prompt', body: 'hola desde pi' },
      { from: 'a4s/pi-1', to: 'a4s/bob', kind: 'prompt', body: 'mensaje directo' },
    ],
  )

  // Entrada directa: dedupe por id, filtro por identidad y rechazo de inválidos.
  const incoming = message({ id: 'incoming-1', to: 'a4s/pi-1', kind: 'prompt', body: 'hola desde claude' })
  await publish(publisher, DIRECT_TOPIC, serialize(incoming))
  await publish(publisher, DIRECT_TOPIC, serialize(incoming))
  await publish(publisher, DIRECT_TOPIC, serialize(message({ id: 'not-mine', to: 'a4s/other' })))
  await publish(publisher, DIRECT_TOPIC, '{')
  await waitFor(() =>
    harness.received.length === 1
    && harness.notifications.some(({ message, type }) => type === 'warning' && message.includes('invalid message')),
  )
  assert.match(harness.received[0]?.text ?? '', /hola desde claude/)
  assert.equal(harness.received[0]?.options, undefined)
  await harness.confirmDelivery(0)
  await harness.settle()

  // Broadcast de proyecto (cliente transient) — se entrega.
  await publish(publisher, PROJECT_TOPIC, serialize(message({ id: 'project-1', to: 'a4s/all', body: 'a todo el proyecto' })))
  await waitFor(() => harness.received.length === 2)
  assert.match(harness.received[1]?.text ?? '', /id project-1/)
  await harness.confirmDelivery(1)
  await harness.settle()

  // Legacy dual-read (a4s/inbox/pi) — se entrega gracias al cliente durable.
  await publish(publisher, LEGACY_TOPIC, serialize(message({ id: 'legacy-1', to: 'pi', body: 'via legacy' })))
  await waitFor(() => harness.received.length === 3)
  assert.match(harness.received[2]?.text ?? '', /id legacy-1/)
  await harness.confirmDelivery(2)
  await harness.settle()

  harness.idle = false
  // steer a broadcast se rechaza en recepción (precisión F) y NO se entrega.
  await publish(publisher, PROJECT_TOPIC, serialize(message({ id: 'steer-bcast', to: 'a4s/all', kind: 'steer', body: 'no' })))
  await waitFor(() =>
    harness.notifications.some(({ message, type }) => type === 'warning' && message.includes('rejected broadcast steer')),
  )
  await publish(publisher, DIRECT_TOPIC, serialize(message({ id: 'steer-1', to: 'a4s/pi-1', kind: 'steer', body: 'corrige' })))
  await publish(publisher, DIRECT_TOPIC, serialize(message({ id: 'follow-1', to: 'a4s/pi-1', kind: 'notify', body: 'termina' })))
  await waitFor(() => harness.received.length === 4)
  await harness.confirmDelivery(3)
  await harness.settle()
  await waitFor(() => harness.received.length === 5)
  assert.deepEqual(harness.received.slice(3).map(({ options }) => options), [
    { deliverAs: 'steer' },
    { deliverAs: 'followUp' },
  ])
  await harness.confirmDelivery(4)
  await harness.settle()

  // Global es opt-in: con global=false no llega.
  await publish(publisher, GLOBAL_TOPIC, serialize(message({ id: 'global-off', to: 'all', body: 'global' })))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 5)
  // Con global=true el cliente transient añade synagent/v1/all y el mismo mensaje sí llega.
  await harness.command('synagent', 'set global true')
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(GLOBAL_TOPIC)))
  await publish(publisher, GLOBAL_TOPIC, serialize(message({ id: 'global-on', to: 'all', body: 'global now' })))
  await waitFor(() => harness.received.length === 6)
  assert.match(harness.received[5]?.text ?? '', /id global-on/)
  await harness.confirmDelivery(5)
  await harness.settle()
  harness.idle = true

  // Un new/fork cambia el id nativo: session_start re-resuelve la identidad y re-vincula MQTT.
  await harness.startSession('pi-2')
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes('synagent/v1/a4s/pi-2')))
  assert.ok(harness.notifications.some(({ message }) => message.includes('Synagent identity a4s/pi-2')))
  await publish(publisher, DIRECT_TOPIC, serialize(message({ id: 'old-instance', to: 'a4s/pi-1' })))
  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'new-instance', to: 'a4s/pi-2' })))
  await waitFor(() => harness.received.length === 7)
  assert.match(harness.received[6]?.text ?? '', /id new-instance/)
  // Dejamos la entrega de new-instance activa (sin confirmar): lo siguiente queda ENCOLADO, no entregado.
  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'queued-before-shutdown', to: 'a4s/pi-2' })))
  await waitFor(() => harness.entries.some(entry => entry.data.id === 'queued-before-shutdown'))

  await harness.shutdown()
  await harness.shutdown()
  await harness.settle()
  assert.equal(harness.received.length, 7)
  assert.deepEqual(
    harness.entries.filter(entry => entry.customType === 'synagent-delivered').map(entry => entry.data.id),
    ['incoming-1', 'project-1', 'legacy-1', 'steer-1', 'follow-1', 'global-on', 'new-instance', 'queued-before-shutdown'],
  )

  // Reanudación durable: misma sesión → mismo clientId → recibe lo encolado offline (deduplicando).
  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'new-instance', to: 'a4s/pi-2' })))
  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'offline', to: 'a4s/pi-2' })))
  restored = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
    'a4s.synagent.address': 'pi',
  }, harness.entries, 'pi-2')
  await restored.start()
  await waitFor(() => restored?.notifications.some(({ message }) => message.includes('subscribed to') && message.includes('synagent/v1/a4s/pi-2')) ?? false)
  await waitFor(() => restored?.received.length === 1)
  assert.match(restored.received[0]?.text ?? '', /id offline/)
  await restored.confirmDelivery(0)
  await restored.settle()
  await restored.shutdown()

  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'late', to: 'a4s/pi-2' })))
  await new Promise(resolve => setTimeout(resolve, 75))
  assert.equal(harness.received.length, 7)
  assert.equal(restored.received.length, 1)
})

test('Pi adapter gives concurrent sessions distinct durable MQTT identities', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-multi-publisher')
  const first = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 'Session.One')
  const second = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 'Session.Two')
  t.after(async () => {
    await first.shutdown()
    await second.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  await first.start()
  await second.start()
  await waitFor(() =>
    first.notifications.some(({ message }) => message.includes('subscribed to') && message.includes('synagent/v1/a4s/Session.One'))
    && second.notifications.some(({ message }) => message.includes('subscribed to') && message.includes('synagent/v1/a4s/Session.Two')),
  )
  await publish(publisher, 'synagent/v1/a4s/Session.One', serialize(message({ id: 'only-one', to: 'a4s/Session.One' })))
  await waitFor(() => first.received.length === 1)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(second.received.length, 0)
  await first.confirmDelivery(0)
  await first.settle()

  await publish(publisher, 'synagent/v1/a4s/Session.Two', serialize(message({ id: 'only-two', to: 'a4s/Session.Two' })))
  await waitFor(() => second.received.length === 1)
  assert.equal(first.received.length, 1)
  await second.confirmDelivery(0)
  await second.settle()
})

test('Pi adapter keeps session IDs X and t-X from colliding or evicting each other', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-collision-publisher')
  const first = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 'X')
  const second = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 't-X')
  t.after(async () => {
    await first.shutdown()
    await second.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  await first.start()
  await second.start()
  await waitFor(() => first.notifications.some(({ message }) => message.includes('subscribed to synagent/v1/a4s/X')))
  await waitFor(() => second.notifications.some(({ message }) => message.includes('subscribed to synagent/v1/a4s/t-X')))

  await publish(publisher, 'synagent/v1/a4s/t-X', serialize(message({ id: 'collision-direct', to: 'a4s/t-X' })))
  await waitFor(() => second.received.some(({ text }) => text.includes('id collision-direct')))
  await publish(publisher, PROJECT_TOPIC, serialize(message({ id: 'collision-project', to: 'a4s/all' })))
  await waitFor(() => first.received.some(({ text }) => text.includes('id collision-project')))
})

test('Pi adapter reload/resume retains the same native session ID and correlation state', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-reload-publisher')
  const first = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 'pi-reload')
  let reloaded: ReturnType<typeof createHarness> | undefined
  t.after(async () => {
    await first.shutdown()
    await reloaded?.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  await first.start()
  await waitFor(() => first.notifications.some(({ message }) => message.includes('subscribed to') && message.includes('synagent/v1/a4s/pi-reload')))
  assert.ok(first.notifications.some(({ message }) => message.includes('Synagent identity a4s/pi-reload')))
  await publish(publisher, 'synagent/v1/a4s/pi-reload', serialize(message({ id: 'pre-reload', to: 'a4s/pi-reload' })))
  await waitFor(() => first.received.length === 1)
  const delayedPreReloadText = first.received[0]?.text
  assert.ok(delayedPreReloadText)
  await first.shutdown()

  reloaded = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, first.entries, 'pi-reload')
  await reloaded.start()
  await waitFor(() => reloaded?.notifications.some(({ message }) => message.includes('subscribed to') && message.includes('synagent/v1/a4s/pi-reload')) ?? false)
  assert.ok(reloaded.notifications.some(({ message }) => message.includes('Synagent identity a4s/pi-reload')))
  await publish(publisher, 'synagent/v1/a4s/pi-reload', serialize(message({ id: 'post-reload', to: 'a4s/pi-reload' })))
  await publish(publisher, 'synagent/v1/a4s/pi-reload', serialize(message({ id: 'queued-post-reload', to: 'a4s/pi-reload' })))
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
    'a4s.synagent.project': 'a4s',
  }, [], 'pi-timeout', 25)
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  const topic = 'synagent/v1/a4s/pi-timeout'
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(topic)))
  await publish(publisher, topic, serialize(message({ id: 'slow-start', to: 'a4s/pi-timeout' })))
  await publish(publisher, topic, serialize(message({ id: 'after-slow-start', to: 'a4s/pi-timeout' })))
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

  await publish(publisher, topic, serialize(message({ id: 'manual-recovery', to: 'a4s/pi-timeout' })))
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
  await publish(publisher, topic, serialize(message({
    id: 'busy-without-settle', to: 'a4s/pi-timeout', kind: 'steer',
  })))
  await publish(publisher, topic, serialize(message({ id: 'after-busy-timeout', to: 'a4s/pi-timeout' })))
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

test('Pi adapter new/fork session_start re-resolves the native session ID and rebinds', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-restart-publisher')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 'pi-before', 25)
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  const before = 'synagent/v1/a4s/pi-before'
  const after = 'synagent/v1/a4s/pi-after'
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(before)))
  await publish(publisher, before, serialize(message({ id: 'active-before', to: 'a4s/pi-before' })))
  await publish(publisher, before, serialize(message({ id: 'queued-before', to: 'a4s/pi-before' })))
  await waitFor(() => harness.entries.some(entry => entry.data.id === 'queued-before'))
  assert.equal(harness.received.length, 1)

  await harness.startSession('pi-after')
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(after)))
  assert.ok(harness.notifications.some(({ message }) => message.includes('Synagent identity a4s/pi-after')))
  await publish(publisher, after, serialize(message({ id: 'current-after', to: 'a4s/pi-after' })))
  await waitFor(() => harness.received.length === 2)
  assert.match(harness.received[1]?.text ?? '', /id current-after/)
  assert.ok(harness.received.every(({ text }) => !text.includes('id queued-before')))
  await harness.confirmDelivery(1)
  await harness.settle()
})

test('Pi adapter cleans a durable subscription changed before its first SUBACK', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-suback-publisher')
  let probe: any
  let releaseSubscribe: (() => void) | undefined
  let blocked = false
  const oldTopic = 'synagent/v1/a4s/pi-old'
  const newTopic = 'synagent/v1/next/pi-old'
  broker.authorizeSubscribe = (_client: unknown, subscription: { topic: string }, callback: (error: Error | null, value?: unknown) => void) => {
    if (!blocked && subscription.topic === oldTopic) {
      blocked = true
      releaseSubscribe = () => callback(null, subscription)
      return
    }
    callback(null, subscription)
  }
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 'pi-old')
  t.after(async () => {
    releaseSubscribe?.()
    await harness.shutdown()
    if (probe) await end(probe)
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  await harness.start()
  await waitFor(() => releaseSubscribe !== undefined)
  await harness.command('synagent', 'set project next')
  releaseSubscribe?.()
  releaseSubscribe = undefined
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(newTopic)))
  await publish(publisher, oldTopic, serialize(message({ id: 'stale-topic', to: 'a4s/pi-old' })))
  await publish(publisher, newTopic, serialize(message({ id: 'current-topic', to: 'next/pi-old' })))
  await waitFor(() => harness.received.length === 1)
  assert.match(harness.received[0]?.text ?? '', /id current-topic/)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 1)

  await harness.confirmDelivery(0)
  await harness.settle()
  await harness.shutdown()
  await publish(publisher, oldTopic, serialize(message({ id: 'offline-stale-topic', to: 'a4s/pi-old' })))
  const resumedTopics: string[] = []
  probe = mqtt.connect(url, {
    clean: false,
    clientId: 'a4s-pi-pi-old',
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

test('Pi adapter uses session cwd origin and native mixed-case identity, ignores env, and exposes intent send', async t => {
  const { broker, server, url } = await startBroker()
  const subscriber = await connectClient(url, 'pi-adapter-native-subscriber')
  const cwd = mkdtempSync(join(tmpdir(), 'synagent-pi-origin-'))
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Example/Repo.Name.git'], { cwd })
  const oldProject = process.env.SYNAGENT_PROJECT
  const oldInstance = process.env.SYNAGENT_INSTANCE
  process.env.SYNAGENT_PROJECT = 'WrongEnvProject'
  process.env.SYNAGENT_INSTANCE = 'WrongEnvInstance'
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], 'Native.Session-A', undefined, cwd)
  t.after(async () => {
    if (oldProject === undefined) delete process.env.SYNAGENT_PROJECT
    else process.env.SYNAGENT_PROJECT = oldProject
    if (oldInstance === undefined) delete process.env.SYNAGENT_INSTANCE
    else process.env.SYNAGENT_INSTANCE = oldInstance
    await harness.shutdown()
    await end(subscriber)
    await closeServer(server)
    await closeBroker(broker)
    rmSync(cwd, { recursive: true, force: true })
  })

  await harness.start()
  const directTopic = 'synagent/v1/Repo.Name/Native.Session-A'
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(directTopic)))
  assert.ok(![...harness.settingKeys].includes('a4s.synagent.instance'))
  assert.ok(harness.entries.every(entry => entry.customType !== 'synagent-instance'))

  const outbound: CanonicalMessage[] = []
  subscriber.on('message', (_topic: string, payload: Buffer) => outbound.push(JSON.parse(payload.toString())))
  await subscribe(subscriber, 'synagent/v1/Repo.Name/Peer.Agent')
  await subscribe(subscriber, 'synagent/v1/Repo.Name/all')
  const toolSchema = harness.toolSchemas.get('synagent_send')
  assert.ok(toolSchema)
  assert.equal(Check(toolSchema, { to: 'Repo.Name/Peer.Agent', body: 'valid', kind: 'result' }), true)
  assert.equal(Check(toolSchema, { to: 'Repo.Name/Peer.Agent', body: 'invalid', kind: 'bogus' }), false)

  const invalid = await harness.tool('synagent_send', { to: 'not/an/address/at/all', body: 'invalid' })
  assert.equal(invalid.isError, true)
  const sent = await harness.tool('synagent_send', {
    to: 'Repo.Name/Peer.Agent',
    body: 'intent message',
    kind: 'result',
    reply_to: 'request-1',
  })
  assert.notEqual(sent.isError, true)
  assert.match(sent.content[0]?.text ?? '', /^Synagent message sent:/)
  await waitFor(() => outbound.length === 1)
  assert.deepEqual(
    (({ from, to, kind, body, reply_to }) => ({ from, to, kind, body, reply_to }))(outbound[0] as CanonicalMessage),
    {
      from: 'Repo.Name/Native.Session-A',
      to: 'Repo.Name/Peer.Agent',
      kind: 'result',
      body: 'intent message',
      reply_to: 'request-1',
    },
  )
  const broadcast = await harness.tool('synagent_send', {
    to: 'Repo.Name/all',
    body: 'self echo must be suppressed',
  })
  assert.match(broadcast.content[0]?.text ?? '', /^Synagent message sent:/)
  await waitFor(() => outbound.length === 2)
  assert.equal(outbound[1]?.to, 'Repo.Name/all')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 0)

  await harness.command('synagent', 'set instance obsolete')
  assert.ok(harness.notifications.some(({ message, type }) => type === 'error' && message.includes('Unknown Synagent setting: instance')))
})

test('Pi adapter configured project wins over a conflicting session cwd origin', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-configured-project-publisher')
  const cwd = mkdtempSync(join(tmpdir(), 'synagent-pi-configured-project-'))
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Example/Origin.Project.git'], { cwd })
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'Configured.Project',
  }, [], 'Configured.Session', undefined, cwd)
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
    rmSync(cwd, { recursive: true, force: true })
  })

  await harness.start()
  const configuredTopic = 'synagent/v1/Configured.Project/Configured.Session'
  await waitFor(() => harness.notifications.some(({ message }) =>
    message.includes('subscribed to') && message.includes(configuredTopic),
  ))
  assert.ok(harness.notifications.some(({ message }) =>
    message.includes('Synagent identity Configured.Project/Configured.Session'),
  ))

  await publish(publisher, 'synagent/v1/Origin.Project/Configured.Session', serialize(message({
    id: 'wrong-origin',
    to: 'Origin.Project/Configured.Session',
  })))
  await publish(publisher, configuredTopic, serialize(message({
    id: 'configured-project',
    to: 'Configured.Project/Configured.Session',
  })))
  await waitFor(() => harness.received.length === 1)
  assert.match(harness.received[0]?.text ?? '', /id configured-project/)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 1)
})

test('Pi adapter unresolved project stays legacy-only and refuses all v1 send intent', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-legacy-publisher')
  const observer = await connectClient(url, 'pi-adapter-legacy-observer')
  const cwd = mkdtempSync(join(tmpdir(), 'synagent-pi-no-origin-'))
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.default-peer': 'Some.Project/Peer.One',
  }, [], 'Legacy.Session', undefined, cwd)
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await end(observer)
    await closeServer(server)
    await closeBroker(broker)
    rmSync(cwd, { recursive: true, force: true })
  })

  const publishedV1: string[] = []
  observer.on('message', (topic: string) => publishedV1.push(topic))
  await subscribe(observer, 'synagent/v1/#')
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message, type }) =>
    type === 'warning' && message.includes('identity unresolved') && message.includes('legacy-only'),
  ))
  await waitFor(() => harness.notifications.some(({ message }) =>
    message.includes('subscribed to a4s/inbox/pi') && !message.includes('synagent/v1/'),
  ))

  const toolResult = await harness.tool('synagent_send', { to: 'Some.Project/Peer.One', body: 'must not publish' })
  assert.equal(toolResult.isError, true)
  assert.match(toolResult.content[0]?.text ?? '', /configure the project setting/)
  await harness.command('synagent', 'status')
  assert.ok(harness.notifications.some(({ message }) =>
    message.includes('legacy-only') && message.includes('/synagent set project'),
  ))
  await harness.command('mq-send', 'must not publish either')
  assert.ok(harness.notifications.some(({ message }) => message.includes('configure the project setting')))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(publishedV1, [])

  await publish(publisher, LEGACY_TOPIC, serialize(message({ id: 'legacy-only-in', to: 'pi' })))
  await waitFor(() => harness.received.length === 1)
  assert.match(harness.received[0]?.text ?? '', /id legacy-only-in/)
})

test('Pi adapter warns and falls back to the default for invalid or non-loopback brokers', async t => {
  for (const configured of ['not-a-url', 'mqtt://example.com:1884']) {
    const harness = createHarness({ 'a4s.synagent.broker-url': configured })
    try {
      await harness.start()
      assert.ok(harness.notifications.some(({ message, type }) =>
        type === 'warning'
        && message.includes(configured)
        && message.includes('mqtt://127.0.0.1:1884'),
      ))
    } finally {
      await harness.shutdown()
    }
  }
})

test('Pi adapter marks MQTT publish failures as tool errors', async t => {
  const { broker, server, url } = await startBroker()
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
  }, [], 'publish-failure')
  t.after(async () => {
    await harness.shutdown()
    await closeServer(server)
    await closeBroker(broker)
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to')))
  broker.authorizePublish = (_client: unknown, _packet: unknown, callback: (error?: Error) => void) => {
    callback(new Error('publish denied for regression test'))
  }
  const result = await harness.tool('synagent_send', { to: 'a4s/peer', body: 'must fail' })
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /publish failed/i)
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
  cwd = process.cwd(),
) {
  const events = new Map<EventName, Handler>()
  const commands = new Map<string, Command>()
  const tools = new Map<string, Tool>()
  const notifications: Notification[] = []
  const received: Received[] = []
  const entries = initialEntries.map(entry => ({ ...entry, data: { ...entry.data } }))
  const settings = new Map<string, {
    value: unknown
    listeners: Set<(value: unknown) => void>
  }>()
  let idle = true
  let currentSessionId = sessionId

  const createContext = (): FakeContext => ({
    cwd,
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries, getSessionId: () => currentSessionId },
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
    registerTool(tool: Tool & { name: string }) {
      tools.set(tool.name, tool)
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
  // Always create a new adapter instance to avoid shared state between test harnesses
  const adapter = createSynagentPi({ deliveryStartTimeoutMs })
  adapter(api as never)

  return {
    notifications,
    received,
    entries,
    settingKeys: settings.keys(),
    toolSchemas: { get: (name: string) => (tools.get(name) as any)?.parameters },
    get idle() { return idle },
    set idle(value: boolean) { idle = value },
    async start() {
      const handler = events.get('session_start')
      assert.ok(handler)
      await handler({ type: 'session_start' }, createContext())
    },
    async startSession(nextSessionId: string) {
      currentSessionId = nextSessionId
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
    async tool(name: string, params: { to: string; body: string; kind?: string; reply_to?: string }) {
      const tool = tools.get(name)
      assert.ok(tool)
      return tool.execute('tool-call', params, undefined, undefined, createContext())
    },
  }
}

function message(overrides: Partial<CanonicalMessage> & { id: string; to: string }): CanonicalMessage {
  return {
    id: overrides.id,
    from: overrides.from ?? 'a4s/claude-1',
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
