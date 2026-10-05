'use strict'

const assert = require('node:assert/strict')
const { fork, spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const ENSURE = path.join(__dirname, '..', 'herdr', 'ensure.cjs')
const LOCK_WORKER = path.join(__dirname, 'lock-worker.cjs')
const LOCK_STALE_MS = 2_000
const LOCK_UPDATE_MS = 1_000

function exitWithOutput(proc) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    proc.once('exit', code => resolve({ code, stdout, stderr }))
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
  ok({ type: 'workspace_list', workspaces: state.workspaces })
} else if (args[0] === 'workspace' && args[1] === 'create') {
  const workspace = { workspace_id: 'w-test', label: 'Synagent', active_tab_id: 'w-test:t-root' }
  state.workspaces.push(workspace)
  state.tabs['w-test:t-root'] = { tab_id: 'w-test:t-root', workspace_id: 'w-test', label: 'shell', pane_count: 1 }
  ok({ type: 'workspace_created', workspace, tab: state.tabs['w-test:t-root'], root_pane: { pane_id: 'w-test:p-root' } })
} else if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open') {
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
  const state = {
    workspaces: [], tabs: {}, panes: {}, calls: [], openCount: 0, closeCount: 0, listenerPid: null,
    ...initial,
  }
  await fs.writeFile(stateFile, JSON.stringify(state))
  const fake = await makeFakeHerdr(temp)
  const port = await unusedPort()
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
  return { temp, stateFile, pluginState, fake, port }
}

async function readFake(stateFile) {
  return JSON.parse(await fs.readFile(stateFile, 'utf8'))
}

async function writeFake(stateFile, state) {
  await fs.writeFile(stateFile, JSON.stringify(state))
}

async function runEnsure({ fake, stateFile, pluginState, port }) {
  return exitWithOutput(spawn(process.execPath, [ENSURE], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: fake,
      HERDR_PLUGIN_STATE_DIR: pluginState,
      FAKE_HERDR_STATE: stateFile,
      SYNAGENT_PORT: String(port),
    },
  }))
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
  assert.equal(first.code, 0, first.stderr)
  const second = await runEnsure(context)
  assert.equal(second.code, 0, second.stderr)

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
  assert.equal(result.code, 1)
  assert.match(result.stderr, /multiple Herdr workspaces/)
  assert.equal((await readFake(context.stateFile)).openCount, 0)
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

function startLockWorker(target, { retries = 0, holdMs = -1, logFile = '' } = {}) {
  return fork(LOCK_WORKER, [
    target, String(LOCK_STALE_MS), String(LOCK_UPDATE_MS), String(retries), String(holdMs), logFile,
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

async function lockFixture(t, prefix) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const workers = new Set()
  t.after(async () => {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
    }
    await fs.rm(temp, { recursive: true, force: true })
  })
  return {
    target: path.join(temp, 'ensure'),
    track(worker) { workers.add(worker); return worker },
    temp,
  }
}

test('multiprocess lock preserves a live owner and rejects every contender', async t => {
  const fixture = await lockFixture(t, 'synagent-lock-live-')
  const owner = fixture.track(startLockWorker(fixture.target))
  await waitForWorkerMessage(owner, 'acquired')

  const contenders = Array.from({ length: 6 }, () => fixture.track(startLockWorker(fixture.target)))
  const failures = await Promise.all(contenders.map(worker => waitForWorkerMessage(worker, 'failed')))
  assert.ok(failures.every(failure => failure.code === 'ELOCKED'))
  assert.equal((await fs.stat(`${fixture.target}.lock`)).isDirectory(), true)

  await releaseWorker(owner)
  const successor = fixture.track(startLockWorker(fixture.target))
  await waitForWorkerMessage(successor, 'acquired')
  await releaseWorker(successor)
})

test('multiprocess lock recovers after SIGKILL, including a recovered owner crashing', { timeout: 20_000 }, async t => {
  const fixture = await lockFixture(t, 'synagent-lock-crash-')
  const first = fixture.track(startLockWorker(fixture.target))
  await waitForWorkerMessage(first, 'acquired')
  await killWorker(first)

  const tooEarly = fixture.track(startLockWorker(fixture.target))
  assert.equal((await waitForWorkerMessage(tooEarly, 'failed')).code, 'ELOCKED')
  await new Promise(resolve => setTimeout(resolve, LOCK_STALE_MS + 250))

  const recoveredThenCrashed = fixture.track(startLockWorker(fixture.target, { retries: 150 }))
  await waitForWorkerMessage(recoveredThenCrashed, 'acquired')
  await killWorker(recoveredThenCrashed)

  const stillProtected = fixture.track(startLockWorker(fixture.target))
  assert.equal((await waitForWorkerMessage(stillProtected, 'failed')).code, 'ELOCKED')
  await new Promise(resolve => setTimeout(resolve, LOCK_STALE_MS + 250))

  const finalOwner = fixture.track(startLockWorker(fixture.target, { retries: 150 }))
  await waitForWorkerMessage(finalOwner, 'acquired')
  await releaseWorker(finalOwner)
})

test('multiprocess stale contention never overlaps critical sections', { timeout: 20_000 }, async t => {
  const fixture = await lockFixture(t, 'synagent-lock-contention-')
  const seed = fixture.track(startLockWorker(fixture.target))
  await waitForWorkerMessage(seed, 'acquired')
  await killWorker(seed)
  await new Promise(resolve => setTimeout(resolve, LOCK_STALE_MS + 250))

  const logFile = path.join(fixture.temp, 'critical.log')
  const contenders = Array.from({ length: 8 }, () => fixture.track(startLockWorker(
    fixture.target, { retries: 100, holdMs: 80, logFile },
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
})
