import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_SETTINGS,
  findRejectedBrokerUrl,
  loadAgentMessagingSettings,
  parseSettingValue,
  persistSetting,
  resetSetting,
  settingsPaths,
} from '../adapters/session/settings.ts'
import { createHarness } from './support/harness.ts'
import { createAgentMessagingOmp } from '../adapters/omp/index.ts'

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-messaging-settings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return settingsPaths(directory)
}

test('canonical settings load the agent config and prefer A4S environment overrides', t => {
  const paths = fixture(t)
  writeFileSync(paths.global, JSON.stringify({
    enabled: false,
    global: false,
    'broker-url': 'mqtt://localhost:19001',
    'default-peer': 'Project/Peer',
    'request-ttl': 5,
    'accept-offers': true,
  }))
  assert.deepEqual(loadAgentMessagingSettings(paths, {
    A4S_AGENT_MESSAGING_BROKER_URL: 'mqtt://127.0.0.1:19002',
    A4S_AGENT_MESSAGING_REQUEST_TTL: '12',
  }), {
    enabled: false,
    global: false,
    'broker-url': 'mqtt://127.0.0.1:19002',
    'default-peer': 'Project/Peer',
    'request-ttl': 12,
    'accept-offers': true,
  })
  assert.equal(findRejectedBrokerUrl(paths, {}), undefined)
  assert.equal(findRejectedBrokerUrl(paths, {
    A4S_AGENT_MESSAGING_BROKER_URL: 'mqtt://remote.example:1883',
  }), 'mqtt://remote.example:1883')
})

test('settings persist private atomic updates and reset to canonical defaults', t => {
  const paths = fixture(t)
  writeFileSync(paths.global, JSON.stringify({ operatorMetadata: 'retained' }))
  persistSetting(paths, 'default-peer', parseSettingValue('default-peer', 'Project/Peer'))
  persistSetting(paths, 'request-ttl', parseSettingValue('request-ttl', '1.5'))
  assert.equal(loadAgentMessagingSettings(paths, {})['default-peer'], 'Project/Peer')
  assert.equal(loadAgentMessagingSettings(paths, {})['request-ttl'], 1.5)
  assert.equal(JSON.parse(readFileSync(paths.global, 'utf8')).operatorMetadata, 'retained')
  if (process.platform !== 'win32') assert.equal(statSync(paths.global).mode & 0o777, 0o600)
  resetSetting(paths, 'default-peer')
  resetSetting(paths, 'request-ttl')
  assert.deepEqual(loadAgentMessagingSettings(paths, {}), DEFAULT_SETTINGS)
})

test('shorthand peer settings require an explicit canonical address', () => {
  assert.equal(parseSettingValue('default-peer', 'Project/Native.Session'), 'Project/Native.Session')
  assert.throws(() => parseSettingValue('default-peer', 'peer'), /canonical peer/)
  for (const value of ['0', '-1', 'Infinity', 'NaN']) {
    assert.throws(() => parseSettingValue('request-ttl', value), /positive seconds/)
  }
})

test('canonical commands enable shorthand only after the operator configures a peer', async t => {
  const harness = createHarness(createAgentMessagingOmp, { 'a4s.agent-messaging.enabled': false })
  t.after(() => harness.shutdown())
  await harness.start()
  await harness.command('mq-send', 'shorthand body')
  assert.match(harness.notifications.at(-1)?.message ?? '', /shorthand requires \/agent-messaging set default-peer/)
  await harness.command('agent-messaging', 'set default-peer Project/Native.Session')
  await harness.command('agent-messaging', 'status')
  assert.match(harness.notifications.at(-1)?.message ?? '', /peer=Project\/Native.Session/)
  await harness.command('mq-send', 'shorthand body')
  assert.match(harness.notifications.at(-1)?.message ?? '', /not connected/)
})
