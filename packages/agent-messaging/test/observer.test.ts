import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { groupObservations, observeBus, renderObservations, replayObservations } from '../observer.ts'
import type { Observation } from '../observer.ts'
import { closeBroker, closeServer, connectClient, end, publish, startBroker, waitFor } from './support/harness.ts'

function observation(message: unknown, index = 0): Observation {
  return {
    topic: 'synagent/v2/project/peer',
    received_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    payload: JSON.stringify(message),
  }
}

test('observer groups causal, reply, and correlation links while retaining receipt order', () => {
  const request = observation({ id: 'request', correlation_id: 'operation', body: 'pedido íntegro' }, 0)
  const unrelated = observation({ id: 'elsewhere' }, 1)
  const delivered = observation({ id: 'delivered', causation_id: 'request', correlation_id: 'operation' }, 2)
  const correlated = observation({ id: 'another-request', correlation_id: 'operation' }, 3)
  const reply = observation({ id: 'final', reply_to: 'delivered' }, 4)
  const records = [request, unrelated, delivered, correlated, reply]
  assert.deepEqual(groupObservations(records), [[request, delivered, correlated, reply], [unrelated]])
  const rendered = renderObservations(records)
  assert.match(rendered, /Chain id=\"request\" correlation_id=\"operation\"/)
  assert.ok(rendered.indexOf('id=\"request\"', rendered.indexOf('topic=')) < rendered.indexOf('id=\"delivered\"'))
  assert.match(rendered, /causation_id=\"request\"/)
  assert.match(rendered, /pedido íntegro/)
})

test('observer merges previously separate chains when a late parent bridges them', () => {
  const child = observation({ id: 'child', reply_to: 'parent' }, 0)
  const correlated = observation({ id: 'other', correlation_id: 'operation' }, 1)
  const parent = observation({ id: 'parent', reply_to: 'root', correlation_id: 'operation' }, 2)
  const root = observation({ id: 'root' }, 3)
  assert.deepEqual(groupObservations([child, correlated, parent, root]), [[child, correlated, parent, root]])
  assert.match(renderObservations([child, parent, root]), /Chain id="root"/)
  assert.match(renderObservations([child]), /Chain id="parent"/)
})

test('observer keeps id and correlation namespaces distinct and preserves duplicate receipts', () => {
  const id = observation({ id: 'shared' })
  const correlation = observation({ correlation_id: 'shared' })
  const duplicate = { ...id, received_at: '2026-01-01T00:00:01.000Z' }
  const raw = { ...id, payload: 'unstructured\u001b[2J\ntext' }
  const scalar = observation('a string, not an envelope')
  assert.deepEqual(groupObservations([id, correlation, duplicate, raw, scalar]), [[id, duplicate], [correlation], [raw], [scalar]])
  const rendered = renderObservations([raw, scalar])
  assert.ok(rendered.includes('payload="unstructured\\u001b[2J\\ntext"'))
  assert.match(rendered, /AgentMessaging observer: 2 message\(s\)/)
  assert.equal(renderObservations([]), 'AgentMessaging observer: 0 message(s)\n')
})

test('JSONL replay round-trips exact payload strings and reports invalid lines', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'synagent-observer-replay-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const file = join(temp, 'capture.jsonl')
  const records = [
    observation({ id: 'request', correlation_id: 'trace', body: 'línea\n二' }),
    observation({ id: 'reply', reply_to: 'request', body: 'respuesta' }, 1),
    { topic: 'synagent/status', received_at: '2026-01-01T00:00:02.000Z', payload: 'not JSON' },
  ]
  writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\r\n')}\r\n\r\n`)
  assert.deepEqual(await replayObservations(file), records)
  writeFileSync(file, `${JSON.stringify(records[0])}\n{\n`)
  await assert.rejects(replayObservations(file), /capture\.jsonl:2: invalid JSON/)
  writeFileSync(file, '{"topic":"synagent/status","payload":{}}\n')
  await assert.rejects(replayObservations(file), /:1: expected string topic, received_at and payload/)
})

test('live observer subscribes to the whole tree and appends every reception for identical replay', { timeout: 15000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'synagent-observer-live-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const { broker, server, url } = await startBroker()
  t.after(async () => { await closeServer(server); await closeBroker(broker) })
  const publisher = await connectClient(url, 'observer-test-publisher')
  t.after(() => end(publisher))
  const publications: string[] = []
  broker.on('publish', (_packet, client) => { if (client) publications.push(client.id) })
  const subscriptions: string[][] = []
  broker.on('subscribe', subscriptionsForClient => { subscriptions.push(subscriptionsForClient.map(item => item.topic)) })
  const controller = new AbortController()
  const snapshots: string[] = []
  const output = join(temp, 'capture.jsonl')
  const prior = observation({ id: 'prior' })
  writeFileSync(output, JSON.stringify(prior))
  let ready = false
  const running = observeBus({
    brokerUrl: url, output, signal: controller.signal,
    onReady() { ready = true },
    onSnapshot(snapshot) { snapshots.push(snapshot) },
  })
  t.after(async () => { controller.abort(); await running })
  await waitFor(() => ready)
  const payloads = [
    JSON.stringify({ id: 'request', correlation_id: 'operation', body: 'pedido íntegro' }),
    JSON.stringify({ id: 'reply', reply_to: 'request', body: 'respuesta íntegra' }),
    'raw status',
  ]
  const topics = ['synagent/v2/project/receiver', 'synagent/v2/project/sender', 'synagent/status']
  for (let index = 0; index < payloads.length; index += 1) await publish(publisher, topics[index]!, payloads[index]!)
  await waitFor(() => snapshots.length === 3)
  controller.abort()
  await running
  const replay = await replayObservations(output)
  assert.equal(replay.length, 4)
  assert.deepEqual(replay[0], prior)
  assert.deepEqual(replay.slice(1).map(record => record.payload), payloads)
  assert.deepEqual(replay.slice(1).map(record => record.topic), topics)
  for (const record of replay.slice(1)) assert.equal(new Date(record.received_at).toISOString(), record.received_at)
  assert.equal(snapshots.at(-1), renderObservations(replay.slice(1)))
  assert.deepEqual(subscriptions, [['synagent/#']])
  assert.deepEqual(publications, Array<string>(3).fill('observer-test-publisher'))
})

