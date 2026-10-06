#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { classifyError, createLogger, operationalError, tagOperationalError } = require('../logging.cjs')

const PLUGIN_ID = 'a4s.synagent-bus'
const WORKSPACE_LABEL = 'Synagent'
const TAB_LABEL = 'Bus'
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function commandPhase(args) {
  const signature = args.slice(0, 3).join(' ')
  const phases = {
    'workspace list': 'workspace.list',
    'workspace create --cwd': 'workspace.create',
    'plugin pane open': 'pane.open',
    'plugin pane close': 'pane.close',
    'pane get': 'pane.get',
    'pane process-info --pane': 'pane.process_info',
    'tab get': 'tab.get',
    'tab rename': 'tab.rename',
    'tab close': 'tab.close',
  }
  return phases[signature] || phases[args.slice(0, 2).join(' ')] || 'ensure'
}

function command(bin, args, { allowFailure = false } = {}) {
  const phase = commandPhase(args)
  const result = spawnSync(bin, args, { encoding: 'utf8', env: process.env })
  if (result.error) {
    throw tagOperationalError(result.error, 'A4S_ENSURE_HERDR_UNAVAILABLE', {
      phase,
      retryable: true,
    })
  }
  if (result.status !== 0) {
    if (allowFailure) return null
    throw operationalError(
      'A4S_ENSURE_HERDR_COMMAND_FAILED',
      `Herdr command failed (${args.join(' ')}): ${(result.stderr || result.stdout).trim()}`,
      { phase },
    )
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw operationalError(
      'A4S_ENSURE_HERDR_RESPONSE_INVALID',
      `Herdr returned non-JSON output for ${args.join(' ')}`,
      { phase },
    )
  }
}

function resultOf(response, type, phase) {
  const result = response?.result
  if (!result || result.type !== type) {
    throw operationalError(
      'A4S_ENSURE_HERDR_RESPONSE_INVALID',
      `unexpected Herdr response; expected ${type}`,
      { phase },
    )
  }
  return result
}

async function readState(stateFile) {
  try {
    const value = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    if (value?.version !== 1 || typeof value.workspaceId !== 'string' ||
        typeof value.paneId !== 'string' || typeof value.tabId !== 'string') {
      throw operationalError('A4S_ENSURE_STATE_INVALID', 'invalid runtime state', { phase: 'state.read' })
    }
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.a4sCode) throw error
    throw tagOperationalError(error, 'A4S_ENSURE_STATE_INVALID', { phase: 'state.read' })
  }
}

async function writeState(stateFile, state) {
  const temporary = `${stateFile}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await fs.rename(temporary, stateFile)
  } catch (error) {
    throw tagOperationalError(error, 'A4S_ENSURE_STATE_WRITE_FAILED', { phase: 'state.write' })
  }
}

function mqttProbe(port, timeoutMs = 500) {
  // MQTT 3.1.1 CONNECT with clean session and client id "ensure-probe".
  const connectPacket = Buffer.concat([
    Buffer.from([0x10, 0x18, 0x00, 0x04]), Buffer.from('MQTT'),
    Buffer.from([0x04, 0x02, 0x00, 0x03, 0x00, 0x0c]), Buffer.from('ensure-probe'),
  ])
  return new Promise(resolve => {
    let settled = false
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write(connectPacket))
    socket.once('data', data => finish(data.length >= 4 && data[0] === 0x20 && data[3] === 0x00))
  })
}

async function waitForBroker(port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await mqttProbe(port)) return true
    await delay(100)
  }
  return false
}

function listenControl(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host: '127.0.0.1', exclusive: true })
  })
}

async function acquireEnsureMutex(port, { attempts = 100, delayMs = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const server = net.createServer(socket => socket.destroy())
    try {
      await listenControl(server, port)
      let released = false
      return () => new Promise((resolve, reject) => {
        if (released) return resolve()
        released = true
        server.close(error => error ? reject(error) : resolve())
      })
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      if (attempt + 1 < attempts) await delay(delayMs)
    }
  }
  throw tagOperationalError(Object.assign(
    new Error(`Synagent ensure control port 127.0.0.1:${port} remains in use`),
    { code: 'EADDRINUSE' },
  ), 'A4S_ENSURE_LOCK_BUSY', { phase: 'lock.acquire', retryable: true })
}

function inspectPane(herdr, state) {
  const paneResponse = command(herdr, ['pane', 'get', state.paneId], { allowFailure: true })
  if (!paneResponse) return { status: 'missing' }
  const pane = resultOf(paneResponse, 'pane_info', 'pane.get').pane
  if (!pane || pane.workspace_id !== state.workspaceId || pane.tab_id !== state.tabId) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'saved Synagent pane does not match its workspace and tab',
      { phase: 'pane.get' },
    )
  }

  const tabResponse = command(herdr, ['tab', 'get', state.tabId], { allowFailure: true })
  if (!tabResponse) {
    throw operationalError(
      'A4S_ENSURE_HERDR_COMMAND_FAILED',
      'Synagent Bus tab cannot be verified',
      { phase: 'tab.get' },
    )
  }
  const tab = resultOf(tabResponse, 'tab_info', 'tab.get').tab
  if (!tab || tab.workspace_id !== state.workspaceId || tab.label !== TAB_LABEL) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'Synagent pane is not in its recorded Bus tab',
      { phase: 'tab.get' },
    )
  }

  const processResponse = command(herdr, ['pane', 'process-info', '--pane', state.paneId], { allowFailure: true })
  if (!processResponse) {
    throw operationalError(
      'A4S_ENSURE_HERDR_COMMAND_FAILED',
      'Synagent pane process cannot be verified',
      { phase: 'pane.process_info' },
    )
  }
  const processInfo = resultOf(processResponse, 'pane_process_info', 'pane.process_info').process_info
  if (!processInfo || !Array.isArray(processInfo.foreground_processes)) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'Synagent pane process list cannot be verified',
      { phase: 'pane.process_info' },
    )
  }
  const running = processInfo.foreground_processes.some(process => {
    const argv = Array.isArray(process.argv) ? process.argv : []
    if (argv.some(argument => path.basename(argument) === 'broker.cjs')) return true
    if (process.argv0 && path.basename(process.argv0) === 'synagent-bus') return true
    return typeof process.cmdline === 'string' &&
      /(?:^|[\\/\s])(?:broker\.cjs|synagent-bus)(?:\s|$)/.test(process.cmdline)
  })
  return { status: running ? 'running' : 'stopped', pane, tab }
}

function openBusPane(herdr, workspaceId, paneEnv) {
  const args = [
    'plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'bus',
    '--placement', 'tab', '--workspace', workspaceId, '--no-focus',
  ]
  for (const name of [
    'SYNAGENT_PORT',
    'SYNAGENT_DB',
    'A4S_SYNAGENT_BUS_LOG_DIR',
    'A4S_SERVICE_INSTANCE_ID',
    'A4S_OPERATION_ID',
    'A4S_CORRELATION_ID',
    'XDG_STATE_HOME',
  ]) {
    if (paneEnv[name]) args.push('--env', `${name}=${paneEnv[name]}`)
  }
  const opened = resultOf(
    command(herdr, args),
    'plugin_pane_opened',
    'pane.open',
  ).plugin_pane?.pane
  if (!opened || opened.workspace_id !== workspaceId || !opened.pane_id || !opened.tab_id) {
    throw operationalError(
      'A4S_ENSURE_SPAWN_FAILED',
      'Herdr did not return a verifiable Synagent plugin pane',
      { phase: 'pane.open' },
    )
  }
  command(herdr, ['tab', 'rename', opened.tab_id, TAB_LABEL])
  return { paneId: opened.pane_id, tabId: opened.tab_id }
}

function closeStoppedOwnedPane(herdr, inspection, state) {
  if (inspection.tab.pane_count !== 1) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'stopped Synagent plugin tab contains unowned panes; refusing repair',
      { phase: 'pane.close' },
    )
  }
  command(herdr, ['plugin', 'pane', 'close', state.paneId])
  if (command(herdr, ['pane', 'get', state.paneId], { allowFailure: true })) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'stopped Synagent plugin pane still exists after close',
      { phase: 'pane.close' },
    )
  }
  if (command(herdr, ['tab', 'get', state.tabId], { allowFailure: true })) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'stopped Synagent plugin tab still exists after its only pane closed',
      { phase: 'tab.close' },
    )
  }
}

function paneEnvironment(logger, env = process.env) {
  return {
    SYNAGENT_PORT: env.SYNAGENT_PORT,
    SYNAGENT_DB: env.SYNAGENT_DB,
    A4S_SYNAGENT_BUS_LOG_DIR: env.A4S_SYNAGENT_BUS_LOG_DIR,
    A4S_SERVICE_INSTANCE_ID: logger.instanceId,
    A4S_OPERATION_ID: logger.operationId,
    A4S_CORRELATION_ID: logger.correlationId,
    XDG_STATE_HOME: env.XDG_STATE_HOME,
  }
}

async function ensure() {
  const logger = createLogger({
    scopeName: 'a4s.synagent-bus.herdr.ensure',
    harnessKind: 'herdr-plugin',
    harnessRole: 'ensure',
  })
  const paneEnv = paneEnvironment(logger)
  let releaseMutex
  logger.info('herdr.ensure.started', {
    body: 'Herdr ensure operation began',
    protocol: { channel: 'jsonl_file', contaminated: false },
  })

  try {
    const herdr = process.env.HERDR_BIN_PATH
    const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
    if (!herdr) {
      throw operationalError('A4S_ENSURE_ARGUMENT_INVALID', 'HERDR_BIN_PATH is required', { phase: 'arguments' })
    }
    if (!stateDir) {
      throw operationalError(
        'A4S_ENSURE_ARGUMENT_INVALID',
        'HERDR_PLUGIN_STATE_DIR is required',
        { phase: 'arguments' },
      )
    }

    const port = Number(process.env.SYNAGENT_PORT || 1884)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw operationalError(
        'A4S_ENSURE_PORT_INVALID',
        'SYNAGENT_PORT must be a fixed port from 1 to 65535 for Herdr verification',
        { phase: 'arguments' },
      )
    }
    const controlPort = Number(process.env.SYNAGENT_ENSURE_PORT || 11884)
    if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535 || controlPort === port) {
      throw operationalError(
        'A4S_ENSURE_PORT_INVALID',
        'SYNAGENT_ENSURE_PORT must be a fixed port from 1 to 65535 distinct from SYNAGENT_PORT',
        { phase: 'arguments' },
      )
    }

    try {
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw tagOperationalError(error, 'A4S_ENSURE_STATE_WRITE_FAILED', { phase: 'state.write' })
    }
    const stateFile = path.join(stateDir, 'runtime.json')
    try {
      releaseMutex = await acquireEnsureMutex(controlPort)
    } catch (error) {
      if (error.a4sCode) throw error
      throw tagOperationalError(error, 'A4S_ENSURE_LOCK_FAILED', {
        phase: 'lock.acquire',
        retryable: true,
      })
    }
    logger.info('herdr.ensure.lock_acquired', {
      body: 'Herdr ensure mutex acquired',
      attributes: { 'server.port': controlPort },
      protocol: { channel: 'tcp_loopback', contaminated: false },
    })
    try {
      const workspaceResult = resultOf(
        command(herdr, ['workspace', 'list']),
        'workspace_list',
        'workspace.list',
      )
      if (!Array.isArray(workspaceResult.workspaces)) {
        throw operationalError(
          'A4S_ENSURE_HERDR_RESPONSE_INVALID',
          'unexpected Herdr response; expected workspace_list',
          { phase: 'workspace.list' },
        )
      }
      const matches = workspaceResult.workspaces.filter(workspace => workspace.label === WORKSPACE_LABEL)
      if (matches.length > 1) {
        throw operationalError(
          'A4S_ENSURE_WORKSPACE_AMBIGUOUS',
          'multiple Herdr workspaces are named Synagent',
          { phase: 'workspace.validate' },
        )
      }

      let state = await readState(stateFile)
      let workspace = matches[0]
      let initialTabId

      if (state && workspace && state.workspaceId !== workspace.workspace_id) {
        throw operationalError(
          'A4S_ENSURE_WORKSPACE_INVALID',
          'Synagent runtime state points to a different workspace',
          { phase: 'workspace.validate' },
        )
      }
      if (state && !workspace) {
        if (await mqttProbe(port)) {
          throw operationalError(
            'A4S_ENSURE_WORKSPACE_INVALID',
            'MQTT listener exists but its Synagent workspace is missing',
            { phase: 'workspace.validate' },
          )
        }
        state = null
      }
      if (!state && workspace && await mqttProbe(port)) {
        throw operationalError(
          'A4S_ENSURE_WORKSPACE_INVALID',
          'MQTT listener exists in an unowned pre-existing Synagent workspace',
          { phase: 'workspace.validate' },
        )
      }

      if (state && workspace) {
        const inspection = inspectPane(herdr, state)
        if (inspection.status === 'running') {
          logger.info('herdr.ensure.already_running', {
            body: 'Recorded Synagent pane is already running',
            attributes: { 'server.port': port },
            protocol: { channel: 'mqtt_loopback', contaminated: false },
          })
          if (!await waitForBroker(port)) {
            throw operationalError(
              'A4S_ENSURE_READINESS_FAILED',
              'Synagent pane exists but its MQTT listener is not verifiable',
              { phase: 'readiness.mqtt', retryable: true },
            )
          }
          logger.info('herdr.ensure.ready', {
            body: 'Existing Synagent broker is ready',
            attributes: { 'server.port': port },
            protocol: { channel: 'stdout', contaminated: false },
            flushStatus: 'sync_requested',
          })
          return state
        }
        if (await mqttProbe(port)) {
          throw operationalError(
            'A4S_ENSURE_STATE_INVALID',
            'MQTT listener exists but the recorded Synagent pane is not running it',
            { phase: 'pane.process_info' },
          )
        }
        if (inspection.status === 'stopped') closeStoppedOwnedPane(herdr, inspection, state)
      }

      if (!workspace) {
        const created = resultOf(command(herdr, [
          'workspace', 'create', '--cwd', os.homedir(), '--label', WORKSPACE_LABEL, '--no-focus',
        ]), 'workspace_created', 'workspace.create')
        workspace = created.workspace
        initialTabId = created.tab?.tab_id
        if (!workspace?.workspace_id || !initialTabId) {
          throw operationalError(
            'A4S_ENSURE_WORKSPACE_INVALID',
            'Herdr did not return a complete Synagent workspace',
            { phase: 'workspace.create' },
          )
        }
        const confirmedResult = resultOf(
          command(herdr, ['workspace', 'list']),
          'workspace_list',
          'workspace.list',
        )
        const confirmed = Array.isArray(confirmedResult.workspaces)
          ? confirmedResult.workspaces.filter(candidate => candidate.label === WORKSPACE_LABEL)
          : []
        if (confirmed.length !== 1 || confirmed[0].workspace_id !== workspace.workspace_id) {
          throw operationalError(
            'A4S_ENSURE_WORKSPACE_INVALID',
            'created Synagent workspace is not uniquely verifiable',
            { phase: 'workspace.validate' },
          )
        }
      }

      const opened = openBusPane(herdr, workspace.workspace_id, paneEnv)
      logger.info('herdr.ensure.spawned', {
        body: 'Herdr Synagent broker pane was opened',
        protocol: { channel: 'herdr_command', contaminated: false },
      })
      state = { version: 1, workspaceId: workspace.workspace_id, ...opened }
      await writeState(stateFile, state)

      if (initialTabId && initialTabId !== state.tabId) {
        command(herdr, ['tab', 'close', initialTabId])
      }
      if (inspectPane(herdr, state).status !== 'running') {
        throw operationalError(
          'A4S_ENSURE_READINESS_FAILED',
          'new Synagent pane is not running the declared bus command',
          { phase: 'pane.process_info', retryable: true },
        )
      }
      if (!await waitForBroker(port)) {
        throw operationalError(
          'A4S_ENSURE_READINESS_FAILED',
          'new Synagent MQTT listener did not become ready',
          { phase: 'readiness.mqtt', retryable: true },
        )
      }
      logger.info('herdr.ensure.ready', {
        body: 'New Synagent broker is ready',
        attributes: { 'server.port': port },
        protocol: { channel: 'stdout', contaminated: false },
        flushStatus: 'sync_requested',
      })
      return state
    } finally {
      try {
        await releaseMutex()
      } catch (error) {
        throw tagOperationalError(error, 'A4S_ENSURE_LOCK_RELEASE_FAILED', {
          phase: 'lock.release',
          retryable: true,
        })
      }
    }
  } catch (error) {
    logger.error('herdr.ensure.failed', {
      body: 'Herdr ensure operation failed',
      error: classifyError(error, 'herdr.ensure', {
        code: error?.a4sCode || 'A4S_ENSURE_OPERATION_FAILED',
        phase: error?.a4sPhase || 'ensure',
      }),
      protocol: { channel: 'stderr', contaminated: false },
      flushStatus: 'sync_requested',
    })
    throw error
  } finally {
    logger.close()
  }
}

if (require.main === module) {
  ensure().then(state => {
    console.log(`SYNAGENT BUS READY workspace=${state.workspaceId} pane=${state.paneId}`)
  }).catch(error => {
    console.error(`[synagent-bus ensure] ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { acquireEnsureMutex, ensure, mqttProbe }
