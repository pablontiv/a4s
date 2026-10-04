'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const ENSURE = path.join(__dirname, '..', 'herdr', 'ensure.cjs')

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
  const workspace = { workspace_id: 'w-test', label: 'Synagent', active_tab_id: 'w-test:t1' }
  state.workspaces.push(workspace)
  state.tabs['w-test:t1'] = { tab_id: 'w-test:t1', workspace_id: 'w-test', label: 'shell' }
  ok({ type: 'workspace_created', workspace, tab: state.tabs['w-test:t1'], root_pane: { pane_id: 'w-test:p1' } })
} else if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open') {
  state.openCount += 1
  state.tabs['w-test:t2'] = { tab_id: 'w-test:t2', workspace_id: 'w-test', label: 'Bus' }
  state.panes['w-test:p2'] = { pane_id: 'w-test:p2', tab_id: 'w-test:t2', workspace_id: 'w-test' }
  if (!state.listenerPid) {
    const child = spawn(process.execPath, ['-e', \`
      const net = require('node:net');
      const server = net.createServer(socket => socket.once('data', () => socket.end(Buffer.from([0x20, 0x02, 0x00, 0x00]))));
      server.listen(Number(process.env.SYNAGENT_PORT), '127.0.0.1');
    \`], { detached: true, stdio: 'ignore', env: process.env })
    child.unref()
    state.listenerPid = child.pid
  }
  ok({ type: 'plugin_pane_opened', plugin_pane: { plugin_id: 'a4s.synagent-bus', entrypoint: 'bus', pane: state.panes['w-test:p2'] } })
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
  state.panes[args[2]] ? ok({ type: 'pane_process_info', process_info: { foreground_processes: [{ cmdline: 'node broker.cjs' }] } }) : fail('pane missing')
} else {
  fail('unexpected command: ' + args.join(' '))
}
`, { mode: 0o755 })
  return fake
}

async function runEnsure(fake, stateFile, pluginState, port) {
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

test('Herdr ensure uses an explicit workspace, is basically idempotent, and does not focus', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-herdr-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const stateFile = path.join(temp, 'fake-state.json')
  const pluginState = path.join(temp, 'plugin-state')
  await fs.writeFile(stateFile, JSON.stringify({
    workspaces: [], tabs: {}, panes: {}, calls: [], openCount: 0, listenerPid: null,
  }))
  const fake = await makeFakeHerdr(temp)
  const port = await unusedPort()

  const first = await runEnsure(fake, stateFile, pluginState, port)
  assert.equal(first.code, 0, first.stderr)
  const second = await runEnsure(fake, stateFile, pluginState, port)
  assert.equal(second.code, 0, second.stderr)

  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  t.after(() => { if (state.listenerPid) process.kill(state.listenerPid, 'SIGTERM') })
  assert.equal(state.openCount, 1)
  assert.equal(state.workspaces.length, 1)
  assert.equal(state.workspaces[0].label, 'Synagent')
  assert.equal(state.tabs['w-test:t2'].label, 'Bus')

  const create = state.calls.find(args => args[0] === 'workspace' && args[1] === 'create')
  assert.deepEqual(create.slice(2), ['--cwd', os.homedir(), '--label', 'Synagent', '--no-focus'])
  const open = state.calls.find(args => args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open')
  assert.equal(open[open.indexOf('--workspace') + 1], 'w-test')
  assert.ok(open.includes('--no-focus'))
  assert.equal(open.includes('--target-pane'), false)
})

test('Herdr ensure fails closed when Synagent workspace ownership is ambiguous', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synagent-herdr-ambiguous-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const stateFile = path.join(temp, 'fake-state.json')
  await fs.writeFile(stateFile, JSON.stringify({
    workspaces: [
      { workspace_id: 'w1', label: 'Synagent' },
      { workspace_id: 'w2', label: 'Synagent' },
    ],
    tabs: {}, panes: {}, calls: [], openCount: 0, listenerPid: null,
  }))
  const fake = await makeFakeHerdr(temp)
  const result = await runEnsure(fake, stateFile, path.join(temp, 'plugin-state'), await unusedPort())
  assert.equal(result.code, 1)
  assert.match(result.stderr, /multiple Herdr workspaces/)
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  assert.equal(state.openCount, 0)
})
