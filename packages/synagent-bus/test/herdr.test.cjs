'use strict'

const assert = require('node:assert/strict')
const { fork, spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const BROKER = path.join(__dirname, '..', 'broker.cjs')
const ENSURE = path.join(__dirname, '..', 'herdr', 'ensure.cjs')
const LOCK_WORKER = path.join(__dirname, 'lock-worker.cjs')

function exitWithOutput(proc) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    proc.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

function waitForOutput(proc, pattern, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pattern}`)), timeoutMs)
    const onData = chunk => {
      output += chunk
      if (!pattern.test(output)) return
      clearTimeout(timer)
      proc.stdout.off('data', onData)
      resolve(output)
    }
    proc.stdout.setEncoding('utf8').on('data', onData)
  })
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForClosedPort(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const open = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    })
    if (!open) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`port ${port} stayed open`)
}

async function makeFakeHerdr(temp) {
  const fake = path.join(temp, 'fake-herdr.cjs')
  await fs.writeFile(fake, `#!/usr/bin/env node
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const stateFile = process.env.FAKE_HERDR_STATE
const args = process.argv.slice(2)
let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
state.calls.push(args)
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
const ok = result => { save(); console.log(JSON.stringify({ id: 'fake', result })) }
const fail = message => { save(); console.error(JSON.stringify({ error: { message } })); process.exit(1) }

if (args[0] === 'workspace' && args[1] === 'list') {
  if (state.failWorkspaceList) fail('workspace list failed')
  ok({ type: 'workspace_list', workspaces: state.workspaces })
} else if (args[0] === 'workspace' && args[1] === 'create') {
  const workspace = { workspace_id: 'w-test', label: 'Synagent', active_tab_id: 'w-test:t-root' }
  state.workspaces.push(workspace)
  state.tabs['w-test:t-root'] = { tab_id: 'w-test:t-root', workspace_id: 'w-test', label: 'shell', pane_count: 1 }
  ok({ type: 'workspace_created', workspace, tab: state.tabs['w-test:t-root'], root_pane: { pane_id: 'w-test:p-root' } })
} else if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open') {
  if (state.failOpen) fail('pane open failed')
  state.openCount += 1
  const tabId = 'w-test:t-bus-' + state.openCount
  const paneId = 'w-test:p-bus-' + state.openCount
  state.tabs[tabId] = { tab_id: tabId, workspace_id: 'w-test', label: 'Bus', pane_count: 1 }
  state.panes[paneId] = { pane_id: paneId, tab_id: tabId, workspace_id: 'w-test', running: true }
  const child = spawn(process.execPath, ['-e', \`
    const net = require('node:net');
    const server = net.createServer(socket => socket.once('data', () => socket.end(Buffer.from([0x20, 0x02, 0x00, 0x00]))));
    server.listen(Number(process.env.SYNAGENT_PORT), '127.0.0.1');
  \`], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  state.listenerPid = child.pid
  ok({ type: 'plugin_pane_opened', plugin_pane: { plugin_id: 'a4s.synagent-bus', entrypoint: 'bus', pane: state.panes[paneId] } })
} else if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'close') {
  const pane = state.panes[args[3]]
  if (!pane) fail('plugin pane missing')
  delete state.tabs[pane.tab_id]
  delete state.panes[args[3]]
  state.closeCount += 1
  ok({ type: 'plugin_pane_closed', pane_id: args[3] })
} else if (args[0] === 'tab' && args[1] === 'rename') {
  state.tabs[args[2]].label = args.slice(3).join(' ')
  ok({ type: 'tab_info', tab: state.tabs[args[2]] })
} else if (args[0] === 'tab' && args[1] === 'close') {
  delete state.tabs[args[2]]
  ok({ type: 'ok' })
} else if (args[0] === 'tab' && args[1] === 'get') {
  const tab = state.tabs[args[2]]
  tab ? ok({ type: 'tab_info', tab }) : fail('tab missing')
} else if (args[0] === 'pane' && args[1] === 'get') {
  const pane = state.panes[args[2]]
  pane ? ok({ type: 'pane_info', pane }) : fail('pane missing')
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  if (args.length !== 4 || args[2] !== '--pane') fail('process-info requires --pane <id>')
  const pane = state.panes[args[3]]
  if (!pane) fail('pane missing')
  const process = pane.running
    ? { pid: 101, name: 'node', argv0: 'node', argv: ['node', 'broker.cjs'], cmdline: 'node broker.cjs' }
    : { pid: 102, name: 'zsh', argv0: '/bin/zsh', argv: ['/bin/zsh'], cmdline: '/bin/zsh' }
  ok({ type: 'pane_process_info', process_info: { pane_id: args[3], foreground_processes: [process] } })
} else {
  fail('unexpected command: ' + args.join(' '))
}
`, { mode: 0o755 })
  return fake
}

async function fixture(t, initial = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-herdr-'))
  const stateFile = path.join(temp, 'fake-state.json')
  const pluginState = path.join(temp, 'plugin-state')
  const logRoot = path.join(temp, 'logs')
  const logInstance = 'herdr-ensure-test'
  const state = {
    workspaces: [], tabs: {}, panes: {}, calls: [], openCount: 0, closeCount: 0, listenerPid: null,
    ...initial,
  }
  await fs.writeFile(stateFile, JSON.stringify(state))
  const fake = await makeFakeHerdr(temp)
  const port = await unusedPort()
  let controlPort = await unusedPort()
  while (controlPort === port || controlPort === 1884) controlPort = await unusedPort()
  t.after(async () => {
    try {
      const latest = JSON.parse(await fs.readFile(stateFile, 'utf8'))
      if (latest.listenerPid) {
        try { process.kill(latest.listenerPid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
        await waitForClosedPort(port)
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true })
    }
  })
  return {
    temp,
    stateFile,
    pluginState,
    fake,
    port,
    controlPort,
    logFile: path.join(logRoot, logInstance, 'operational.jsonl'),
    logInstance,
    logRoot,
  }
}

async function readFake(stateFile) {
  return JSON.parse(await fs.readFile(stateFile, 'utf8'))
}

async function writeFake(stateFile, state) {
  await fs.writeFile(stateFile, JSON.stringify(state))
}

async function readLogEvents(logFile) {
  const text = await fs.readFile(logFile, 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line))
}

async function runEnsure(
  { fake, stateFile, pluginState, port, controlPort, logRoot, logInstance },
  { includeLoggingIds = true } = {},
) {
  const env = {
    ...process.env,
    HERDR_BIN_PATH: fake,
    HERDR_PLUGIN_STATE_DIR: pluginState,
    FAKE_HERDR_STATE: stateFile,
    SYNAGENT_PORT: String(port),
    SYNAGENT_DB: '',
    SYNAGENT_ENSURE_PORT: String(controlPort),
    A4S_SYNAGENT_BUS_LOG_DIR: logRoot,
    XDG_STATE_HOME: path.join(pluginState, 'xdg-state'),
  }
  for (const name of ['A4S_SERVICE_INSTANCE_ID', 'A4S_OPERATION_ID', 'A4S_CORRELATION_ID']) delete env[name]
  if (includeLoggingIds) {
    env.A4S_SERVICE_INSTANCE_ID = logInstance
    env.A4S_OPERATION_ID = `${logInstance}-operation`
    env.A4S_CORRELATION_ID = `${logInstance}-correlation`
  }
  return exitWithOutput(spawn(process.execPath, [ENSURE], { env }))
}

function assertExactProcessInfoCalls(state) {
  const calls = state.calls.filter(args => args[0] === 'pane' && args[1] === 'process-info')
  assert.ok(calls.length > 0)
  for (const args of calls) assert.deepEqual(args.slice(0, 3), ['pane', 'process-info', '--pane'])
  for (const args of calls) assert.equal(args.length, 4)
}

test('Herdr ensure uses explicit workspace/process flags and is idempotent without focusing', async t => {
  const context = await fixture(t)
  const first = await runEnsure(context)
  assert.deepEqual(first, {
    code: 0,
    stdout: 'SYNAGENT BUS READY workspace=w-test pane=w-test:p-bus-1\n',
    stderr: '',
  })
  const second = await runEnsure(context)
  assert.deepEqual(second, {
    code: 0,
    stdout: 'SYNAGENT BUS READY workspace=w-test pane=w-test:p-bus-1\n',
    stderr: '',
  })

  const state = await readFake(context.stateFile)
  assert.equal(state.openCount, 1)
  assert.equal(state.workspaces.length, 1)
  assert.equal(state.tabs['w-test:t-bus-1'].label, 'Bus')
  assertExactProcessInfoCalls(state)

  const create = state.calls.find(args => args[0] === 'workspace' && args[1] === 'create')
  assert.deepEqual(create.slice(2), ['--cwd', os.homedir(), '--label', 'Synagent', '--no-focus'])
  const open = state.calls.find(args => args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open')
  assert.equal(open[open.indexOf('--workspace') + 1], 'w-test')
  assert.ok(open.includes('--no-focus'))
  assert.equal(open.includes('--target-pane'), false)
  assert.equal(open.includes('--cwd'), false)
  const forwarded = []
  for (let index = 0; index < open.length; index += 1) {
    if (open[index] === '--env') forwarded.push(open[index + 1])
  }
  assert.deepEqual(forwarded.sort(), [
    `A4S_CORRELATION_ID=${context.logInstance}-correlation`,
    `A4S_OPERATION_ID=${context.logInstance}-operation`,
    `A4S_SERVICE_INSTANCE_ID=${context.logInstance}`,
    `A4S_SYNAGENT_BUS_LOG_DIR=${context.logRoot}`,
    `SYNAGENT_PORT=${context.port}`,
    `XDG_STATE_HOME=${path.join(context.pluginState, 'xdg-state')}`,
  ].sort())
  assert.equal(forwarded.some(value => value.startsWith('FAKE_HERDR_STATE=')), false)
  assert.equal(forwarded.some(value => value.startsWith('HERDR_PLUGIN_STATE_DIR=')), false)

  const events = await readLogEvents(context.logFile)
  assert.deepEqual(events.map(event => event.event_name), [
    'herdr.ensure.started',
    'herdr.ensure.lock_acquired',
    'herdr.ensure.spawned',
    'herdr.ensure.ready',
    'herdr.ensure.started',
    'herdr.ensure.lock_acquired',
    'herdr.ensure.already_running',
    'herdr.ensure.ready',
  ])
})

test('Herdr ensure preserves the exact missing-configuration diagnostic', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-herdr-config-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const env = {
    ...process.env,
    A4S_SYNAGENT_BUS_LOG_DIR: path.join(temp, 'logs'),
    A4S_SERVICE_INSTANCE_ID: 'missing-config-test',
  }
  delete env.HERDR_BIN_PATH
  delete env.HERDR_PLUGIN_STATE_DIR
  const result = await exitWithOutput(spawn(process.execPath, [ENSURE], { env }))
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    stderr: '[synagent-bus ensure] HERDR_BIN_PATH is required\n',
  })
})

test('Herdr ensure generates and forwards one correlated identity when IDs are absent', async t => {
  const context = await fixture(t)
  const result = await runEnsure(context, { includeLoggingIds: false })
  assert.deepEqual(result, {
    code: 0,
    stdout: 'SYNAGENT BUS READY workspace=w-test pane=w-test:p-bus-1\n',
    stderr: '',
  })

  const state = await readFake(context.stateFile)
  const open = state.calls.find(args => args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open')
  const forwarded = {}
  for (let index = 0; index < open.length; index += 1) {
    if (open[index] !== '--env') continue
    const separator = open[index + 1].indexOf('=')
    forwarded[open[index + 1].slice(0, separator)] = open[index + 1].slice(separator + 1)
  }
  for (const name of ['A4S_SERVICE_INSTANCE_ID', 'A4S_OPERATION_ID', 'A4S_CORRELATION_ID']) {
    assert.match(forwarded[name], /^[A-Za-z0-9_.:-]+$/)
  }

  const logFile = path.join(
    context.logRoot,
    forwarded.A4S_SERVICE_INSTANCE_ID,
    'operational.jsonl',
  )
  let events = await readLogEvents(logFile)
  const spawned = events.find(event => event.event_name === 'herdr.ensure.spawned')
  const ensureReady = events.find(event => event.event_name === 'herdr.ensure.ready')
  assert.equal(spawned['resource.service.instance.id'], forwarded.A4S_SERVICE_INSTANCE_ID)
  assert.equal(spawned['attributes.a4s.operation_id'], forwarded.A4S_OPERATION_ID)
  assert.equal(spawned['attributes.a4s.correlation_id'], forwarded.A4S_CORRELATION_ID)
  assert.equal(ensureReady['a4s.protocol.channel'], 'stdout')
  assert.equal(ensureReady['a4s.logging.flush_status'], 'sync_requested')

  const broker = spawn(process.execPath, [BROKER, '0', '--db', path.join(context.temp, 'broker-db')], {
    env: { ...process.env, ...forwarded },
  })
  t.after(() => {
    if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGTERM')
  })
  const brokerExit = exitWithOutput(broker)
  await waitForOutput(broker, /BROKER READY/)
  broker.kill('SIGTERM')
  assert.equal((await brokerExit).code, 0)

  events = await readLogEvents(logFile)
  const brokerStarted = events.find(event => event.event_name === 'broker.started')
  const brokerReady = events.find(event => event.event_name === 'broker.ready')
  for (const event of [brokerStarted, brokerReady]) {
    assert.equal(event['resource.service.instance.id'], forwarded.A4S_SERVICE_INSTANCE_ID)
    assert.equal(event['attributes.a4s.operation_id'], forwarded.A4S_OPERATION_ID)
    assert.equal(event['attributes.a4s.correlation_id'], forwarded.A4S_CORRELATION_ID)
  }
})

test('Herdr ensure reuses one pre-existing Synagent workspace without touching unknown tabs', async t => {
  const context = await fixture(t, {
    workspaces: [{ workspace_id: 'w-test', label: 'Synagent', active_tab_id: 'w-test:t-user' }],
    tabs: {
      'w-test:t-user': { tab_id: 'w-test:t-user', workspace_id: 'w-test', label: 'User', pane_count: 1 },
    },
  })
  const result = await runEnsure(context)
  assert.equal(result.code, 0, result.stderr)
  const state = await readFake(context.stateFile)
  assert.equal(state.openCount, 1)
  assert.ok(state.tabs['w-test:t-user'])
  assert.equal(state.calls.some(args => args[0] === 'workspace' && args[1] === 'create'), false)
  assert.equal(state.calls.some(args => args[0] === 'tab' && args[1] === 'close'), false)
  const open = state.calls.find(args => args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open')
  assert.equal(open[open.indexOf('--workspace') + 1], 'w-test')
  assert.ok(open.includes('--no-focus'))
})

test('Herdr ensure fails closed when Synagent workspace ownership is ambiguous', async t => {
  const context = await fixture(t, {
    workspaces: [
      { workspace_id: 'w1', label: 'Synagent' },
      { workspace_id: 'w2', label: 'Synagent' },
    ],
  })
  const result = await runEnsure(context)
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    stderr: '[synagent-bus ensure] multiple Herdr workspaces are named Synagent\n',
  })
  assert.equal((await readFake(context.stateFile)).openCount, 0)
  const events = await readLogEvents(context.logFile)
  assert.deepEqual(events.map(event => event.event_name), [
    'herdr.ensure.started', 'herdr.ensure.lock_acquired', 'herdr.ensure.failed',
  ])
  const failure = events.at(-1)
  assert.equal(failure['error.code'], 'A4S_ENSURE_WORKSPACE_AMBIGUOUS')
  assert.equal(failure['error.source'], 'herdr.ensure')
  assert.equal(failure['error.retryable'], false)
  assert.equal(failure['error.phase'], 'workspace.validate')
})

test('Herdr ensure classifies invalid runtime state without raw state data', async t => {
  const context = await fixture(t)
  await fs.mkdir(context.pluginState, { recursive: true })
  await fs.writeFile(path.join(context.pluginState, 'runtime.json'), '{"unexpected":"value"}\n')
  const result = await runEnsure(context)
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    stderr: '[synagent-bus ensure] invalid runtime state\n',
  })
  const failure = (await readLogEvents(context.logFile)).at(-1)
  assert.equal(failure.event_name, 'herdr.ensure.failed')
  assert.equal(failure['error.code'], 'A4S_ENSURE_STATE_INVALID')
  assert.equal(failure['error.retryable'], false)
  assert.equal(failure['error.phase'], 'state.read')
  assert.doesNotMatch(JSON.stringify(failure), /unexpected|value/)
})

test('Herdr ensure classifies invalid ports and pane spawn failures', async t => {
  const invalidPort = await fixture(t)
  const portResult = await runEnsure({ ...invalidPort, port: 0 })
  assert.deepEqual(portResult, {
    code: 1,
    stdout: '',
    stderr: '[synagent-bus ensure] SYNAGENT_PORT must be a fixed port from 1 to 65535 for Herdr verification\n',
  })
  let failure = (await readLogEvents(invalidPort.logFile)).at(-1)
  assert.equal(failure['error.code'], 'A4S_ENSURE_PORT_INVALID')
  assert.equal(failure['error.retryable'], false)
  assert.equal(failure['error.phase'], 'arguments')

  const spawnFailure = await fixture(t, { failOpen: true })
  const spawnResult = await runEnsure(spawnFailure)
  assert.equal(spawnResult.code, 1)
  failure = (await readLogEvents(spawnFailure.logFile)).at(-1)
  assert.equal(failure['error.code'], 'A4S_ENSURE_HERDR_COMMAND_FAILED')
  assert.equal(failure['error.retryable'], false)
  assert.equal(failure['error.phase'], 'pane.open')
  assert.doesNotMatch(JSON.stringify(failure), /pane open failed/)
})

test('Herdr taxonomy distinguishes command failure from executable unavailability', async t => {
  const commandFailure = await fixture(t, { failWorkspaceList: true })
  const commandResult = await runEnsure(commandFailure)
  assert.deepEqual(commandResult, {
    code: 1,
    stdout: '',
    stderr: '[synagent-bus ensure] Herdr command failed (workspace list): {"error":{"message":"workspace list failed"}}\n',
  })
  let failure = (await readLogEvents(commandFailure.logFile)).at(-1)
  assert.equal(failure['error.code'], 'A4S_ENSURE_HERDR_COMMAND_FAILED')
  assert.equal(failure['error.phase'], 'workspace.list')
  assert.doesNotMatch(JSON.stringify(failure), /workspace list failed/)

  const unavailable = await fixture(t)
  const unavailableResult = await runEnsure({
    ...unavailable,
    fake: path.join(unavailable.temp, 'missing-herdr'),
  })
  assert.equal(unavailableResult.code, 1)
  failure = (await readLogEvents(unavailable.logFile)).at(-1)
  assert.equal(failure['error.code'], 'A4S_ENSURE_HERDR_UNAVAILABLE')
  assert.equal(failure['error.phase'], 'workspace.list')
  assert.equal(failure['error.retryable'], true)
})

test('Herdr ensure repairs its recorded stopped plugin pane and tab only', async t => {
  const context = await fixture(t)
  const first = await runEnsure(context)
  assert.equal(first.code, 0, first.stderr)
  let state = await readFake(context.stateFile)
  const oldPid = state.listenerPid
  process.kill(oldPid, 'SIGTERM')
  await waitForClosedPort(context.port)
  state.listenerPid = null
  state.panes['w-test:p-bus-1'].running = false
  await writeFake(context.stateFile, state)

  const repaired = await runEnsure(context)
  assert.equal(repaired.code, 0, repaired.stderr)
  state = await readFake(context.stateFile)
  assert.equal(state.openCount, 2)
  assert.equal(state.closeCount, 1)
  assert.equal(state.panes['w-test:p-bus-1'], undefined)
  assert.equal(state.tabs['w-test:t-bus-1'], undefined)
  assert.ok(state.panes['w-test:p-bus-2'])
  assert.ok(state.calls.some(args => args.join(' ') === 'plugin pane close w-test:p-bus-1'))
  assertExactProcessInfoCalls(state)
})

function startLockWorker(port, { attempts = 1, delayMs = 20, holdMs = -1, logFile = '' } = {}) {
  return fork(LOCK_WORKER, [
    String(port), String(attempts), String(delayMs), String(holdMs), logFile,
  ], { silent: true })
}

function waitForWorkerMessage(worker, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for worker ${type}`)), timeoutMs)
    const onMessage = message => {
      if (message?.type !== type) return
      clearTimeout(timer)
      worker.off('exit', onExit)
      resolve(message)
    }
    const onExit = code => {
      clearTimeout(timer)
      worker.off('message', onMessage)
      reject(new Error(`lock worker exited ${code} before ${type}`))
    }
    worker.on('message', onMessage)
    worker.once('exit', onExit)
  })
}

function waitForWorkerExit(worker) {
  return new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })))
}

async function releaseWorker(worker) {
  const released = waitForWorkerMessage(worker, 'released')
  const exited = waitForWorkerExit(worker)
  worker.send({ type: 'release' })
  await released
  assert.deepEqual(await exited, { code: 0, signal: null })
}

async function killWorker(worker) {
  const exited = waitForWorkerExit(worker)
  worker.kill('SIGKILL')
  const result = await exited
  assert.equal(result.signal, 'SIGKILL')
}

async function assertControlPortBindable(port) {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function lockFixture(t, prefix) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const workers = new Set()
  let controlPort = await unusedPort()
  while (controlPort === 1884) controlPort = await unusedPort()
  t.after(async () => {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
    }
    await fs.rm(temp, { recursive: true, force: true })
  })
  return {
    controlPort,
    track(worker) { workers.add(worker); return worker },
    temp,
  }
}

test('multiprocess TCP mutex preserves a long-lived owner and rejects every contender', { timeout: 10_000 }, async t => {
  const fixture = await lockFixture(t, 'synagent-mutex-live-')
  const owner = fixture.track(startLockWorker(fixture.controlPort))
  await waitForWorkerMessage(owner, 'acquired')

  // Longer than the old filesystem stale/heartbeat threshold: kernel
  // ownership must remain exclusive without any timeout-based takeover.
  await new Promise(resolve => setTimeout(resolve, 2_250))
  const contenders = Array.from({ length: 6 }, () => fixture.track(startLockWorker(
    fixture.controlPort, { attempts: 5, delayMs: 20 },
  )))
  const failures = await Promise.all(contenders.map(worker => waitForWorkerMessage(worker, 'failed')))
  assert.ok(failures.every(failure => failure.code === 'EADDRINUSE'))
  assert.ok(failures.every(failure => failure.a4sCode === 'A4S_ENSURE_LOCK_BUSY'))

  await releaseWorker(owner)
  await assertControlPortBindable(fixture.controlPort)
  const successor = fixture.track(startLockWorker(fixture.controlPort))
  await waitForWorkerMessage(successor, 'acquired')
  await releaseWorker(successor)
})

test('multiprocess TCP mutex is immediately recoverable after repeated SIGKILL', { timeout: 10_000 }, async t => {
  const fixture = await lockFixture(t, 'synagent-mutex-crash-')
  const first = fixture.track(startLockWorker(fixture.controlPort))
  await waitForWorkerMessage(first, 'acquired')
  await killWorker(first)

  const recoveredThenCrashed = fixture.track(startLockWorker(
    fixture.controlPort, { attempts: 100, delayMs: 10 },
  ))
  await waitForWorkerMessage(recoveredThenCrashed, 'acquired')
  await killWorker(recoveredThenCrashed)

  const finalOwner = fixture.track(startLockWorker(
    fixture.controlPort, { attempts: 100, delayMs: 10 },
  ))
  await waitForWorkerMessage(finalOwner, 'acquired')
  await releaseWorker(finalOwner)
  await assertControlPortBindable(fixture.controlPort)
})

test('multiprocess contenders after crash never overlap TCP-mutex critical sections', { timeout: 10_000 }, async t => {
  const fixture = await lockFixture(t, 'synagent-mutex-contention-')
  const seed = fixture.track(startLockWorker(fixture.controlPort))
  await waitForWorkerMessage(seed, 'acquired')
  await killWorker(seed)

  const logFile = path.join(fixture.temp, 'critical.log')
  const contenders = Array.from({ length: 8 }, () => fixture.track(startLockWorker(
    fixture.controlPort, { attempts: 200, delayMs: 10, holdMs: 80, logFile },
  )))
  const exits = await Promise.all(contenders.map(waitForWorkerExit))
  assert.ok(exits.every(result => result.code === 0 && result.signal === null))

  const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n')
  let active = 0
  let maximumActive = 0
  for (const line of lines) {
    if (line.startsWith('ENTER ')) active += 1
    if (line.startsWith('EXIT ')) active -= 1
    maximumActive = Math.max(maximumActive, active)
    assert.ok(active >= 0)
  }
  assert.equal(lines.filter(line => line.startsWith('ENTER ')).length, contenders.length)
  assert.equal(active, 0)
  assert.equal(maximumActive, 1)
  await assertControlPortBindable(fixture.controlPort)
})
