#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const PLUGIN_ID = 'a4s.synagent-bus'
const WORKSPACE_LABEL = 'Synagent'
const TAB_LABEL = 'Bus'
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function command(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (allowFailure) return null
    throw new Error(`Herdr command failed (${args.join(' ')}): ${(result.stderr || result.stdout).trim()}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`Herdr returned non-JSON output for ${args.join(' ')}`)
  }
}

function resultOf(response, type) {
  const result = response?.result
  if (!result || result.type !== type) throw new Error(`unexpected Herdr response; expected ${type}`)
  return result
}

async function readState(stateFile) {
  try {
    const value = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    if (value?.version !== 1 || typeof value.workspaceId !== 'string' ||
        typeof value.paneId !== 'string' || typeof value.tabId !== 'string') {
      throw new Error('invalid runtime state')
    }
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeState(stateFile, state) {
  const temporary = `${stateFile}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await fs.rename(temporary, stateFile)
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
  throw Object.assign(
    new Error(`Synagent ensure control port 127.0.0.1:${port} remains in use`),
    { code: 'EADDRINUSE' },
  )
}

function inspectPane(herdr, state) {
  const paneResponse = command(herdr, ['pane', 'get', state.paneId], { allowFailure: true })
  if (!paneResponse) return { status: 'missing' }
  const pane = resultOf(paneResponse, 'pane_info').pane
  if (!pane || pane.workspace_id !== state.workspaceId || pane.tab_id !== state.tabId) {
    throw new Error('saved Synagent pane does not match its workspace and tab')
  }

  const tabResponse = command(herdr, ['tab', 'get', state.tabId], { allowFailure: true })
  if (!tabResponse) throw new Error('Synagent Bus tab cannot be verified')
  const tab = resultOf(tabResponse, 'tab_info').tab
  if (!tab || tab.workspace_id !== state.workspaceId || tab.label !== TAB_LABEL) {
    throw new Error('Synagent pane is not in its recorded Bus tab')
  }

  const processResponse = command(herdr, ['pane', 'process-info', '--pane', state.paneId], { allowFailure: true })
  if (!processResponse) throw new Error('Synagent pane process cannot be verified')
  const processInfo = resultOf(processResponse, 'pane_process_info').process_info
  if (!processInfo || !Array.isArray(processInfo.foreground_processes)) {
    throw new Error('Synagent pane process list cannot be verified')
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

function openBusPane(herdr, workspaceId) {
  const args = [
    'plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'bus',
    '--placement', 'tab', '--workspace', workspaceId, '--no-focus',
  ]
  for (const name of ['SYNAGENT_PORT', 'SYNAGENT_DB']) {
    if (process.env[name]) args.push('--env', `${name}=${process.env[name]}`)
  }
  const opened = resultOf(command(herdr, args), 'plugin_pane_opened').plugin_pane?.pane
  if (!opened || opened.workspace_id !== workspaceId || !opened.pane_id || !opened.tab_id) {
    throw new Error('Herdr did not return a verifiable Synagent plugin pane')
  }
  command(herdr, ['tab', 'rename', opened.tab_id, TAB_LABEL])
  return { paneId: opened.pane_id, tabId: opened.tab_id }
}

function closeStoppedOwnedPane(herdr, inspection, state) {
  if (inspection.tab.pane_count !== 1) {
    throw new Error('stopped Synagent plugin tab contains unowned panes; refusing repair')
  }
  command(herdr, ['plugin', 'pane', 'close', state.paneId])
  if (command(herdr, ['pane', 'get', state.paneId], { allowFailure: true })) {
    throw new Error('stopped Synagent plugin pane still exists after close')
  }
  if (command(herdr, ['tab', 'get', state.tabId], { allowFailure: true })) {
    throw new Error('stopped Synagent plugin tab still exists after its only pane closed')
  }
}

async function ensure() {
  const herdr = process.env.HERDR_BIN_PATH
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  if (!herdr) throw new Error('HERDR_BIN_PATH is required')
  if (!stateDir) throw new Error('HERDR_PLUGIN_STATE_DIR is required')

  const port = Number(process.env.SYNAGENT_PORT || 1884)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SYNAGENT_PORT must be a fixed port from 1 to 65535 for Herdr verification')
  }
  const controlPort = Number(process.env.SYNAGENT_ENSURE_PORT || 11884)
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535 || controlPort === port) {
    throw new Error('SYNAGENT_ENSURE_PORT must be a fixed port from 1 to 65535 distinct from SYNAGENT_PORT')
  }

  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const stateFile = path.join(stateDir, 'runtime.json')
  const releaseMutex = await acquireEnsureMutex(controlPort)
  try {
    const workspaceResult = resultOf(command(herdr, ['workspace', 'list']), 'workspace_list')
    const matches = workspaceResult.workspaces.filter(workspace => workspace.label === WORKSPACE_LABEL)
    if (matches.length > 1) throw new Error('multiple Herdr workspaces are named Synagent')

    let state = await readState(stateFile)
    let workspace = matches[0]
    let initialTabId

    if (state && workspace && state.workspaceId !== workspace.workspace_id) {
      throw new Error('Synagent runtime state points to a different workspace')
    }
    if (state && !workspace) {
      if (await mqttProbe(port)) throw new Error('MQTT listener exists but its Synagent workspace is missing')
      state = null
    }
    if (!state && workspace && await mqttProbe(port)) {
      throw new Error('MQTT listener exists in an unowned pre-existing Synagent workspace')
    }

    if (state && workspace) {
      const inspection = inspectPane(herdr, state)
      if (inspection.status === 'running') {
        if (!await waitForBroker(port)) throw new Error('Synagent pane exists but its MQTT listener is not verifiable')
        return state
      }
      if (await mqttProbe(port)) throw new Error('MQTT listener exists but the recorded Synagent pane is not running it')
      if (inspection.status === 'stopped') closeStoppedOwnedPane(herdr, inspection, state)
    }

    if (!workspace) {
      const created = resultOf(command(herdr, [
        'workspace', 'create', '--cwd', os.homedir(), '--label', WORKSPACE_LABEL, '--no-focus',
      ]), 'workspace_created')
      workspace = created.workspace
      initialTabId = created.tab?.tab_id
      if (!workspace?.workspace_id || !initialTabId) throw new Error('Herdr did not return a complete Synagent workspace')
      const confirmed = resultOf(command(herdr, ['workspace', 'list']), 'workspace_list').workspaces
        .filter(candidate => candidate.label === WORKSPACE_LABEL)
      if (confirmed.length !== 1 || confirmed[0].workspace_id !== workspace.workspace_id) {
        throw new Error('created Synagent workspace is not uniquely verifiable')
      }
    }

    const opened = openBusPane(herdr, workspace.workspace_id)
    state = { version: 1, workspaceId: workspace.workspace_id, ...opened }
    await writeState(stateFile, state)

    if (initialTabId && initialTabId !== state.tabId) {
      command(herdr, ['tab', 'close', initialTabId])
    }
    if (inspectPane(herdr, state).status !== 'running') {
      throw new Error('new Synagent pane is not running the declared bus command')
    }
    if (!await waitForBroker(port)) throw new Error('new Synagent MQTT listener did not become ready')
    return state
  } finally {
    await releaseMutex()
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
