import net from 'node:net'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { Check } from 'typebox/value'

import synagentPi, { createSynagentPi } from '../adapters/pi/index.ts'
import { serialize, type CanonicalMessage } from '../protocol.ts'
import {
  closeBroker,
  closeServer,
  connectClient,
  createHarness as createAdapterHarness,
  end,
  message,
  publish,
  pendingEntryMessageId,
  startBroker,
  waitFor,
} from './support/harness.ts'

const require = createRequire(import.meta.url)
const createHarness = createAdapterHarness.bind(undefined, createSynagentPi)
const mqtt = require('mqtt')

function subscribe(client: any, topic: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, (error: Error | null) => error ? reject(error) : resolve())
  })
}

// Direcciones y topics v1 fijos usados por el harness (project=a4s, instance=pi-1).
const DIRECT_TOPIC = 'synagent/v1/a4s/pi-1'
const PROJECT_TOPIC = 'synagent/v1/a4s/all'
const GLOBAL_TOPIC = 'synagent/v1/all'
const LEGACY_TOPIC = 'a4s/inbox/pi'


test('Pi adapter: v1 push bidireccional, broadcasts por defecto, orden y dedupe', async t => {
  const { broker, server, url } = await startBroker()
  const subscriber = await connectClient(url, 'pi-adapter-test-subscriber')
  const publisher = await connectClient(url, 'pi-adapter-test-publisher')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
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
  // El cliente durable suscribe directo; el transient, ambos broadcasts v1 por defecto.
  await waitFor(() =>
    harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(DIRECT_TOPIC))
    && harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(PROJECT_TOPIC))
    && harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(GLOBAL_TOPIC)),
  )
  assert.ok(!harness.notifications.some(({ message }) =>
    message.includes('subscribed to') && message.includes(LEGACY_TOPIC),
  ))

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
      { from: 'a4s/pi-1', to: 'a4s/claude-1', kind: 'task.request', body: 'hola desde pi' },
      { from: 'a4s/pi-1', to: 'a4s/bob', kind: 'task.request', body: 'mensaje directo' },
    ],
  )

  // Entrada directa: dedupe por id, filtro por identidad y rechazo de inválidos.
  const incoming = message({ id: 'incoming-1', to: 'a4s/pi-1', kind: 'task.request', body: 'hola desde claude' })
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

  // Legacy ya no está suscrito ni se entrega.
  await publish(publisher, LEGACY_TOPIC, serialize(message({ id: 'legacy-ignored', to: 'pi', body: 'via legacy' })))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 2)

  // El broadcast global está activo sin configurar un override.
  await publish(publisher, GLOBAL_TOPIC, serialize(message({ id: 'global-default', to: 'all', body: 'global' })))
  await waitFor(() => harness.received.length === 3)
  assert.match(harness.received[2]?.text ?? '', /id global-default/)
  await harness.confirmDelivery(2)
  await harness.settle()

  harness.idle = false
  // task.redirect a broadcast se rechaza; directo interrumpe el turno.
  await publish(publisher, PROJECT_TOPIC, serialize(message({
    id: 'redirect-bcast', to: 'a4s/all', kind: 'task.redirect', body: 'no',
  })))
  await waitFor(() =>
    harness.notifications.some(({ message, type }) =>
      type === 'warning' && message.includes('rejected broadcast task.redirect')),
  )
  await publish(publisher, DIRECT_TOPIC, serialize(message({
    id: 'redirect-1', to: 'a4s/pi-1', kind: 'task.redirect', body: 'corrige',
  })))
  await publish(publisher, DIRECT_TOPIC, serialize(message({
    id: 'follow-1', to: 'a4s/pi-1', kind: 'note.published', body: 'termina',
  })))
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

  // El opt-out explícito sigue disponible.
  const projectSubscriptionCount = harness.notifications.filter(({ message }) =>
    message.includes('subscribed to') && message.includes(PROJECT_TOPIC),
  ).length
  await harness.command('synagent', 'set global false')
  await waitFor(() => harness.notifications.filter(({ message }) =>
    message.includes('subscribed to') && message.includes(PROJECT_TOPIC),
  ).length > projectSubscriptionCount)
  await publish(publisher, GLOBAL_TOPIC, serialize(message({ id: 'global-off', to: 'all', body: 'global' })))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 5)
  const globalSubscriptionCount = harness.notifications.filter(({ message }) =>
    message.includes('subscribed to') && message.includes(GLOBAL_TOPIC),
  ).length
  await harness.command('synagent', 'set global true')
  await waitFor(() => harness.notifications.filter(({ message }) =>
    message.includes('subscribed to') && message.includes(GLOBAL_TOPIC),
  ).length > globalSubscriptionCount)
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
  // Dejamos new-instance activa (sin confirmar): lo siguiente queda encolado y ambos
  // mensajes deben sobrevivir a la reanudación.
  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'queued-before-shutdown', to: 'a4s/pi-2' })))
  await waitFor(() => harness.entries.some(entry =>
    pendingEntryMessageId(entry) === 'queued-before-shutdown'))

  await harness.shutdown()
  await harness.shutdown()
  await harness.settle()
  assert.equal(harness.received.length, 7)
  assert.deepEqual(
    harness.entries.filter(entry => entry.customType === 'synagent-delivered').map(entry => entry.data.id),
    ['incoming-1', 'project-1', 'global-default', 'redirect-1', 'follow-1', 'global-on'],
  )

  // La misma sesión rehidrata primero los dos pendientes persistidos y después lo
  // recibido offline; el reenvío durable de new-instance se descarta.
  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'new-instance', to: 'a4s/pi-2' })))
  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'offline', to: 'a4s/pi-2' })))
  restored = createHarness({
    'a4s.synagent.broker-url': url,
  }, harness.entries, 'pi-2')
  await restored.start()
  await waitFor(() => restored?.received.length === 1)
  assert.match(restored.received[0]?.text ?? '', /id new-instance/)
  await restored.confirmDelivery(0)
  await restored.settle()
  await waitFor(() => restored?.received.length === 2)
  assert.match(restored.received[1]?.text ?? '', /id queued-before-shutdown/)
  await restored.confirmDelivery(1)
  await restored.settle()
  await waitFor(() => restored?.received.length === 3)
  assert.match(restored.received[2]?.text ?? '', /id offline/)
  await restored.confirmDelivery(2)
  await restored.settle()
  await restored.shutdown()

  await publish(publisher, 'synagent/v1/a4s/pi-2', serialize(message({ id: 'late', to: 'a4s/pi-2' })))
  await new Promise(resolve => setTimeout(resolve, 75))
  assert.equal(harness.received.length, 7)
  assert.equal(restored.received.length, 3)
})

test('Pi adapter publishes task events with frozen assistant completion text', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-result-publisher')
  const stateRoot = mkdtempSync(join(tmpdir(), 'synagent-pi-result-'))
  const topic = 'synagent/v1/a4s/pi-result'
  const senderTopic = 'synagent/v1/a4s/claude-1'
  const events: CanonicalMessage[] = []
  publisher.on('message', (_topic: string, payload: Buffer) => {
    events.push(JSON.parse(payload.toString()) as CanonicalMessage)
  })
  await subscribe(publisher, senderTopic)
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], 'pi-result', undefined, process.cwd(), { env: { A4S_STATE_ROOT: stateRoot } })
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
    rmSync(stateRoot, { recursive: true, force: true })
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes(`subscribed to ${topic}`)))

  await publish(publisher, topic, serialize(message({ id: 'result-tools', to: 'a4s/pi-result' })))
  await waitFor(() => harness.received.length === 1)
  await harness.confirmDelivery()
  await waitFor(() => events.some(event =>
    event.kind === 'task.delivered' && event.causation_id === 'result-tools'))
  await harness.messageEnd('assistant', [
    { type: 'text', text: 'PRE_TOOL_RESULT' },
    { type: 'toolCall' },
  ])
  await harness.messageEnd('toolResult', [{ type: 'text', text: 'TOOL_ONE' }])
  await harness.messageEnd('assistant', [{ type: 'toolCall' }])
  await harness.messageEnd('toolResult', [{ type: 'text', text: 'TOOL_TWO' }])
  await harness.messageEnd('assistant', '  FINAL_RESULT  \n')
  await harness.settle()
  await waitFor(() => events.some(event =>
    event.kind === 'task.completed' && event.causation_id === 'result-tools'))

  await publish(publisher, topic, serialize(message({ id: 'result-empty', to: 'a4s/pi-result' })))
  await waitFor(() => harness.received.length === 2)
  await harness.confirmDelivery()
  await waitFor(() => events.some(event =>
    event.kind === 'task.delivered' && event.causation_id === 'result-empty'))
  await harness.messageEnd('assistant', [{ type: 'toolCall' }])
  await harness.messageEnd('assistant', [{ type: 'text', text: ' \n ' }])
  await harness.settle()
  await waitFor(() => events.some(event =>
    event.kind === 'task.completed' && event.causation_id === 'result-empty'))

  await publish(publisher, topic, serialize(message({ id: 'result-frozen', to: 'a4s/pi-result' })))
  await waitFor(() => harness.received.length === 3)
  await harness.confirmDelivery()
  await waitFor(() => events.some(event =>
    event.kind === 'task.delivered' && event.causation_id === 'result-frozen'))
  await harness.messageEnd('assistant', [
    { type: 'text', text: 'PRE_TOOL_FROZEN' },
    { type: 'toolCall' },
  ])
  await harness.messageEnd('toolResult', [{ type: 'text', text: 'TOOL_THREE' }])
  await harness.messageEnd('assistant', [{ type: 'text', text: 'FINAL_FROZEN' }])
  await harness.messageStart('separate user follow-up')
  await harness.messageEnd('assistant', [{ type: 'text', text: 'USER_AFTER_FROZEN' }])
  await harness.settle()
  await waitFor(() => events.some(event =>
    event.kind === 'task.completed' && event.causation_id === 'result-frozen'))
  await harness.shutdown()

  const settled = readFileSync(findOperationalLog(stateRoot), 'utf8')
    .trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(record => record.event_name === 'synagent.pi.delivery.settled')
  assert.deepEqual(settled.map(record => record['a4s.delivery.text']), [
    '  FINAL_RESULT  \n',
    undefined,
    'FINAL_FROZEN',
  ])
  assert.deepEqual(events.map(({ kind, body, correlation_id, causation_id }) => ({
    kind, body, correlation_id, causation_id,
  })), [
    {
      kind: 'task.delivered', body: '', correlation_id: 'result-tools', causation_id: 'result-tools',
    },
    {
      kind: 'task.completed',
      body: '  FINAL_RESULT  \n',
      correlation_id: 'result-tools',
      causation_id: 'result-tools',
    },
    {
      kind: 'task.delivered', body: '', correlation_id: 'result-empty', causation_id: 'result-empty',
    },
    {
      kind: 'task.completed', body: '', correlation_id: 'result-empty', causation_id: 'result-empty',
    },
    {
      kind: 'task.delivered', body: '', correlation_id: 'result-frozen', causation_id: 'result-frozen',
    },
    {
      kind: 'task.completed',
      body: 'FINAL_FROZEN',
      correlation_id: 'result-frozen',
      causation_id: 'result-frozen',
    },
  ])
})

test('Pi adapter mutual task requests terminate after delivered and completed events', async t => {
  const { broker, server, url } = await startBroker()
  const observer = await connectClient(url, 'pi-mutual-observer')
  const messages: CanonicalMessage[] = []
  observer.on('message', (_topic: string, payload: Buffer) => {
    messages.push(JSON.parse(payload.toString()) as CanonicalMessage)
  })
  await subscribe(observer, 'synagent/#')
  const a = createHarness({ 'a4s.synagent.broker-url': url }, [], 'mutual-a')
  const b = createHarness({ 'a4s.synagent.broker-url': url }, [], 'mutual-b')
  t.after(async () => {
    await a.shutdown()
    await b.shutdown()
    await end(observer)
    await closeServer(server)
    await closeBroker(broker)
  })

  await Promise.all([a.start(), b.start()])
  await waitFor(() =>
    a.notifications.some(({ message }) => message.includes('synagent/v1/a4s/mutual-a'))
    && b.notifications.some(({ message }) => message.includes('synagent/v1/a4s/mutual-b')))

  const [sentA, sentB] = await Promise.all([
    a.tool('synagent_send', { to: 'a4s/mutual-b', body: 'task from A' }),
    b.tool('synagent_send', { to: 'a4s/mutual-a', body: 'task from B' }),
  ])
  assert.notEqual(sentA.isError, true)
  assert.notEqual(sentB.isError, true)
  await waitFor(() => a.received.length === 1 && b.received.length === 1)

  await Promise.all([a.confirmDelivery(), b.confirmDelivery()])
  await Promise.all([
    a.messageEnd('assistant', 'completed by A'),
    b.messageEnd('assistant', 'completed by B'),
  ])
  await Promise.all([a.settle(), b.settle()])
  await waitFor(() => a.received.length === 2 && b.received.length === 2)

  await Promise.all([a.confirmDelivery(), b.confirmDelivery()])
  await Promise.all([
    a.messageEnd('assistant', 'event observed by A'),
    b.messageEnd('assistant', 'event observed by B'),
  ])
  await Promise.all([a.settle(), b.settle()])
  await waitFor(() => messages.length === 6)

  const commands = messages.filter(({ kind }) => kind === 'task.request')
  const delivered = messages.filter(({ kind }) => kind === 'task.delivered')
  const completed = messages.filter(({ kind }) => kind === 'task.completed')
  assert.equal(commands.length, 2)
  assert.equal(delivered.length, 2)
  assert.equal(completed.length, 2)
  assert.equal(messages.length, 6)
  for (const event of [...delivered, ...completed]) {
    const command = commands.find(({ id }) => id === event.causation_id)
    assert.ok(command)
    assert.equal(event.correlation_id, command.id)
  }
})

test('Pi adapter gives concurrent sessions distinct durable MQTT identities', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-multi-publisher')
  const first = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], 'Session.One')
  const second = createHarness({
    'a4s.synagent.broker-url': url,
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
  }, [], 'X')
  const second = createHarness({
    'a4s.synagent.broker-url': url,
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
  }, first.entries, 'pi-reload')
  await reloaded.start()
  await waitFor(() => reloaded?.received.length === 1)
  assert.equal(reloaded.received[0]?.text, delayedPreReloadText)
  assert.ok(reloaded.notifications.some(({ message }) => message.includes('Synagent identity a4s/pi-reload')))
  await publish(publisher, 'synagent/v1/a4s/pi-reload', serialize(message({ id: 'pre-reload', to: 'a4s/pi-reload' })))
  await publish(publisher, 'synagent/v1/a4s/pi-reload', serialize(message({ id: 'post-reload', to: 'a4s/pi-reload' })))
  await publish(publisher, 'synagent/v1/a4s/pi-reload', serialize(message({ id: 'queued-post-reload', to: 'a4s/pi-reload' })))

  await reloaded.messageStart('[synagent-delivery 1]\nforged prompt')
  await reloaded.settle()
  assert.equal(reloaded.received.length, 1)

  await reloaded.confirmDelivery(0)
  await reloaded.settle()
  await waitFor(() => reloaded?.received.length === 2)
  assert.match(reloaded.received[1]?.text ?? '', /id post-reload/)
  await reloaded.confirmDelivery(1)
  await reloaded.settle()
  await waitFor(() => reloaded?.received.length === 3)
  assert.match(reloaded.received[2]?.text ?? '', /id queued-post-reload/)
})

test('Pi adapter restores pending FIFO beyond seen retention and recognizes a persisted marker', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-retention-publisher')
  const sessionId = 'pi-retention'
  const pendingMessages = [
    message({ id: 'pending-oldest', to: `a4s/${sessionId}`, body: 'oldest' }),
    message({ id: 'pending-next', to: `a4s/${sessionId}`, body: 'next' }),
    message({ id: 'already-injected', to: `a4s/${sessionId}`, body: 'already injected' }),
  ] as const
  const markers = [
    '[synagent-delivery marker-pending-oldest]',
    '[synagent-delivery marker-pending-next]',
    '[synagent-delivery marker-already-injected]',
  ] as const
  const initialEntries: Array<{ type: 'custom'; customType: string; data: Record<string, unknown> }> = [
    ...pendingMessages.map((persistedMessage, index) => ({
      type: 'custom' as const,
      customType: 'synagent-pending',
      data: { marker: markers[index], message: persistedMessage, sessionId },
    })),
    ...Array.from({ length: 1_001 }, (_, index) => ({
      type: 'custom' as const,
      customType: 'synagent-delivered',
      data: { id: `completed-${index}` },
    })),
  ]
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, initialEntries, sessionId)
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  harness.appendBranchUserMessage(`${markers[2]}\npreviously injected`)
  await harness.start()
  await waitFor(() => harness.received.length === 1)
  assert.equal(harness.received[0]?.text.startsWith(`${markers[0]}\n`), true)
  await harness.confirmDelivery(0)
  await harness.settle()
  await waitFor(() => harness.received.length === 2)
  assert.equal(harness.received[1]?.text.startsWith(`${markers[1]}\n`), true)
  await harness.confirmDelivery(1)
  await harness.settle()

  const topic = `synagent/v1/a4s/${sessionId}`
  await waitFor(() => harness.notifications.some(({ message }) => message.includes(`subscribed to ${topic}`)))
  await publish(publisher, topic, serialize(pendingMessages[1]))
  await publish(publisher, topic, serialize(pendingMessages[2]))
  await publish(publisher, topic, serialize(message({ id: 'retention-sentinel', to: `a4s/${sessionId}` })))
  await waitFor(() => harness.received.length === 3)
  assert.match(harness.received[2]?.text ?? '', /id retention-sentinel/)
})

test('Pi adapter retries persistence and dispatch failures without reinjecting a confirmed marker', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-persistence-publisher')
  const settings = { 'a4s.synagent.broker-url': url }
  const sessionId = 'pi-persistence'
  const topic = `synagent/v1/a4s/${sessionId}`
  const first = createHarness(settings, [], sessionId)
  let recovered: typeof first | undefined
  let dispatchRecovered: typeof first | undefined
  t.after(async () => {
    await first.shutdown()
    await recovered?.shutdown()
    await dispatchRecovered?.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  first.failAppend('synagent-pending')
  await first.start()
  await waitFor(() => first.notifications.some(({ message }) => message.includes(`subscribed to ${topic}`)))
  const persistedRetry = message({ id: 'persist-retry', to: `a4s/${sessionId}` })
  await publish(publisher, topic, serialize(persistedRetry))
  await waitFor(() => first.notifications.some(({ message }) =>
    message.includes('pending delivery could not be persisted')))
  assert.equal(first.received.length, 0)

  first.failAppend('synagent-pending', false)
  await publish(publisher, topic, serialize(persistedRetry))
  await waitFor(() => first.received.length === 1)
  const confirmedText = first.received[0]?.text
  assert.ok(confirmedText)
  first.appendBranchUserMessage(confirmedText)
  first.failAppend('synagent-delivered')
  await first.confirmDelivery(0)
  await first.settle()
  await first.shutdown()

  recovered = createHarness(settings, first.entries, sessionId)
  recovered.appendBranchUserMessage(confirmedText)
  await recovered.start()
  await waitFor(() => recovered?.notifications.some(({ message }) => message.includes(`subscribed to ${topic}`)) ?? false)
  await publish(publisher, topic, serialize(persistedRetry))
  const recoveredSentinel = message({ id: 'recovered-sentinel', to: `a4s/${sessionId}` })
  await publish(publisher, topic, serialize(recoveredSentinel))
  await waitFor(() => recovered?.received.length === 1)
  assert.match(recovered.received[0]?.text ?? '', /id recovered-sentinel/)
  await recovered.confirmDelivery(0)
  await recovered.settle()

  recovered.failDelivery = true
  const dispatchRetry = message({ id: 'dispatch-retry', to: `a4s/${sessionId}` })
  await publish(publisher, topic, serialize(dispatchRetry))
  await waitFor(() => recovered?.notifications.some(({ message }) => message.includes('delivery failed')) ?? false)
  recovered.failDelivery = false
  await recovered.shutdown()

  dispatchRecovered = createHarness({
    ...settings,
    'a4s.synagent.enabled': false,
  }, recovered.entries, sessionId)
  dispatchRecovered.appendBranchUserMessage(confirmedText)
  await dispatchRecovered.start()
  assert.equal(dispatchRecovered.received.length, 0)
  await dispatchRecovered.command('synagent', 'enable')
  await waitFor(() => dispatchRecovered?.received.length === 1)
  assert.match(dispatchRecovered.received[0]?.text ?? '', /id dispatch-retry/)
})



test('Pi adapter preserves FIFO across a late start and supports explicit recovery', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-timeout-publisher')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
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
    id: 'busy-without-settle', to: 'a4s/pi-timeout', kind: 'task.redirect',
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
  await waitFor(() => harness.received.length === 1)
  assert.match(harness.received[0]?.text ?? '', /id active-before/)
  await publish(publisher, before, serialize(message({ id: 'queued-before', to: 'a4s/pi-before' })))
  await publish(publisher, PROJECT_TOPIC, serialize(message({ id: 'project-before', to: 'a4s/all' })))
  await waitFor(() => ['queued-before', 'project-before'].every(id =>
    harness.entries.some(entry => pendingEntryMessageId(entry) === id)))
  assert.equal(harness.received.length, 1)

  await harness.startSession('pi-after')
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(after)))
  assert.ok(harness.notifications.some(({ message }) => message.includes('Synagent identity a4s/pi-after')))
  await publish(publisher, after, serialize(message({ id: 'current-after', to: 'a4s/pi-after' })))
  await waitFor(() => harness.received.length === 2)
  assert.match(harness.received[1]?.text ?? '', /id current-after/)
  assert.ok(harness.received.every(({ text }) =>
    !text.includes('id queued-before') && !text.includes('id project-before')))
  await harness.confirmDelivery(1)
  await harness.settle()
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
  assert.equal(Check(toolSchema, {
    to: 'Repo.Name/Peer.Agent', body: 'valid', kind: 'task.request',
  }), true)
  assert.equal(Check(toolSchema, {
    to: 'Repo.Name/Peer.Agent', body: 'invalid', kind: 'task.completed',
  }), false)
  assert.equal(Check(toolSchema, { to: 'Repo.Name/Peer.Agent', body: 'invalid', kind: 'bogus' }), false)

  const invalid = await harness.tool('synagent_send', { to: 'not/an/address/at/all', body: 'invalid' })
  assert.equal(invalid.isError, true)
  const sent = await harness.tool('synagent_send', {
    to: 'Repo.Name/Peer.Agent',
    body: 'intent message',
    kind: 'task.request',
    reply_to: 'request-1',
    correlation_id: 'root-1',
    causation_id: 'cause-1',
  })
  assert.notEqual(sent.isError, true)
  assert.match(sent.content[0]?.text ?? '', /^Synagent message sent:/)
  await waitFor(() => outbound.length === 1)
  const firstOutbound = outbound[0]
  assert.ok(firstOutbound)
  const { from, to, kind, body, reply_to, correlation_id, causation_id } = firstOutbound
  assert.deepEqual(
    { from, to, kind, body, reply_to, correlation_id, causation_id },
    {
      from: 'Repo.Name/Native.Session-A',
      to: 'Repo.Name/Peer.Agent',
      kind: 'task.request',
      body: 'intent message',
      reply_to: 'request-1',
      correlation_id: 'root-1',
      causation_id: 'cause-1',
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

test('Pi adapter unresolved project stays inactive and refuses all v1 send intent', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-adapter-legacy-publisher')
  const observer = await connectClient(url, 'pi-adapter-legacy-observer')
  const cwd = mkdtempSync(join(tmpdir(), 'synagent-pi-no-origin-'))
  const stateRoot = mkdtempSync(join(tmpdir(), 'synagent-pi-no-identity-log-'))
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.default-peer': 'Some.Project/Peer.One',
  }, [], 'Legacy.Session', undefined, cwd, { env: { A4S_STATE_ROOT: stateRoot } })
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await end(observer)
    await closeServer(server)
    await closeBroker(broker)
    rmSync(cwd, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  const publishedV1: string[] = []
  observer.on('message', (topic: string) => publishedV1.push(topic))
  await subscribe(observer, 'synagent/v1/#')
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message, type }) =>
    type === 'warning' && message.includes('identity unresolved') && message.includes('inactive'),
  ))
  assert.ok(!harness.notifications.some(({ message }) =>
    message.includes('subscribed to') && message.includes(LEGACY_TOPIC),
  ))

  const toolResult = await harness.tool('synagent_send', { to: 'Some.Project/Peer.One', body: 'must not publish' })
  assert.equal(toolResult.isError, true)
  assert.match(toolResult.content[0]?.text ?? '', /configure remote.origin.url/)
  await harness.command('synagent', 'status')
  assert.ok(harness.notifications.some(({ message }) =>
    message.includes('inactive=true') && message.includes('remote.origin.url'),
  ))
  await harness.command('mq-send', 'must not publish either')
  assert.ok(harness.notifications.some(({ message }) => message.includes('configure remote.origin.url')))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(publishedV1, [])

  await publish(publisher, LEGACY_TOPIC, serialize(message({ id: 'legacy-ignored', to: 'pi' })))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.received.length, 0)
  await harness.shutdown()
  const records = readFileSync(findOperationalLog(stateRoot), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const identityFailure = records.find(record => record.event_name === 'synagent.pi.identity.failed')
  assert.ok(identityFailure)
  assert.equal(identityFailure['error.code'], 'IDENTITY_UNRESOLVED')
  assert.equal(identityFailure['error.phase'], 'identity.resolve')
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

test('Pi adapter records focused RCA events without message or transport data', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-logging-publisher')
  const stateRoot = mkdtempSync(join(tmpdir(), 'synagent-pi-logging-'))
  const cwd = mkdtempSync(join(tmpdir(), 'synagent-pi-sensitive-origin-'))
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Example/Sensitive.Project.git'], { cwd })
  const sessionId = 'Raw.Session.Logging'
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], sessionId, 20, cwd, { env: { A4S_STATE_ROOT: stateRoot } })
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
    rmSync(stateRoot, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const topic = 'synagent/v1/Sensitive.Project/Raw.Session.Logging'
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(topic)))

  const sent = await harness.tool('synagent_send', {
    to: 'Sensitive.Project/Peer.Private',
    body: 'outbound prompt body private',
    kind: 'note.published',
  })
  assert.notEqual(sent.isError, true)
  const invalidSend = await harness.tool('synagent_send', {
    to: 'Sensitive.Project/not/valid',
    body: 'rejected body private',
  })
  assert.equal(invalidSend.isError, true)

  const first = message({
    id: 'raw-incoming-secret-one',
    to: 'Sensitive.Project/Raw.Session.Logging',
    body: 'incoming transcript private',
  })
  await publish(publisher, topic, serialize(first))
  await publish(publisher, topic, serialize(first))
  await publish(publisher, topic, '{"payload":"invalid-private"')
  await waitFor(() => harness.received.length === 1)
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('raw-incoming-secret-one')))
  await harness.command('synagent', 'resume')

  await publish(publisher, topic, serialize(message({
    id: 'raw-incoming-secret-two',
    to: 'Sensitive.Project/Raw.Session.Logging',
    body: 'second response private',
  })))
  await waitFor(() => harness.received.length === 2)
  await harness.confirmDelivery(1)
  await harness.settle()

  harness.failDelivery = true
  await publish(publisher, topic, serialize(message({
    id: 'raw-incoming-secret-three',
    to: 'Sensitive.Project/Raw.Session.Logging',
    body: 'third body private',
  })))
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('delivery failed')))
  harness.failDelivery = false
  await harness.shutdown()

  const logText = readFileSync(findOperationalLog(stateRoot), 'utf8')
  const records = logText.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const events = new Set(records.map(record => record.event_name))
  for (const event of [
    'synagent.pi.started',
    'synagent.pi.shutdown',
    'synagent.pi.identity.resolved',
    'synagent.pi.mqtt.connected',
    'synagent.pi.message.sent',
    'synagent.pi.message.received',
    'synagent.pi.message.rejected',
    'synagent.pi.message.duplicate',
    'synagent.pi.delivery.dispatched',
    'synagent.pi.delivery.confirmed',
    'synagent.pi.delivery.settled',
    'synagent.pi.delivery.timeout',
    'synagent.pi.delivery.resumed',
    'synagent.pi.delivery.failed',
  ]) assert.ok(events.has(event), `missing ${event}`)

  assert.ok(records.some(record => record['messaging.message.id_hash'] === undefined))
  assert.ok(records.some(record => typeof record['messaging.message.id_hash'] === 'string'))
  assert.ok(records.every(record => record.schema === 'a4s.log/1'))
  assert.ok(records.every(record => record['resource.a4s.harness.name'] === 'pion'))
  assert.ok(records.some(record => record['a4s.client.role'] === 'durable'))
  assert.ok(records.some(record => record['a4s.delivery.mode'] === 'idle'))
  assert.ok(records.some(record => record['a4s.timeout.ms'] === 20))
  assert.ok(records.some(record => typeof record['a4s.queue.depth'] === 'number'))
  assert.ok(records.some(record => typeof record['a4s.connection.generation'] === 'number'))

  for (const forbidden of [
    sessionId,
    url,
    topic,
    'a4s-pi-',
    'Sensitive.Project',
    'Peer.Private',
    'raw-incoming-secret-one',
    'raw-incoming-secret-two',
    'raw-incoming-secret-three',
    'outbound prompt body private',
    'rejected body private',
    'incoming transcript private',
    'second response private',
    'third body private',
    'invalid-private',
  ]) assert.equal(logText.includes(forbidden), false, `log contains forbidden data: ${forbidden}`)
})

test('Pi adapter contains logger failure after publish, delivery and settlement', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-best-effort-publisher')
  const stateRoot = mkdtempSync(join(tmpdir(), 'synagent-pi-best-effort-'))
  let loggerFails = false
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], 'best-effort-session', 100, process.cwd(), {
    env: { A4S_STATE_ROOT: stateRoot },
    now: () => {
      if (loggerFails) throw new Error('simulated clock failure')
      return new Date()
    },
  })
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
    rmSync(stateRoot, { recursive: true, force: true })
  })

  const topic = 'synagent/v1/a4s/best-effort-session'
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(topic)))
  loggerFails = true

  const sent = await harness.tool('synagent_send', { to: 'a4s/peer', body: 'private outbound' })
  assert.notEqual(sent.isError, true)

  const first = message({ id: 'best-effort-one', to: 'a4s/best-effort-session' })
  await publish(publisher, topic, serialize(first))
  await publish(publisher, topic, serialize(first))
  await publish(publisher, topic, serialize(message({ id: 'best-effort-two', to: 'a4s/best-effort-session' })))
  await waitFor(() => harness.received.length === 1)
  assert.equal(harness.entries.filter(entry => pendingEntryMessageId(entry) === 'best-effort-one').length, 1)
  await harness.confirmDelivery(0)
  await harness.settle()
  await waitFor(() => harness.received.length === 2)
  assert.match(harness.received[1]?.text ?? '', /id best-effort-two/)
  await harness.confirmDelivery(1)
  await harness.settle()
})

test('Pi adapter preserves shutdown rejection after logging and close', async t => {
  const { broker, server, url } = await startBroker()
  const stateRoot = mkdtempSync(join(tmpdir(), 'synagent-pi-shutdown-reject-'))
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], 'shutdown-reject-session', undefined, process.cwd(), { env: { A4S_STATE_ROOT: stateRoot } })
  t.after(async () => {
    await harness.shutdown()
    await closeServer(server)
    await closeBroker(broker)
    rmSync(stateRoot, { recursive: true, force: true })
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to')))
  const prototype = mqtt.MqttClient.prototype
  const originalRemoveAllListeners = prototype.removeAllListeners
  prototype.removeAllListeners = function removeAllListenersFailure() {
    const client = this as any
    if (client.options?.clean !== false) return originalRemoveAllListeners.call(this)
    client.options.reconnectPeriod = 0
    client.reconnecting = false
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer)
    client.reconnectTimer = undefined
    originalRemoveAllListeners.call(this)
    client.stream?.destroy?.()
    client.end(true)
    throw new Error('simulated stop rejection')
  }
  try {
    await assert.rejects(harness.shutdown(), /simulated stop rejection/)
  } finally {
    prototype.removeAllListeners = originalRemoveAllListeners
  }

  const records = readFileSync(findOperationalLog(stateRoot), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const shutdown = records.find(record =>
    record.event_name === 'synagent.pi.shutdown' && record['error.code'] === 'SHUTDOWN_FAILED',
  )
  assert.ok(shutdown)
})

test('Pi adapter records MQTT connection failure with stable taxonomy', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'synagent-pi-mqtt-failure-'))
  const port = await unusedPort()
  const harness = createHarness({
    'a4s.synagent.broker-url': `mqtt://127.0.0.1:${port}`,
  }, [], 'mqtt-failure-session', undefined, process.cwd(), { env: { A4S_STATE_ROOT: stateRoot } })
  t.after(async () => {
    await harness.shutdown()
    rmSync(stateRoot, { recursive: true, force: true })
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('connection error')))
  await harness.shutdown()
  const records = readFileSync(findOperationalLog(stateRoot), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const failure = records.find(record => record.event_name === 'synagent.pi.mqtt.failed')
  assert.ok(failure)
  assert.equal(failure['error.phase'], 'mqtt.connect')
  assert.equal(failure['error.retryable'], true)
  assert.equal(failure['a4s.client.role'], 'durable')
  assert.equal(JSON.stringify(failure).includes(`127.0.0.1:${port}`), false)
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

test('Pi adapter settings persist at user scope', async t => {
  const { broker, server, url } = await startBroker()
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], 'native-settings')
  t.after(async () => {
    await harness.shutdown()
    await closeServer(server)
    await closeBroker(broker)
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to')))
  const initialStarts = harness.notifications.filter(({ message }) => message.includes('Synagent identity')).length

  harness.queueSelections('Global broadcast: true', 'false', 'Default peer: claude', 'Cancel')
  harness.queueInputs('a4s/New.Peer')
  await harness.command('synagent-settings', '')
  assert.ok(harness.selectionOptions.some(options =>
    options.includes('Global broadcast: true') && options.includes('Default peer: claude'),
  ))
  await waitFor(() => harness.notifications.filter(({ message }) => message.includes('Synagent identity')).length > initialStarts)
  const afterGlobalEdit = harness.notifications.filter(({ message }) => message.includes('Synagent identity')).length
  assert.equal(afterGlobalEdit, initialStarts + 1)
  assert.deepEqual(JSON.parse(readFileSync(harness.globalSettingsPath, 'utf8')), {
    'broker-url': url,
    global: false,
    'default-peer': 'a4s/New.Peer',
  })

  harness.queueSelections('Reset a setting', 'default-peer', 'Cancel')
  harness.queueConfirmations(true)
  await harness.command('synagent-settings', '')
  assert.equal(JSON.parse(readFileSync(harness.globalSettingsPath, 'utf8'))['default-peer'], undefined)
})

test('Pi adapter does not restart MQTT for default-peer and keeps /synagent set compatibility', async t => {
  const { broker, server, url } = await startBroker()
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
  }, [], 'set-compatibility')
  t.after(async () => {
    await harness.shutdown()
    await closeServer(server)
    await closeBroker(broker)
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to')))
  const starts = harness.notifications.filter(({ message }) => message.includes('Synagent identity')).length
  await harness.command('synagent', 'set default-peer a4s/Automation.Peer')
  assert.equal(harness.notifications.filter(({ message }) => message.includes('Synagent identity')).length, starts)
  assert.equal(JSON.parse(readFileSync(harness.globalSettingsPath, 'utf8'))['default-peer'], 'a4s/Automation.Peer')
})

test('Pi adapter rejects remote broker edits and keeps state after a write failure', async () => {
  const harness = createHarness({
    'a4s.synagent.enabled': false,
    'a4s.synagent.default-peer': 'Original.Peer',
  })
  await harness.start()
  await harness.command('synagent', 'set broker-url mqtt://broker.example.com:1883')
  assert.ok(harness.notifications.some(({ message, type }) =>
    type === 'error' && message.includes('loopback'),
  ))

  const errorCount = harness.notifications.filter(({ type }) => type === 'error').length
  rmSync(harness.agentDir, { recursive: true, force: true })
  writeFileSync(harness.agentDir, 'blocks directory creation')
  await harness.command('synagent', 'set default-peer Changed.Peer')
  await harness.command('synagent', 'status')
  assert.equal(harness.notifications.filter(({ type }) => type === 'error').length, errorCount + 1)
  assert.ok(harness.notifications.some(({ message }) => message.includes('peer=Original.Peer')))
  await harness.shutdown()
})

test('Pi adapter expires and cancels queued requests without rehydrating them', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'pi-deadline-publisher')
  const events: CanonicalMessage[] = []
  publisher.on('message', (_topic, payload) => events.push(JSON.parse(payload.toString()) as CanonicalMessage))
  await subscribe(publisher, 'synagent/v1/a4s/sender')
  const settings = { 'a4s.synagent.broker-url': url }
  const sessionId = 'pi-deadlines'
  const topic = `synagent/v1/a4s/${sessionId}`
  const harness = createHarness(settings, [], sessionId)
  let restored: typeof harness | undefined
  t.after(async () => {
    await restored?.shutdown()
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  harness.idle = false
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes(`subscribed to ${topic}`)))
  await publish(publisher, topic, serialize(message({
    id: 'expired-before-injection',
    from: 'a4s/sender',
    to: `a4s/${sessionId}`,
    deadline: Date.now() - 1,
  })))
  await waitFor(() => events.some(event =>
    event.kind === 'task.expired' && event.reply_to === 'expired-before-injection'))
  const expired = events.find(event => event.kind === 'task.expired')
  assert.ok(expired)
  assert.equal(expired.to, 'a4s/sender')
  assert.equal(expired.causation_id, 'expired-before-injection')
  assert.equal(harness.received.length, 0)

  await publish(publisher, topic, serialize(message({
    id: 'cancel-before-injection',
    from: 'a4s/sender',
    to: `a4s/${sessionId}`,
    deadline: Date.now() + 600_000,
  })))
  await waitFor(() => harness.entries.some(entry =>
    pendingEntryMessageId(entry) === 'cancel-before-injection'))
  await publish(publisher, topic, serialize(message({
    id: 'cancel-command',
    from: 'a4s/sender',
    to: `a4s/${sessionId}`,
    kind: 'task.cancel',
    reply_to: 'cancel-before-injection',
  })))
  await waitFor(() => harness.entries.some(entry =>
    entry.customType === 'synagent-delivered' && entry.data.id === 'cancel-before-injection'))
  harness.idle = true
  await harness.settle()
  assert.equal(harness.received.length, 0)

  await harness.shutdown()
  restored = createHarness(settings, harness.entries, sessionId)
  await restored.start()
  await waitFor(() => restored?.notifications.some(({ message }) => message.includes(`subscribed to ${topic}`)) ?? false)
  assert.equal(restored.received.length, 0)
})

test('Pi adapter derives deadlines from request-ttl and persists every request status', async t => {
  const { broker, server, url } = await startBroker()
  const peer = await connectClient(url, 'pi-request-registry-peer')
  const outbound: CanonicalMessage[] = []
  peer.on('message', (_topic, payload) => outbound.push(JSON.parse(payload.toString()) as CanonicalMessage))
  await subscribe(peer, 'synagent/v1/a4s/peer')
  const harness = createHarness({
    'a4s.synagent.broker-url': url,
    'a4s.synagent.request-ttl': 5,
  }, [], 'pi-registry')
  t.after(async () => {
    await harness.shutdown()
    await end(peer)
    await closeServer(server)
    await closeBroker(broker)
  })

  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to')))
  assert.doesNotMatch(JSON.stringify(harness.toolSchemas.get('synagent_send')), /deadline/)

  await harness.tool('synagent_send', { to: 'a4s/peer', body: 'complete me' })
  await harness.tool('synagent_send', { to: 'a4s/peer', body: 'expire me' })
  await harness.tool('synagent_send', { to: 'a4s/peer', body: 'cancel me' })
  await harness.tool('synagent_send', { to: 'a4s/peer', body: 'leave pending' })
  await waitFor(() => outbound.filter(({ kind }) => kind === 'task.request').length === 4)
  const requests = outbound.filter(({ kind }) => kind === 'task.request')
  for (const request of requests) assert.equal(request.deadline, request.ts + 5000)
  const [completedRequest, expiredRequest, cancelledRequest, pendingRequest] = requests
  assert.ok(completedRequest && expiredRequest && cancelledRequest && pendingRequest)

  await publish(peer, 'synagent/v1/a4s/pi-registry', serialize(message({
    id: 'completed-event',
    from: 'a4s/peer',
    to: 'a4s/pi-registry',
    kind: 'task.completed',
    reply_to: completedRequest.id,
    correlation_id: completedRequest.id,
    causation_id: completedRequest.id,
  })))
  await publish(peer, 'synagent/v1/a4s/pi-registry', serialize(message({
    id: 'expired-event',
    from: 'a4s/peer',
    to: 'a4s/pi-registry',
    kind: 'task.expired',
    reply_to: expiredRequest.id,
    correlation_id: expiredRequest.id,
    causation_id: expiredRequest.id,
  })))
  await waitFor(() => harness.entries.some(entry =>
    entry.customType === 'synagent-request'
    && entry.data.id === expiredRequest.id
    && entry.data.status === 'expired'))
  await harness.command('synagent', `cancel ${cancelledRequest.id}`)
  await waitFor(() => outbound.some(event =>
    event.kind === 'task.cancel' && event.reply_to === cancelledRequest.id))
  await harness.command('synagent', 'pending')
  const listing = harness.notifications.at(-1)?.message ?? ''
  assert.match(listing, new RegExp(`${completedRequest.id} estado=completo`))
  assert.match(listing, new RegExp(`${expiredRequest.id} estado=vencido`))
  assert.match(listing, new RegExp(`${cancelledRequest.id} estado=cancelado`))
  assert.match(listing, new RegExp(`${pendingRequest.id} estado=pendiente`))
})

function findOperationalLog(stateRoot: string): string {
  const harnessRoot = join(stateRoot, 'log', 'synagent', 'pi')
  const instances = readdirSync(harnessRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
  assert.equal(instances.length, 1)
  return join(harnessRoot, instances[0]!.name, 'operational.jsonl')
}

async function unusedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

