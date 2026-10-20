import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MqttClient } from 'mqtt'

import { createSynagentPi } from '../adapters/pi/index.ts'
import { serialize, type CanonicalMessage } from '../protocol.ts'
import {
  closeBroker,
  closeServer,
  connectClient,
  createHarness,
  end,
  message,
  publish,
  startBroker,
  waitFor,
} from './support/harness.ts'

async function subscribe(client: MqttClient, topic: string): Promise<void> {
  await client.subscribeAsync(topic, { qos: 1 })
}

test('offer arbitration assigns the first claim once, closes later claims, and survives restore', async t => {
  const { broker, server, url } = await startBroker()
  const observer = await connectClient(url, 'offer-arbitration-observer')
  const publisher = await connectClient(url, 'offer-arbitration-publisher')
  const observed: CanonicalMessage[] = []
  observer.on('message', (_topic: string, payload: Buffer) => {
    observed.push(JSON.parse(payload.toString()) as CanonicalMessage)
  })
  await subscribe(observer, 'synagent/v2/#')

  const offerer = createHarness(createSynagentPi, {
    'a4s.synagent.broker-url': url,
  }, [], 'offerer')
  let restored: ReturnType<typeof createHarness> | undefined
  t.after(async () => {
    await restored?.shutdown()
    await offerer.shutdown()
    await end(observer)
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  await offerer.start()
  await waitFor(() => offerer.notifications.some(({ message: text }) => text.includes('subscribed to')))
  await offerer.command('synagent', 'offer deterministic offered work')
  await waitFor(() => observed.some(event => event.kind === 'task.offer'))
  const offer = observed.find(event => event.kind === 'task.offer')
  assert.ok(offer)
  assert.equal(offer.to, 'a4s/all')

  const firstClaim = message({
    id: 'claim-first',
    from: 'a4s/claimant-first',
    to: 'a4s/offerer',
    kind: 'task.claim',
    body: 'first',
    reply_to: offer.id,
    correlation_id: offer.id,
    causation_id: offer.id,
  })
  const laterClaim = message({
    id: 'claim-later',
    from: 'a4s/claimant-later',
    to: 'a4s/offerer',
    kind: 'task.claim',
    body: 'later',
    reply_to: offer.id,
    correlation_id: offer.id,
    causation_id: offer.id,
  })
  await publish(publisher, 'synagent/v2/a4s/offerer', serialize(firstClaim))
  await publish(publisher, 'synagent/v2/a4s/offerer', serialize(laterClaim))
  await publish(publisher, 'synagent/v2/a4s/offerer', serialize(firstClaim))
  await waitFor(() => observed.filter(event =>
    event.correlation_id === offer.id
    && (event.kind === 'task.request' || event.kind === 'task.offer.closed')).length === 2)

  const related = observed.filter(event =>
    event.correlation_id === offer.id
    && (event.kind === 'task.request' || event.kind === 'task.offer.closed'))
  const assignment = related.find(event => event.kind === 'task.request')
  const closed = related.find(event => event.kind === 'task.offer.closed')
  assert.ok(assignment)
  assert.ok(closed)
  assert.equal(assignment.to, firstClaim.from)
  assert.equal(assignment.body, offer.body)
  assert.equal(assignment.reply_to, offer.id)
  assert.equal(assignment.causation_id, firstClaim.id)
  assert.equal(closed.to, laterClaim.from)
  assert.equal(closed.reply_to, laterClaim.id)
  assert.equal(closed.body, `Oferta ya asignada: ${offer.id}`)

  const restoredEntries = offerer.entries.map(entry => ({
    type: entry.type,
    customType: entry.customType,
    data: { ...entry.data },
  }))
  await offerer.shutdown()
  restored = createHarness(createSynagentPi, {
    'a4s.synagent.broker-url': url,
  }, restoredEntries, 'offerer')
  await restored.start()
  await waitFor(() => restored?.notifications.some(({ message: text }) => text.includes('subscribed to')) ?? false)

  const afterRestore = observed.length
  const restoredClaim = message({
    id: 'claim-after-restore',
    from: 'a4s/claimant-restored',
    to: 'a4s/offerer',
    kind: 'task.claim',
    body: 'restored',
    reply_to: offer.id,
    correlation_id: offer.id,
    causation_id: offer.id,
  })
  await publish(publisher, 'synagent/v2/a4s/offerer', serialize(restoredClaim))
  await waitFor(() => observed.slice(afterRestore).some(event =>
    event.kind === 'task.offer.closed' && event.reply_to === restoredClaim.id))
  assert.equal(observed.filter(event =>
    event.kind === 'task.request' && event.correlation_id === offer.id).length, 1)
  assert.equal(observed.filter(event =>
    event.kind === 'task.offer.closed' && event.correlation_id === offer.id).length, 2)
  assert.ok(offerer.entries.some(entry => entry.customType === 'synagent-offer'))
})

test('only idle sessions with accept-offers enabled claim an offer without opening a turn', async t => {
  const { broker, server, url } = await startBroker()
  const observer = await connectClient(url, 'offer-acceptance-observer')
  const publisher = await connectClient(url, 'offer-acceptance-publisher')
  const observed: CanonicalMessage[] = []
  observer.on('message', (_topic: string, payload: Buffer) => {
    observed.push(JSON.parse(payload.toString()) as CanonicalMessage)
  })
  await subscribe(observer, 'synagent/v2/#')

  const enabled = createHarness(createSynagentPi, {
    'a4s.synagent.broker-url': url,
    'a4s.synagent.accept-offers': true,
  }, [], 'accepting')
  const disabled = createHarness(createSynagentPi, {
    'a4s.synagent.broker-url': url,
  }, [], 'disabled')
  t.after(async () => {
    await enabled.shutdown()
    await disabled.shutdown()
    await end(observer)
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  await Promise.all([enabled.start(), disabled.start()])
  await waitFor(() => [enabled, disabled].every(harness =>
    harness.notifications.some(({ message: text }) => text.includes('subscribed to'))))

  const idleOffer = message({
    id: 'offer-idle',
    from: 'a4s/source',
    to: 'a4s/all',
    kind: 'task.offer',
    body: 'idle work',
  })
  await publish(publisher, 'synagent/v2/a4s/all', serialize(idleOffer))
  await waitFor(() => observed.some(event => event.kind === 'task.claim' && event.reply_to === idleOffer.id))
  const idleClaims = observed.filter(event => event.kind === 'task.claim' && event.reply_to === idleOffer.id)
  assert.deepEqual(idleClaims.map(claim => claim.from), ['a4s/accepting'])
  assert.equal(enabled.received.length, 0)
  assert.equal(disabled.received.length, 0)

  enabled.idle = false
  const busyOffer = message({
    id: 'offer-busy',
    from: 'a4s/source',
    to: 'a4s/all',
    kind: 'task.offer',
    body: 'busy work',
  })
  await publish(publisher, 'synagent/v2/a4s/all', serialize(busyOffer))
  await waitFor(() => [enabled, disabled].every(harness =>
    harness.entries.some(entry =>
      entry.customType === 'synagent-delivered'
      && 'id' in entry.data
      && entry.data.id === busyOffer.id)))
  assert.equal(observed.some(event => event.kind === 'task.claim' && event.reply_to === busyOffer.id), false)

  await enabled.command('synagent', 'status')
  assert.ok(enabled.notifications.some(({ message: text }) => text.includes('accept-offers=true')))
})
