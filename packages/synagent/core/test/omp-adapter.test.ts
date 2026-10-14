import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSynagentOmp } from '../adapters/omp/index.ts'
import { resolveAgentDir, settingsPaths } from '../adapters/session/settings.ts'
import { serialize } from '../protocol.ts'
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

test('omp adapter releases the ordering barrier only on a terminal agent_end', async t => {
  const { broker, server, url } = await startBroker()
  const publisher = await connectClient(url, 'omp-adapter-end-publisher')
  const harness = createHarness(createSynagentOmp, '.omp', {
    'a4s.synagent.broker-url': url,
    'a4s.synagent.project': 'a4s',
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

  harness.agentEnd({ type: 'agent_end', messages: [], willContinue: true })
  assert.equal(harness.received.length, 1)

  harness.agentEnd({ type: 'agent_end', messages: [], willContinue: undefined })
  assert.equal(harness.received.length, 2)
  assert.match(harness.received[1]?.text ?? '', /id omp-second/)
})

test('omp settings use omp project and agent paths with the agent directory override', t => {
  const root = mkdtempSync(join(tmpdir(), 'synagent-omp-settings-'))
  const cwd = join(root, 'project')
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
  const defaults = settingsPaths(cwd, undefined, host)
  assert.deepEqual(defaults, {
    global: join(homedir(), '.omp', 'agent', 'synagent.json'),
    project: join(cwd, '.omp', 'synagent.json'),
  })

  process.env.PI_CODING_AGENT_DIR = override
  assert.deepEqual(settingsPaths(cwd, undefined, host), {
    global: join(override, 'synagent.json'),
    project: join(cwd, '.omp', 'synagent.json'),
  })
})
