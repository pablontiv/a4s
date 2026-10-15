import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSynagentOmp } from '../adapters/omp/index.ts'
import { resolveAgentDir, settingsPaths } from '../adapters/session/settings.ts'
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

test('omp adapter captures completion and releases only on terminal agent_end', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'omp-adapter-end-publisher')
  const events: CanonicalMessage[] = []
  publisher.on('message', (_topic, payload) => {
    events.push(JSON.parse(payload.toString()) as CanonicalMessage)
  })
  await new Promise<void>((resolveSubscription, rejectSubscription) => {
    publisher.subscribe('synagent/v1/a4s/claude-1', { qos: 1 }, error => {
      if (error) rejectSubscription(error)
      else resolveSubscription()
    })
  })
  const harness = createHarness(createSynagentOmp, {
    'a4s.synagent.broker-url': url,
  }, [], 'omp-end')
  t.after(async () => {
    await harness.shutdown()
    await end(publisher)
    await closeServer(server)
    await closeBroker(broker)
  })

  const topic = 'synagent/v1/a4s/omp-end'
  await harness.start()
  await waitFor(() => harness.notifications.some(({ message }) => message.includes('subscribed to') && message.includes(topic)))
  await publish(publisher, topic, serialize(message({ id: 'omp-first', to: 'a4s/omp-end' })))
  await publish(publisher, topic, serialize(message({ id: 'omp-second', to: 'a4s/omp-end' })))
  await waitFor(() =>
    harness.received.length === 1
    && harness.entries.some(entry => entry.customType === 'synagent-delivered' && entry.data.id === 'omp-second'),
  )
  await harness.confirmDelivery(0)
  await waitFor(() => events.some(event =>
    event.kind === 'task.delivered' && event.causation_id === 'omp-first'))
  await harness.messageEnd('assistant', [{ type: 'toolCall' }])
  await harness.messageEnd('assistant', 'OMP_FINAL')

  await harness.agentEnd({ type: 'agent_end', messages: [], willContinue: true })
  assert.equal(harness.received.length, 1)
  assert.equal(events.some(event => event.kind === 'task.completed'), false)

  await harness.agentEnd({ type: 'agent_end', messages: [], willContinue: undefined })
  await waitFor(() => harness.received.length === 2)
  assert.match(harness.received[1]?.text ?? '', /id omp-second/)
  await waitFor(() => events.some(event =>
    event.kind === 'task.completed' && event.causation_id === 'omp-first'))
  const completed = events.find(event =>
    event.kind === 'task.completed' && event.causation_id === 'omp-first')
  assert.ok(completed)
  assert.equal(completed.body, 'OMP_FINAL')
  assert.equal(completed.correlation_id, 'omp-first')
})

test('omp settings use user agent paths with the agent directory override', t => {
  const root = mkdtempSync(join(tmpdir(), 'synagent-omp-settings-'))
  const home = join(root, 'home')
  const override = join(root, 'agent-override')
  const host = { agentDirName: '.omp', legacySettings: false } as const
  const previous = process.env.PI_CODING_AGENT_DIR
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })

  assert.equal(resolveAgentDir({}, home, host.agentDirName), join(home, '.omp', 'agent'))
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '   ' }, home, host.agentDirName), join(home, '.omp', 'agent'))
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: override }, home, host.agentDirName), override)

  process.env.PI_CODING_AGENT_DIR = '   '
  const defaults = settingsPaths(undefined, host)
  assert.deepEqual(defaults, {
    global: join(homedir(), '.omp', 'agent', 'synagent.json'),
  })

  process.env.PI_CODING_AGENT_DIR = override
  assert.deepEqual(settingsPaths(undefined, host), {
    global: join(override, 'synagent.json'),
  })
})
