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

export type SynagentSettingKey = 'enabled' | 'broker-url' | 'global' | 'default-peer' | 'request-ttl'
export type SynagentSettings = {
  enabled: boolean
  'broker-url': string
  global: boolean
  'default-peer': string
  'request-ttl'?: number
}
export type SynagentSettingsPaths = {
  global: string
  globalLegacy?: string
}

export type SynagentSettingsHost = {
  agentDirName: string
  legacySettings: boolean
}

type SettingsRecord = Partial<SynagentSettings>
type JsonRecord = Record<string, unknown>

export const SYNAGENT_SETTING_KEYS: readonly SynagentSettingKey[] = [
  'enabled',
  'broker-url',
  'global',
  'default-peer',
  'request-ttl',
]

export const DEFAULT_SETTINGS: Readonly<SynagentSettings> = {
  enabled: true,
  'broker-url': DEFAULT_BROKER_URL,
  global: true,
  'default-peer': DEFAULT_PEER,
}

const LEGACY_KEYS: Readonly<Record<SynagentSettingKey, string>> = {
  enabled: 'a4s.synagent.enabled',
  'broker-url': 'a4s.synagent.broker-url',
  global: 'a4s.synagent.global',
  'default-peer': 'a4s.synagent.default-peer',
  'request-ttl': 'a4s.synagent.request-ttl',
}

export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  agentDirName = '.pi',
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim()
  return configured ? configured : join(home, agentDirName, 'agent')
}

export function settingsPaths(
  agentDir?: string,
  host: SynagentSettingsHost = { agentDirName: '.pi', legacySettings: true },
): SynagentSettingsPaths {
  const globalDir = agentDir ?? resolveAgentDir(process.env, homedir(), host.agentDirName)
  return {
    global: join(globalDir, 'synagent.json'),
    ...(host.legacySettings ? {
      globalLegacy: join(globalDir, 'settings.json'),
    } : {}),
  }
}

export function initializeSynagentSettings(
  paths: SynagentSettingsPaths,
  env: NodeJS.ProcessEnv = process.env,
): SynagentSettings {
  if (paths.globalLegacy) migrateLegacySettings(paths.global, paths.globalLegacy)
  return loadSynagentSettings(paths, env)
}

export function findRejectedBrokerUrl(
  paths: SynagentSettingsPaths,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const environmentBrokerUrl = env.SYNAGENT_BROKER_URL?.trim()
  if (environmentBrokerUrl) {
    try {
      assertLoopbackBrokerUrl(environmentBrokerUrl)
      return undefined
    } catch {
      return environmentBrokerUrl
    }
  }
  const candidates: unknown[] = []
  candidates.push(readRawNativeValue(paths.global, 'broker-url'))
  if (paths.globalLegacy) candidates.push(readRawLegacyValue(paths.globalLegacy, 'broker-url'))
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
  env: NodeJS.ProcessEnv = process.env,
): SynagentSettings {
  const globalNew = readNativeSettings(paths.global)
  const globalLegacy = paths.globalLegacy ? readLegacySettings(paths.globalLegacy) : {}
  const resolved = { ...DEFAULT_SETTINGS }
  const environmentBrokerUrl = env.SYNAGENT_BROKER_URL?.trim()
  const environmentRequestTtl = env.SYNAGENT_REQUEST_TTL?.trim()
  const parsedEnvironmentRequestTtl = environmentRequestTtl
    ? parseSettingValue('request-ttl', environmentRequestTtl)
    : undefined

  for (const key of SYNAGENT_SETTING_KEYS) {
    const environmentValue = key === 'broker-url'
      ? environmentBrokerUrl
      : key === 'request-ttl'
        ? parsedEnvironmentRequestTtl
        : undefined
    const candidates = environmentValue === undefined
      ? [globalNew[key], globalLegacy[key], DEFAULT_SETTINGS[key]]
      : [environmentValue, globalNew[key], globalLegacy[key], DEFAULT_SETTINGS[key]]
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
  if (key === 'request-ttl') {
    const seconds = Number(input)
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > Number.MAX_SAFE_INTEGER / 1000) {
      throw new Error(`Invalid Synagent request-ttl (use positive seconds): ${input}`)
    }
    return seconds
  }
  const peer = input.trim()
  if (!isAddress(peer) && !isToken(peer)) throw new Error(`Invalid Synagent peer: ${input}`)
  return peer
}

export function persistSetting(
  paths: SynagentSettingsPaths,
  key: SynagentSettingKey,
  value: SynagentSettings[SynagentSettingKey],
  operations: { chmodSync?: typeof chmodSync } = {},
): void {
  if (!isValidSetting(key, value)) throw new Error(`Invalid Synagent ${key}: ${String(value)}`)
  const path = paths.global
  const current = readNativeFileForUpdate(path)
  current[key] = value
  atomicWriteJson(path, current, operations.chmodSync)
}

export function resetSetting(
  paths: SynagentSettingsPaths,
  key: SynagentSettingKey,
): void {
  const path = paths.global
  const current = readNativeFileForUpdate(path)
  delete current[key]
  atomicWriteJson(path, current)
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

function migrateLegacySettings(nativePath: string, legacyPath: string): void {
  if (existsSync(nativePath) || !existsSync(legacyPath)) return
  const migrated = readLegacySettings(legacyPath)
  atomicWriteJson(nativePath, migrated)
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
  if (key === 'request-ttl') {
    return typeof value === 'number'
      && Number.isFinite(value)
      && value > 0
      && value <= Number.MAX_SAFE_INTEGER / 1000
  }
  return typeof value === 'string' && (isAddress(value.trim()) || isToken(value.trim()))
}

function assignSetting<K extends SynagentSettingKey>(
  target: Partial<SynagentSettings>,
  key: K,
  value: SynagentSettings[K],
): void {
  target[key] = value
}

function atomicWriteJson(
  path: string,
  value: JsonRecord | SettingsRecord,
  setMode: typeof chmodSync = chmodSync,
): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${randomUUID()}.synagent.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    setMode(temporaryPath, 0o600)
    renameSync(temporaryPath, path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporaryPath, { force: true })
    throw error
  }
}
