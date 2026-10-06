import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { isAddress, isToken } from '../../protocol.ts'

export const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'
export const DEFAULT_PEER = 'claude'

export type SynagentSettingKey = 'enabled' | 'broker-url' | 'project' | 'global' | 'default-peer'
export type SynagentSettings = {
  enabled: boolean
  'broker-url': string
  project: string
  global: boolean
  'default-peer': string
}
export type SynagentSettingsScope = 'global' | 'project'
export type SynagentSettingsPaths = {
  global: string
  project: string
  globalLegacy: string
  projectLegacy: string
}

type SettingsRecord = Partial<SynagentSettings>
type JsonRecord = Record<string, unknown>

export const SYNAGENT_SETTING_KEYS: readonly SynagentSettingKey[] = [
  'enabled',
  'broker-url',
  'project',
  'global',
  'default-peer',
]

export const DEFAULT_SETTINGS: Readonly<SynagentSettings> = {
  enabled: true,
  'broker-url': DEFAULT_BROKER_URL,
  project: '',
  global: true,
  'default-peer': DEFAULT_PEER,
}

const LEGACY_KEYS: Readonly<Record<SynagentSettingKey, string>> = {
  enabled: 'a4s.synagent.enabled',
  'broker-url': 'a4s.synagent.broker-url',
  project: 'a4s.synagent.project',
  global: 'a4s.synagent.global',
  'default-peer': 'a4s.synagent.default-peer',
}

export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim()
  return configured ? configured : join(home, '.pi', 'agent')
}

export function settingsPaths(cwd: string, agentDir = resolveAgentDir()): SynagentSettingsPaths {
  return {
    global: join(agentDir, 'synagent.json'),
    project: join(cwd, '.pi', 'synagent.json'),
    globalLegacy: join(agentDir, 'settings.json'),
    projectLegacy: join(cwd, '.pi', 'settings.json'),
  }
}

export function initializeSynagentSettings(
  paths: SynagentSettingsPaths,
  projectTrusted: boolean,
): SynagentSettings {
  migrateLegacyScope(paths.global, paths.globalLegacy, 'global')
  if (projectTrusted) migrateLegacyScope(paths.project, paths.projectLegacy, 'project')
  return loadSynagentSettings(paths, projectTrusted)
}

export function findRejectedBrokerUrl(
  paths: SynagentSettingsPaths,
  projectTrusted: boolean,
): string | undefined {
  const candidates: unknown[] = []
  if (projectTrusted) candidates.push(readRawNativeValue(paths.project, 'broker-url'))
  candidates.push(readRawNativeValue(paths.global, 'broker-url'))
  if (projectTrusted) candidates.push(readRawLegacyValue(paths.projectLegacy, 'broker-url'))
  candidates.push(readRawLegacyValue(paths.globalLegacy, 'broker-url'))
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    try {
      assertLoopbackBrokerUrl(candidate)
    } catch {
      return candidate
    }
  }
  return undefined
}

export function loadSynagentSettings(
  paths: SynagentSettingsPaths,
  projectTrusted: boolean,
): SynagentSettings {
  const projectNew = projectTrusted ? readNativeSettings(paths.project) : {}
  const globalNew = readNativeSettings(paths.global)
  const projectLegacy = projectTrusted ? readLegacySettings(paths.projectLegacy) : {}
  const globalLegacy = readLegacySettings(paths.globalLegacy)
  const resolved = { ...DEFAULT_SETTINGS }

  for (const key of SYNAGENT_SETTING_KEYS) {
    const candidates = [projectNew[key], globalNew[key], projectLegacy[key], globalLegacy[key], DEFAULT_SETTINGS[key]]
    for (const candidate of candidates) {
      if (isValidSetting(key, candidate)) {
        assignSetting(resolved, key, candidate)
        break
      }
    }
  }
  return resolved
}

export function parseSettingValue(key: SynagentSettingKey, input: string): SynagentSettings[SynagentSettingKey] {
  if (key === 'enabled' || key === 'global') {
    if (input !== 'true' && input !== 'false') {
      throw new Error(`Invalid Synagent ${key} (use true|false): ${input}`)
    }
    return input === 'true'
  }
  if (key === 'broker-url') {
    assertLoopbackBrokerUrl(input)
    return input
  }
  if (key === 'project') {
    const token = input.trim()
    if (token !== '' && !isToken(token)) throw new Error(`Invalid Synagent project: ${input}`)
    return token
  }
  const peer = input.trim()
  if (!isAddress(peer) && !isToken(peer)) throw new Error(`Invalid Synagent peer: ${input}`)
  return peer
}

export function persistSetting(
  paths: SynagentSettingsPaths,
  scope: SynagentSettingsScope,
  key: SynagentSettingKey,
  value: SynagentSettings[SynagentSettingKey],
): void {
  if (!isValidSetting(key, value)) throw new Error(`Invalid Synagent ${key}: ${String(value)}`)
  const path = paths[scope]
  const current = readNativeFileForUpdate(path)
  current[key] = value
  atomicWriteJson(path, current, scope === 'global')
}

export function resetSetting(
  paths: SynagentSettingsPaths,
  scope: SynagentSettingsScope,
  key: SynagentSettingKey,
): void {
  const path = paths[scope]
  const current = readNativeFileForUpdate(path)
  delete current[key]
  atomicWriteJson(path, current, scope === 'global')
}

export function assertLoopbackBrokerUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid Synagent broker URL: ${value}`)
  }
  if (
    url.protocol !== 'mqtt:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash
  ) {
    throw new Error('Synagent broker URL must be an unauthenticated loopback mqtt:// URL')
  }
}

function migrateLegacyScope(nativePath: string, legacyPath: string, scope: SynagentSettingsScope): void {
  if (existsSync(nativePath) || !existsSync(legacyPath)) return
  const migrated = readLegacySettings(legacyPath)
  atomicWriteJson(nativePath, migrated, scope === 'global')
}

function readRawNativeValue(path: string, key: SynagentSettingKey): unknown {
  if (!existsSync(path)) return undefined
  try {
    return parseJsonRecord(readFileSync(path, 'utf8'), path)[key]
  } catch {
    return undefined
  }
}

function readRawLegacyValue(path: string, key: SynagentSettingKey): unknown {
  if (!existsSync(path)) return undefined
  try {
    const extensionSettings = parseJsonRecord(readFileSync(path, 'utf8'), path).extensionSettings
    return isJsonRecord(extensionSettings) ? extensionSettings[LEGACY_KEYS[key]] : undefined
  } catch {
    return undefined
  }
}

function readNativeSettings(path: string): SettingsRecord {
  if (!existsSync(path)) return {}
  try {
    const parsed = parseJsonRecord(readFileSync(path, 'utf8'), path)
    return knownValidSettings(parsed)
  } catch {
    return {}
  }
}

function readNativeFileForUpdate(path: string): JsonRecord {
  if (!existsSync(path)) return {}
  return parseJsonRecord(readFileSync(path, 'utf8'), path)
}

function readLegacySettings(path: string): SettingsRecord {
  if (!existsSync(path)) return {}
  try {
    const parsed = parseJsonRecord(readFileSync(path, 'utf8'), path)
    const extensionSettings = parsed.extensionSettings
    if (!isJsonRecord(extensionSettings)) return {}
    const result: SettingsRecord = {}
    for (const key of SYNAGENT_SETTING_KEYS) {
      const value = extensionSettings[LEGACY_KEYS[key]]
      if (isValidSetting(key, value)) assignSetting(result, key, value)
    }
    return result
  } catch {
    return {}
  }
}

function knownValidSettings(input: JsonRecord): SettingsRecord {
  const result: SettingsRecord = {}
  for (const key of SYNAGENT_SETTING_KEYS) {
    const value = input[key]
    if (isValidSetting(key, value)) assignSetting(result, key, value)
  }
  return result
}

function parseJsonRecord(text: string, path: string): JsonRecord {
  const value: unknown = JSON.parse(text)
  if (!isJsonRecord(value)) throw new Error(`Synagent settings must contain a JSON object: ${path}`)
  return value
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidSetting<K extends SynagentSettingKey>(key: K, value: unknown): value is SynagentSettings[K] {
  if (key === 'enabled' || key === 'global') return typeof value === 'boolean'
  if (key === 'broker-url') {
    if (typeof value !== 'string') return false
    try {
      assertLoopbackBrokerUrl(value)
      return true
    } catch {
      return false
    }
  }
  if (key === 'project') return typeof value === 'string' && (value.trim() === '' || isToken(value.trim()))
  return typeof value === 'string' && (isAddress(value.trim()) || isToken(value.trim()))
}

function assignSetting<K extends SynagentSettingKey>(
  target: Partial<SynagentSettings>,
  key: K,
  value: SynagentSettings[K],
): void {
  target[key] = value
}

function atomicWriteJson(path: string, value: JsonRecord | SettingsRecord, globalFile: boolean): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${randomUUID()}.synagent.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', globalFile ? 0o600 : 0o666)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, path)
    if (globalFile) chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporaryPath, { force: true })
    throw error
  }
}
