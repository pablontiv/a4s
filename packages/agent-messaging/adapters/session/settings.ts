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

import { isAddress } from '../../protocol.ts'

export const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'

export type AgentMessagingSettingKey =
  | 'enabled'
  | 'broker-url'
  | 'global'
  | 'default-peer'
  | 'request-ttl'
  | 'accept-offers'
export type AgentMessagingSettings = {
  enabled: boolean
  'broker-url': string
  global: boolean
  'default-peer'?: string
  'request-ttl'?: number
  'accept-offers': boolean
}
export type AgentMessagingSettingsPaths = {
  global: string
}


type SettingsRecord = Partial<AgentMessagingSettings>
type JsonRecord = Record<string, unknown>

export const AGENT_MESSAGING_SETTING_KEYS: readonly AgentMessagingSettingKey[] = [
  'enabled',
  'broker-url',
  'global',
  'default-peer',
  'request-ttl',
  'accept-offers',
]

export const DEFAULT_SETTINGS: Readonly<AgentMessagingSettings> = {
  enabled: true,
  'broker-url': DEFAULT_BROKER_URL,
  global: true,
  'accept-offers': false,
}


export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim()
  return configured ? configured : join(home, '.omp', 'agent')
}

export function settingsPaths(
  agentDir?: string,
): AgentMessagingSettingsPaths {
  const globalDir = agentDir ?? resolveAgentDir()
  return {
    global: join(globalDir, 'agent-messaging.json'),
  }
}


export function findRejectedBrokerUrl(
  paths: AgentMessagingSettingsPaths,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const environmentBrokerUrl = env.A4S_AGENT_MESSAGING_BROKER_URL?.trim()
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

export function loadAgentMessagingSettings(
  paths: AgentMessagingSettingsPaths,
  env: NodeJS.ProcessEnv = process.env,
): AgentMessagingSettings {
  const globalNew = readNativeSettings(paths.global)
  const resolved = { ...DEFAULT_SETTINGS }
  const environmentBrokerUrl = env.A4S_AGENT_MESSAGING_BROKER_URL?.trim()
  const environmentRequestTtl = env.A4S_AGENT_MESSAGING_REQUEST_TTL?.trim()
  const parsedEnvironmentRequestTtl = environmentRequestTtl
    ? parseSettingValue('request-ttl', environmentRequestTtl)
    : undefined

  for (const key of AGENT_MESSAGING_SETTING_KEYS) {
    const environmentValue = key === 'broker-url'
      ? environmentBrokerUrl
      : key === 'request-ttl'
        ? parsedEnvironmentRequestTtl
        : undefined
    const candidates = environmentValue === undefined
      ? [globalNew[key], DEFAULT_SETTINGS[key]]
      : [environmentValue, globalNew[key], DEFAULT_SETTINGS[key]]
    for (const candidate of candidates) {
      if (isValidSetting(key, candidate)) {
        assignSetting(resolved, key, candidate)
        break
      }
    }
  }
  return resolved
}

export function parseSettingValue(key: AgentMessagingSettingKey, input: string): AgentMessagingSettings[AgentMessagingSettingKey] {
  if (key === 'enabled' || key === 'global' || key === 'accept-offers') {
    if (input !== 'true' && input !== 'false') {
      throw new Error(`Invalid AgentMessaging ${key} (use true|false): ${input}`)
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
      throw new Error(`Invalid AgentMessaging request-ttl (use positive seconds): ${input}`)
    }
    return seconds
  }
  const peer = input.trim()
  if (!isAddress(peer)) throw new Error(`Invalid AgentMessaging canonical peer: ${input}`)
  return peer
}

export function persistSetting(
  paths: AgentMessagingSettingsPaths,
  key: AgentMessagingSettingKey,
  value: AgentMessagingSettings[AgentMessagingSettingKey],
  operations: { chmodSync?: typeof chmodSync } = {},
): void {
  if (!isValidSetting(key, value)) throw new Error(`Invalid AgentMessaging ${key}: ${String(value)}`)
  const path = paths.global
  const current = readNativeFileForUpdate(path)
  current[key] = value
  atomicWriteJson(path, current, operations.chmodSync)
}

export function resetSetting(
  paths: AgentMessagingSettingsPaths,
  key: AgentMessagingSettingKey,
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
    throw new Error(`Invalid AgentMessaging broker URL: ${value}`)
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
    throw new Error('AgentMessaging broker URL must be an unauthenticated loopback mqtt:// URL')
  }
}


function readRawNativeValue(path: string, key: AgentMessagingSettingKey): unknown {
  if (!existsSync(path)) return undefined
  try {
    return parseJsonRecord(readFileSync(path, 'utf8'), path)[key]
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


function knownValidSettings(input: JsonRecord): SettingsRecord {
  const result: SettingsRecord = {}
  for (const key of AGENT_MESSAGING_SETTING_KEYS) {
    const value = input[key]
    if (isValidSetting(key, value)) assignSetting(result, key, value)
  }
  return result
}

function parseJsonRecord(text: string, path: string): JsonRecord {
  const value: unknown = JSON.parse(text)
  if (!isJsonRecord(value)) throw new Error(`AgentMessaging settings must contain a JSON object: ${path}`)
  return value
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidSetting<K extends AgentMessagingSettingKey>(key: K, value: unknown): value is AgentMessagingSettings[K] {
  if (key === 'enabled' || key === 'global' || key === 'accept-offers') return typeof value === 'boolean'
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
  return typeof value === 'string' && isAddress(value.trim())
}

function assignSetting<K extends AgentMessagingSettingKey>(
  target: Partial<AgentMessagingSettings>,
  key: K,
  value: AgentMessagingSettings[K],
): void {
  target[key] = value
}

function atomicWriteJson(
  path: string,
  value: JsonRecord | SettingsRecord,
  setMode: typeof chmodSync = chmodSync,
): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${randomUUID()}.agent-messaging.tmp`)
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
