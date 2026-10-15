import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { groupObservations, observeBus, renderObservations, replayObservations } from '../observer.ts'
import type { Observation } from '../observer.ts'
import { closeBroker, closeServer, connectClient, end, publish, startBroker, waitFor } from './support/harness.ts'

function observation(message: unknown, index = 0): Observation {
  return {
    topic: 'synagent/v1/project/peer',
    received_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    payload: JSON.stringify(message),
  }
}

const cli = fileURLToPath(new URL('../observer-cli.ts', import.meta.url))

test('observer groups transitive replies and correlation links while retaining receipt order', () => {
  const request = observation({ id: 'request', correlation_id: 'operation', body: 'pedido íntegro' }, 0)
  const unrelated = observation({ id: 'elsewhere' }, 1)
  const reply = observation({ id: 'reply', reply_to: 'request' }, 2)
  const correlated = observation({ id: 'another-request', correlation_id: 'operation' }, 3)
  const replyToReply = observation({ id: 'final', reply_to: 'reply' }, 4)
  const records = [request, unrelated, reply, correlated, replyToReply]
  assert.deepEqual(groupObservations(records), [[request, reply, correlated, replyToReply], [unrelated]])
  const rendered = renderObservations(records)
  assert.match(rendered, /Chain id="request" correlation_id="operation"/)
  assert.ok(rendered.indexOf('id="request"', rendered.indexOf('topic=')) < rendered.indexOf('id="reply"'))
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
  assert.match(rendered, /Synagent observer: 2 message\(s\)/)
  assert.equal(renderObservations([]), 'Synagent observer: 0 message(s)\n')
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
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, '--replay', 'capture.jsonl'], {
    encoding: 'utf8', env: { ...process.env, INIT_CWD: temp },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, renderObservations(records))
  assert.equal(result.stderr, '')
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
  const topics = ['synagent/v1/project/receiver', 'synagent/v1/project/sender', 'synagent/status']
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

test('CLI reads the user-scoped omp broker, stops cleanly, and replays the final live snapshot offline', { timeout: 15000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'synagent-observer-cli-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const { broker, server, url } = await startBroker()
  t.after(async () => { await closeServer(server); await closeBroker(broker) })
  const agentDir = join(temp, 'agent')
  mkdirSync(agentDir)
  writeFileSync(join(agentDir, 'synagent.json'), JSON.stringify({ 'broker-url': url }))
  const child = spawn(process.execPath, ['--import', 'tsx', cli, '--output', 'capture.jsonl'], {
    env: { ...process.env, INIT_CWD: temp, PI_CODING_AGENT_DIR: agentDir }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM') })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += String(data) })
  child.stderr.on('data', data => { stderr += String(data) })
  await waitFor(() => stderr.includes('Subscribed to synagent/#'))
  const publisher = await connectClient(url, 'observer-cli-publisher')
  t.after(() => end(publisher))
  await publish(publisher, 'synagent/v1/project/receiver', JSON.stringify({ id: 'request', body: 'request' }))
  await publish(publisher, 'synagent/v1/project/sender', JSON.stringify({ id: 'reply', reply_to: 'request', body: 'reply' }))
  await waitFor(() => stdout.includes('Synagent observer: 2 message(s)'))
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])
  const records = await replayObservations(join(temp, 'capture.jsonl'))
  const finalSnapshot = renderObservations(records)
  assert.ok(stdout.endsWith(finalSnapshot))
  assert.ok(stderr.includes(url))
  await end(publisher)
  await closeServer(server)
  await closeBroker(broker)
  const replay = spawnSync(process.execPath, ['--import', 'tsx', cli, '--replay', 'capture.jsonl'], {
    encoding: 'utf8', env: { ...process.env, INIT_CWD: temp },
  })
  assert.equal(replay.status, 0, replay.stderr)
  assert.equal(replay.stdout, finalSnapshot)
  assert.equal(readFileSync(join(temp, 'capture.jsonl'), 'utf8').trim().split('\n').length, 2)
})
