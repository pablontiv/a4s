// Smoke test de los bridges reales del adaptador Claude, ejecutándolos como
// procesos igual que en runtime contra un broker Aedes efímero. El broker
// instalable y sus pruebas viven en el workspace @a4s/synagent-bus.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { Aedes } = require('aedes')
const BRIDGE = new URL('../adapters/claude/bridge/', import.meta.url).pathname

function waitFor(
  proc: ChildProcessWithoutNullStreams,
  stream: 'stdout' | 'stderr',
  re: RegExp,
  timeoutMs = 10000,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let acc = ''
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${re} en ${stream}; visto: ${acc.slice(0, 300)}`)), timeoutMs)
    proc[stream].setEncoding('utf8')
    const onData = (d: string) => {
      acc += d
      const m = acc.match(re)
      if (m) {
        clearTimeout(timer)
        proc[stream].off('data', onData)
        resolve(m)
      }
    }
    proc[stream].on('data', onData)
  })
}

test('scripts de Claude: bridges arrancan y hacen round-trip real', async t => {
  const broker = await Aedes.createBroker({})
  const server = net.createServer(broker.handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const url = `mqtt://127.0.0.1:${port}`
  const procs: ChildProcessWithoutNullStreams[] = []
  t.after(async () => {
    for (const process of procs) process.kill('SIGKILL')
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(() => resolve()))
  })

  const sub = spawn('node', [join(BRIDGE, 'bridge-sub.cjs'), 'claude', url]) as ChildProcessWithoutNullStreams
  procs.push(sub)
  // bridge-sub loguea la suscripción a stderr; esperamos a estar suscritos.
  await waitFor(sub, 'stderr', /suscrito a a4s\/inbox\/claude/)

  const gotLine = waitFor(sub, 'stdout', /\{.*"id"\s*:\s*"scripts-1".*\}/)

  const pub = spawn('node', [
    join(BRIDGE, 'bridge-pub.cjs'), 'claude', 'hola desde scripts.test', 'pi', 'prompt', 'scripts-1', '', url,
  ]) as ChildProcessWithoutNullStreams
  procs.push(pub)
  const pubExit: number = await new Promise((res) => pub.on('exit', (c) => res(c ?? -1)))
  assert.equal(pubExit, 0, 'bridge-pub.cjs debe salir 0 (PUBACK)')

  const line = (await gotLine)[0]
  const msg = JSON.parse(line) as { id: string; to: string; from: string; kind: string; body: string }
  assert.equal(msg.id, 'scripts-1')
  assert.equal(msg.to, 'claude')
  assert.equal(msg.from, 'pi')
  assert.equal(msg.kind, 'prompt')
  assert.equal(msg.body, 'hola desde scripts.test')
})

// Guard estructural (review LOW-1): register.ts resuelve sus bridges como
// `${$.plugin.root}/bridge/bridge-{sub,pub}.cjs`, donde $.plugin.root es el dir
// del plugin (adapters/claude). Si alguien renombra/mueve `bridge/`, los otros
// tests podrían seguir pasando con su propia ruta mientras el adaptador
// instalado falla en silencio. Este test ancla esa suposición.
test('estructura: los bridges existen donde register.ts los resuelve', () => {
  const pluginRoot = new URL('../adapters/claude/', import.meta.url).pathname
  for (const rel of ['bridge/bridge-sub.cjs', 'bridge/bridge-pub.cjs']) {
    assert.ok(existsSync(join(pluginRoot, rel)), `falta ${rel} bajo $.plugin.root`)
  }
})

test('marketplace: el núcleo Claude carga al copiar solo el plugin', async t => {
  const source = new URL('../adapters/claude/', import.meta.url).pathname
  const temp = await mkdtemp(join(tmpdir(), 'synagent-claude-plugin-'))
  const installed = join(temp, 'synagent-adapter-mqtt')
  t.after(() => rm(temp, { recursive: true, force: true }))
  await cp(source, installed, { recursive: true })

  const adapter = await import(pathToFileURL(join(installed, 'hooks/adapter.ts')).href)
  assert.equal(adapter.toCanonical('hola', { id: 'installed-1', ts: 1 }).to, 'pi')
})
