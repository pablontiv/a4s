import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { renderObservations, replayObservations } from '../../observer.ts'
import type { Observation } from '../../observer.ts'
import { closeBroker, closeServer, connectClient, end, publish, startBroker, waitFor } from '../support/harness.ts'

function observation(message: unknown, index = 0): Observation {
  return {
    topic: 'synagent/v2/project/peer',
    received_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    payload: JSON.stringify(message),
  }
}

const cli = fileURLToPath(new URL('../../observer-cli.ts', import.meta.url))

test('JSONL replay CLI round-trips exact payload strings and reports invalid lines', async t => {
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

test('CLI reads the user-scoped omp broker, stops cleanly, and replays the final live snapshot offline', { timeout: 15000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'synagent-observer-cli-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const { broker, server, url } = await startBroker()
  t.after(async () => { await closeServer(server); await closeBroker(broker) })
  const agentDir = join(temp, 'agent')
  mkdirSync(agentDir)
  writeFileSync(join(agentDir, 'agent-messaging.json'), JSON.stringify({ 'broker-url': url }))
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
  await publish(publisher, 'synagent/v2/project/receiver', JSON.stringify({ id: 'request', body: 'request' }))
  await publish(publisher, 'synagent/v2/project/sender', JSON.stringify({ id: 'reply', reply_to: 'request', body: 'reply' }))
  await waitFor(() => stdout.includes('AgentMessaging observer: 2 message(s)'))
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
