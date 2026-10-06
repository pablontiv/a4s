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
  let source
  try {
    source = await fs.readFile(stateFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw tagOperationalError(error, 'A4S_ENSURE_STATE_INVALID', { phase: 'state.read' })
  }

  let value
  try {
    value = JSON.parse(source)
  } catch {
    console.warn('[synagent-bus ensure] ignoring malformed runtime state')
    return null
  }
  if (value?.version !== 1 || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0 ||
      typeof value.paneId !== 'string' || value.paneId.length === 0 ||
      typeof value.tabId !== 'string' || value.tabId.length === 0) {
    console.warn('[synagent-bus ensure] ignoring unsupported runtime state')
    return null
  }
  return value
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
  const response = Buffer.alloc(4)
  return new Promise(resolve => {
    let responseLength = 0
    let settled = false
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const cleanup = () => {
      socket.setTimeout(0)
      socket.off('timeout', onTimeout)
      socket.off('error', onError)
      socket.off('connect', onConnect)
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onClose)
    }
    const finish = value => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      resolve(value)
    }
    const onTimeout = () => finish(false)
    const onError = () => finish(false)
    const onConnect = () => socket.write(connectPacket)
    const onData = data => {
      if (responseLength + data.length > response.length) return finish(false)
      data.copy(response, responseLength)
      responseLength += data.length
      if (responseLength === response.length) {
        finish(response[0] === 0x20 && response[1] === 0x02 && response[2] === 0x00 && response[3] === 0x00)
      }
    }
    const onEnd = () => finish(false)
    const onClose = () => finish(false)

    socket.setTimeout(timeoutMs)
    socket.once('timeout', onTimeout)
    socket.once('error', onError)
    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('close', onClose)
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

function verifyNewBusPane(herdr, state) {
  const paneResponse = command(herdr, ['pane', 'get', state.paneId], { allowFailure: true })
  if (!paneResponse) {
    throw operationalError(
      'A4S_ENSURE_HERDR_COMMAND_FAILED',
      'new Synagent pane cannot be verified',
      { phase: 'pane.get' },
    )
  }
  const pane = resultOf(paneResponse, 'pane_info', 'pane.get').pane
  if (!pane || pane.pane_id !== state.paneId || pane.workspace_id !== state.workspaceId ||
      pane.tab_id !== state.tabId) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'new Synagent pane identity cannot be verified',
      { phase: 'pane.get' },
    )
  }

  const tabResponse = command(herdr, ['tab', 'get', state.tabId], { allowFailure: true })
  if (!tabResponse) {
    throw operationalError(
      'A4S_ENSURE_HERDR_COMMAND_FAILED',
      'new Synagent Bus tab cannot be verified',
      { phase: 'tab.get' },
    )
  }
  const tab = resultOf(tabResponse, 'tab_info', 'tab.get').tab
  if (!tab || tab.tab_id !== state.tabId || tab.workspace_id !== state.workspaceId || tab.label !== TAB_LABEL) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'new Synagent Bus tab identity cannot be verified',
      { phase: 'tab.get' },
    )
  }

  const processResponse = command(herdr, ['pane', 'process-info', '--pane', state.paneId], { allowFailure: true })
  if (!processResponse) {
    throw operationalError(
      'A4S_ENSURE_HERDR_COMMAND_FAILED',
      'new Synagent pane process cannot be verified',
      { phase: 'pane.process_info' },
    )
  }
  const processInfo = resultOf(processResponse, 'pane_process_info', 'pane.process_info').process_info
  if (!processInfo || processInfo.pane_id !== state.paneId || !Array.isArray(processInfo.foreground_processes)) {
    throw operationalError(
      'A4S_ENSURE_STATE_INVALID',
      'new Synagent pane process identity cannot be verified',
      { phase: 'pane.process_info' },
    )
  }
  const running = processInfo.foreground_processes.some(process => {
    if (!process || typeof process !== 'object') return false
    const argv = Array.isArray(process.argv) ? process.argv : []
    if (argv.some(argument => typeof argument === 'string' && path.basename(argument) === 'broker.cjs')) return true
    if (typeof process.argv0 === 'string' && path.basename(process.argv0) === 'synagent-bus') return true
    return typeof process.cmdline === 'string' &&
      /(?:^|[\\/\s])(?:broker\.cjs|synagent-bus)(?:\s|$)/.test(process.cmdline)
  })
  if (!running) {
    throw operationalError(
      'A4S_ENSURE_READINESS_FAILED',
      'new Synagent pane is not running the declared bus command',
      { phase: 'pane.process_info', retryable: true },
    )
  }
}

function openBusPane(herdr, workspaceId, paneEnv) {
  const args = [
    'plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'bus',
    '--placement', 'tab', '--workspace', workspaceId, '--cwd', path.dirname(__dirname), '--no-focus',
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

function logAlreadyRunning(logger, port) {
  logger.info('herdr.ensure.already_running', {
    body: 'Synagent broker is already running',
    attributes: { 'server.port': port },
    protocol: { channel: 'mqtt_loopback', contaminated: false },
  })
  logger.info('herdr.ensure.ready', {
    body: 'Existing Synagent broker is ready',
    attributes: { 'server.port': port },
    protocol: { channel: 'stdout', contaminated: false },
    flushStatus: 'sync_requested',
  })
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

    if (await mqttProbe(port)) {
      logAlreadyRunning(logger, port)
      return null
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
      if (await mqttProbe(port)) {
        logAlreadyRunning(logger, port)
        return null
      }

      const previousState = await readState(stateFile)
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

      let workspace = matches[0]
      if (!workspace) {
        const created = resultOf(command(herdr, [
          'workspace', 'create', '--cwd', os.homedir(), '--label', WORKSPACE_LABEL, '--no-focus',
        ]), 'workspace_created', 'workspace.create')
        workspace = created.workspace
        if (!workspace?.workspace_id || !created.tab?.tab_id) {
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
      const replacementState = { version: 1, workspaceId: workspace.workspace_id, ...opened }
      if (!await waitForBroker(port)) {
        throw operationalError(
          'A4S_ENSURE_READINESS_FAILED',
          'new Synagent MQTT listener did not become ready',
          { phase: 'readiness.mqtt', retryable: true },
        )
      }
      verifyNewBusPane(herdr, replacementState)
      await writeState(stateFile, replacementState)

      if (previousState?.paneId && previousState.paneId !== replacementState.paneId) {
        try {
          command(herdr, ['plugin', 'pane', 'close', previousState.paneId])
        } catch {
          console.warn('[synagent-bus ensure] old pane cleanup failed')
        }
      }

      logger.info('herdr.ensure.ready', {
        body: 'New Synagent broker is ready',
        attributes: { 'server.port': port },
        protocol: { channel: 'stdout', contaminated: false },
        flushStatus: 'sync_requested',
      })
      return replacementState
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
    if (state) console.log(`SYNAGENT BUS READY workspace=${state.workspaceId} pane=${state.paneId}`)
    else console.log('SYNAGENT BUS READY')
  }).catch(error => {
    console.error(`[synagent-bus ensure] ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { acquireEnsureMutex, ensure, mqttProbe }
