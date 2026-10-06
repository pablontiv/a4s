import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_SETTINGS,
  initializeSynagentSettings,
  loadSynagentSettings,
  resolveAgentDir,
  settingsPaths,
} from '../adapters/pi/settings.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synagent-settings-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(join(cwd, '.pi'), { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  return { root, cwd, agentDir, paths: settingsPaths(cwd, agentDir) }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('Synagent settings use defaults and field-level scope precedence', () => {
  const { paths } = fixture()
  assert.deepEqual(loadSynagentSettings(paths, true), DEFAULT_SETTINGS)

  writeJson(paths.project, { enabled: false })
  writeJson(paths.global, { enabled: true, 'broker-url': 'mqtt://localhost:1885' })
  writeJson(paths.projectLegacy, {
    extensionSettings: {
      'a4s.synagent.default-peer': 'Project.Peer',
      'a4s.synagent.global': false,
    },
  })
  writeJson(paths.globalLegacy, {
    extensionSettings: {
      'a4s.synagent.project': 'Legacy.Project',
      'a4s.synagent.default-peer': 'Global.Peer',
    },
  })

  assert.deepEqual(loadSynagentSettings(paths, true), {
    enabled: false,
    'broker-url': 'mqtt://localhost:1885',
    project: 'Legacy.Project',
    global: false,
    'default-peer': 'Project.Peer',
  })
})

test('Synagent settings ignore project files when the project is not trusted', () => {
  const { paths } = fixture()
  writeJson(paths.project, { project: 'Untrusted.Project', enabled: false })
  writeJson(paths.global, { project: 'Global.Project', enabled: true })

  const settings = initializeSynagentSettings(paths, false)
  assert.equal(settings.project, 'Global.Project')
  assert.equal(settings.enabled, true)
})

test('Synagent settings migrate only the five known legacy keys', () => {
  const { paths } = fixture()
  const legacy = {
    'a4s.synagent.enabled': false,
    'a4s.synagent.broker-url': 'mqtt://127.0.0.1:1999',
    'a4s.synagent.project': 'Migrated.Project',
    'a4s.synagent.global': false,
    'a4s.synagent.default-peer': 'Migrated.Peer',
    'other.extension.value': 'unchanged',
  }
  writeJson(paths.globalLegacy, { theme: 'dark', extensionSettings: legacy })

  const settings = initializeSynagentSettings(paths, true)
  assert.deepEqual(settings, {
    enabled: false,
    'broker-url': 'mqtt://127.0.0.1:1999',
    project: 'Migrated.Project',
    global: false,
    'default-peer': 'Migrated.Peer',
  })
  assert.deepEqual(JSON.parse(readFileSync(paths.global, 'utf8')), {
    enabled: false,
    'broker-url': 'mqtt://127.0.0.1:1999',
    project: 'Migrated.Project',
    global: false,
    'default-peer': 'Migrated.Peer',
  })
  assert.deepEqual(JSON.parse(readFileSync(paths.globalLegacy, 'utf8')), {
    theme: 'dark',
    extensionSettings: legacy,
  })
  assert.equal(statSync(paths.global).mode & 0o777, 0o600)
})

test('Synagent migration rejects a remote MQTT broker URL', () => {
  const { paths } = fixture()
  writeJson(paths.globalLegacy, {
    extensionSettings: {
      'a4s.synagent.broker-url': 'mqtt://broker.example.com:1883',
      'a4s.synagent.project': 'Safe.Project',
    },
  })

  const settings = initializeSynagentSettings(paths, true)
  assert.equal(settings['broker-url'], DEFAULT_SETTINGS['broker-url'])
  assert.equal(settings.project, 'Safe.Project')
  assert.deepEqual(JSON.parse(readFileSync(paths.global, 'utf8')), { project: 'Safe.Project' })
})

test('Synagent resolves the agent directory from a non-empty environment value', () => {
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '/tmp/pi-agent' }, '/home/test'), '/tmp/pi-agent')
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '   ' }, '/home/test'), '/home/test/.pi/agent')
  assert.equal(resolveAgentDir({}, '/home/test'), '/home/test/.pi/agent')
})
