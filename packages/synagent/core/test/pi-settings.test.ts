import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  DEFAULT_SETTINGS,
  initializeSynagentSettings,
  loadSynagentSettings,
  persistSetting,
  resolveAgentDir,
  settingsPaths,
} from '../adapters/session/settings.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'synagent-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const paths = settingsPaths(agentDir)
  const { globalLegacy } = paths
  assert.ok(globalLegacy)
  return { agentDir, paths: { ...paths, globalLegacy } }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('Synagent resolves each user setting from native, legacy, and default values', t => {
  const { paths } = fixture(t)
  assert.deepEqual(loadSynagentSettings(paths), DEFAULT_SETTINGS)
  writeJson(paths.global, { enabled: false, 'broker-url': 'mqtt://localhost:1885' })
  writeJson(paths.globalLegacy, {
    extensionSettings: {
      'a4s.synagent.enabled': true,
      'a4s.synagent.default-peer': 'User.Peer',
      'a4s.synagent.global': false,
    },
  })
  assert.deepEqual(loadSynagentSettings(paths), {
    enabled: false,
    'broker-url': 'mqtt://localhost:1885',
    global: false,
    'default-peer': 'User.Peer',
  })
})

test('Synagent migrates the four user settings and preserves the legacy file', t => {
  const { paths } = fixture(t)
  const legacy = {
    'a4s.synagent.enabled': false,
    'a4s.synagent.broker-url': 'mqtt://127.0.0.1:1999',
    'a4s.synagent.global': false,
    'a4s.synagent.default-peer': 'Migrated.Peer',
    'other.extension.value': 'unchanged',
  }
  writeJson(paths.globalLegacy, { theme: 'dark', extensionSettings: legacy })
  const expected = {
    enabled: false,
    'broker-url': 'mqtt://127.0.0.1:1999',
    global: false,
    'default-peer': 'Migrated.Peer',
  }
  assert.deepEqual(initializeSynagentSettings(paths), expected)
  assert.deepEqual(JSON.parse(readFileSync(paths.global, 'utf8')), expected)
  assert.deepEqual(JSON.parse(readFileSync(paths.globalLegacy, 'utf8')), {
    theme: 'dark', extensionSettings: legacy,
  })
  assert.equal(statSync(paths.global).mode & 0o777, 0o600)
})

test('Synagent migration uses the default broker for a remote MQTT URL', t => {
  const { paths } = fixture(t)
  writeJson(paths.globalLegacy, {
    extensionSettings: {
      'a4s.synagent.broker-url': 'mqtt://broker.example.com:1883',
      'a4s.synagent.global': false,
    },
  })
  const settings = initializeSynagentSettings(paths)
  assert.equal(settings['broker-url'], DEFAULT_SETTINGS['broker-url'])
  assert.deepEqual(JSON.parse(readFileSync(paths.global, 'utf8')), { global: false })
})

test('Synagent persists all four user settings across initialization', t => {
  const { paths } = fixture(t)
  persistSetting(paths, 'enabled', false)
  persistSetting(paths, 'broker-url', 'mqtt://localhost:1999')
  persistSetting(paths, 'global', false)
  persistSetting(paths, 'default-peer', 'User.Peer')
  assert.deepEqual(initializeSynagentSettings(paths), {
    enabled: false, 'broker-url': 'mqtt://localhost:1999', global: false, 'default-peer': 'User.Peer',
  })
  assert.equal(statSync(paths.global).mode & 0o777, 0o600)
})

test('Synagent keeps the destination unchanged when temporary chmod fails', t => {
  const { agentDir, paths } = fixture(t)
  writeJson(paths.global, { enabled: true, global: false })
  const original = readFileSync(paths.global, 'utf8')
  assert.throws(() => persistSetting(paths, 'enabled', false, {
    chmodSync() { throw new Error('simulated temporary chmod failure') },
  }), /simulated temporary chmod failure/)
  assert.equal(readFileSync(paths.global, 'utf8'), original)
  assert.deepEqual(readdirSync(agentDir).filter(name => name.endsWith('.synagent.tmp')), [])
})

test('Synagent resolves the agent directory from a non-empty environment value', () => {
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '/tmp/pi-agent' }, '/home/test'), '/tmp/pi-agent')
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '   ' }, '/home/test'), '/home/test/.pi/agent')
  assert.equal(resolveAgentDir({}, '/home/test'), '/home/test/.pi/agent')
})
