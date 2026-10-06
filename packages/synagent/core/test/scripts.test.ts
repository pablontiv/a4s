// Smoke test de los bridges v1 del adaptador Claude, ejecutándolos como
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
import { connect, type IClientOptions, type MqttClient } from 'mqtt'

const require = createRequire(import.meta.url)
const { Aedes } = require('aedes')
const BRIDGE = new URL('../adapters/claude/bridge/', import.meta.url).pathname

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout esperando fin del proceso')), timeoutMs)
    proc.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
  })
}

function openMqtt(url: string, options: IClientOptions): Promise<{ client: MqttClient; sessionPresent: boolean }> {
  return new Promise((resolve, reject) => {
    const client = connect(url, { ...options, reconnectPeriod: 0 })
    const onError = (error: Error) => reject(error)
    client.once('error', onError)
    client.once('connect', (packet) => {
      client.off('error', onError)
      resolve({ client, sessionPresent: packet.sessionPresent })
    })
  })
}

function subscribe(client: MqttClient, topic: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, (error) => error ? reject(error) : resolve())
  })
}

function endMqtt(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.end(false, {}, (error) => error ? reject(error) : resolve())
  })
}

function waitFor(
  proc: ChildProcessWithoutNullStreams,
  stream: 'stdout' | 'stderr',
  re: RegExp,
  timeoutMs = 10000,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let acc = ''
    const timer = setTimeout(
      () => reject(new Error(`timeout esperando ${re} en ${stream}; visto: ${acc.slice(0, 300)}`)),
      timeoutMs,
    )
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

// Espera VARIOS patrones en un mismo stream sin asumir ORDEN de llegada: acumula
// con un único listener y resuelve cuando todos aparecieron. (Dos waitFor
// secuenciales se perderían un patrón ya emitido antes de adjuntar el segundo
// listener — p. ej. el cliente transient suele suscribirse antes que el durable.)
function waitForAll(
  proc: ChildProcessWithoutNullStreams,
  stream: 'stdout' | 'stderr',
  patterns: readonly RegExp[],
  timeoutMs = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let acc = ''
    const pending = new Set(patterns)
    const timer = setTimeout(
      () => reject(new Error(`timeout esperando ${[...pending]} en ${stream}; visto: ${acc.slice(0, 300)}`)),
      timeoutMs,
    )
    proc[stream].setEncoding('utf8')
    const onData = (d: string) => {
      acc += d
      for (const re of [...pending]) if (re.test(acc)) pending.delete(re)
      if (pending.size === 0) {
        clearTimeout(timer)
        proc[stream].off('data', onData)
        resolve()
      }
    }
    proc[stream].on('data', onData)
  })
}

test('scripts de Claude v1: bridges arrancan y hacen round-trip real', async (t) => {
  const broker = await Aedes.createBroker({})
  const server = net.createServer(broker.handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const url = `mqtt://127.0.0.1:${port}`
  const procs: ChildProcessWithoutNullStreams[] = []
  t.after(async () => {
    for (const process of procs) process.kill('SIGKILL')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  })

  // Lanzar bridge-sub con dos clientes: durable (directo) y transient (broadcast)
  const sub = spawn('node', [
    join(BRIDGE, 'bridge-sub.cjs'),
    '--url', url,
    '--durable-id', 'd1',
    '--durable', 'synagent/v1/a4s/claude-1',
    '--transient-id', 't1',
    '--transient', 'synagent/v1/a4s/all', 'synagent/v1/all',
  ]) as ChildProcessWithoutNullStreams
  procs.push(sub)

  // bridge-sub loguea las suscripciones a stderr; esperamos a AMBAS sin asumir
  // orden (durable/transient se suscriben en paralelo).
  await waitForAll(sub, 'stderr', [/suscrito durable:/, /suscrito transient:/])

  // Esperamos a recibir un mensaje canónico en stdout
  const gotLine = waitFor(sub, 'stdout', /\{.*"id"\s*:\s*"v1-test-1".*\}/)

  // Publicar un mensaje canónico al topic directo de Claude
  const payload = JSON.stringify({
    id: 'v1-test-1',
    from: 'a4s/pi-1',
    to: 'a4s/claude-1',
    kind: 'prompt',
    body: 'hola desde scripts.test (v1)',
    ts: Date.now(),
  })

  const pub = spawn('node', [
    join(BRIDGE, 'bridge-pub.cjs'),
    'synagent/v1/a4s/claude-1',
    payload,
    url,
  ]) as ChildProcessWithoutNullStreams
  procs.push(pub)
  const pubExit: number = await new Promise((res) => pub.on('exit', (c) => res(c ?? -1)))
  assert.equal(pubExit, 0, 'bridge-pub.cjs debe salir 0 (PUBACK)')

  const line = (await gotLine)[0]
  const msg = JSON.parse(line) as { id: string; to: string; from: string; kind: string; body: string }
  assert.equal(msg.id, 'v1-test-1')
  assert.equal(msg.to, 'a4s/claude-1')
  assert.equal(msg.from, 'a4s/pi-1')
  assert.equal(msg.kind, 'prompt')
  assert.equal(msg.body, 'hola desde scripts.test (v1)')
})

test('scripts de Claude v1: la migración elimina la sesión durable histórica con su clientId exacto', async (t) => {
  const broker = await Aedes.createBroker({})
  const server = net.createServer(broker.handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const url = `mqtt://127.0.0.1:${port}`
  const procs: ChildProcessWithoutNullStreams[] = []
  t.after(async () => {
    for (const process of procs) process.kill('SIGKILL')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  })

  // Recrea el estado que dejó el adaptador histórico: sesión clean=false y
  // suscripción legacy persistida bajo el clientId fijo.
  const seeded = await openMqtt(url, { clientId: 'synagent-legacy-claude', clean: false })
  assert.equal(seeded.sessionPresent, false)
  await subscribe(seeded.client, 'a4s/inbox/claude')
  await endMqtt(seeded.client)

  // clean=true con EL MISMO clientId descarta en el broker toda la sesión
  // durable. El proceso es one-shot y repetirlo es seguro.
  for (let attempt = 0; attempt < 2; attempt++) {
    const retire = spawn('node', [
      join(BRIDGE, 'bridge-sub.cjs'),
      '--url', url,
      '--retire-id', 'synagent-legacy-claude',
    ]) as ChildProcessWithoutNullStreams
    procs.push(retire)
    const exited = waitForExit(retire)
    await waitFor(retire, 'stderr', /sesión durable retirada: synagent-legacy-claude/)
    assert.equal(await exited, 0, `migración ${attempt + 1} debe cerrar limpiamente`)
  }

  // Al reconectar como sesión durable no debe existir estado previo: prueba que
  // no solo se desuscribió con el clientId v1 actual, sino que se eliminó la
  // sesión asociada al clientId histórico correcto.
  const probe = await openMqtt(url, { clientId: 'synagent-legacy-claude', clean: false })
  assert.equal(probe.sessionPresent, false, 'la sesión histórica ya no existe en el broker')
  await endMqtt(probe.client)
})

test('scripts de Claude v1: retiro legacy termina sin retries si el broker está ausente', async (t) => {
  const reservation = net.createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))

  const retire = spawn('node', [
    join(BRIDGE, 'bridge-sub.cjs'),
    '--url', `mqtt://127.0.0.1:${port}`,
    '--retire-id', 'synagent-legacy-claude',
  ]) as ChildProcessWithoutNullStreams
  t.after(() => retire.kill('SIGKILL'))
  const exited = waitForExit(retire)
  await waitFor(retire, 'stderr', /no se pudo retirar sesión durable synagent-legacy-claude/)
  assert.notEqual(await exited, 0, 'ausencia del broker se reporta sin dejar proceso persistente')
})

test('scripts de Claude v1: bridge-sub soporta clientes durable + transient', async (t) => {
  const broker = await Aedes.createBroker({})
  const server = net.createServer(broker.handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const url = `mqtt://127.0.0.1:${port}`
  const procs: ChildProcessWithoutNullStreams[] = []
  t.after(async () => {
    for (const process of procs) process.kill('SIGKILL')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  })

  // bridge-sub con dos clientes: durable (directo) + transient (broadcast)
  const sub = spawn('node', [
    join(BRIDGE, 'bridge-sub.cjs'),
    '--url', url,
    '--durable-id', 'd-test-2',
    '--durable', 'synagent/v1/a4s/test-2',
    '--transient-id', 't-test-2',
    '--transient', 'synagent/v1/a4s/all',
  ]) as ChildProcessWithoutNullStreams
  procs.push(sub)

  // Esperar a que AMBOS clientes estén suscritos antes de publicar: el broadcast
  // va al transient (clean=true, online-only), que debe estar activo o se pierde.
  await waitForAll(sub, 'stderr', [/suscrito durable:/, /suscrito transient:/], 15000)

  // Preparar dos esperas en paralelo: una para mensaje directo, otra para broadcast
  const gotDirect = waitFor(sub, 'stdout', /\{.*"id"\s*:\s*"direct-msg".*\}/)
  const gotBroadcast = waitFor(sub, 'stdout', /\{.*"id"\s*:\s*"broadcast-msg".*\}/)

  // Publicar al topic directo (durable)
  const directPayload = JSON.stringify({
    id: 'direct-msg',
    from: 'a4s/other-1',
    to: 'a4s/test-2',
    kind: 'prompt',
    body: 'msg directo',
    ts: Date.now(),
  })

  const pub1 = spawn('node', [
    join(BRIDGE, 'bridge-pub.cjs'),
    'synagent/v1/a4s/test-2',
    directPayload,
    url,
  ]) as ChildProcessWithoutNullStreams
  procs.push(pub1)
  const exit1: number = await new Promise((resolve) => pub1.on('exit', (code) => resolve(code ?? 0)))
  assert.equal(exit1, 0, 'bridge-pub directo debe salir 0')

  // Publicar al topic de broadcast de proyecto (transient)
  const broadcastPayload = JSON.stringify({
    id: 'broadcast-msg',
    from: 'a4s/other-1',
    to: 'a4s/all',
    kind: 'notify',
    body: 'msg broadcast',
    ts: Date.now(),
  })

  const pub2 = spawn('node', [
    join(BRIDGE, 'bridge-pub.cjs'),
    'synagent/v1/a4s/all',
    broadcastPayload,
    url,
  ]) as ChildProcessWithoutNullStreams
  procs.push(pub2)
  const exit2: number = await new Promise((resolve) => pub2.on('exit', (code) => resolve(code ?? 0)))
  assert.equal(exit2, 0, 'bridge-pub broadcast debe salir 0')

  // Verificar que ambos mensajes llegaron
  const directLine = (await gotDirect)[0]
  const directMsg = JSON.parse(directLine) as { id: string; body: string }
  assert.equal(directMsg.id, 'direct-msg')
  assert.equal(directMsg.body, 'msg directo')

  const broadcastLine = (await gotBroadcast)[0]
  const broadcastMsg = JSON.parse(broadcastLine) as { id: string; body: string }
  assert.equal(broadcastMsg.id, 'broadcast-msg')
  assert.equal(broadcastMsg.body, 'msg broadcast')
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

test('marketplace: el núcleo Claude v1 carga al copiar solo el plugin', async (t) => {
  const source = new URL('../adapters/claude/', import.meta.url).pathname
  const temp = await mkdtemp(join(tmpdir(), 'synagent-claude-plugin-v1-'))
  const installed = join(temp, 'synagent-adapter-mqtt')
  t.after(() => rm(temp, { recursive: true, force: true }))
  await cp(source, installed, { recursive: true })

  const adapter = await import(pathToFileURL(join(installed, 'hooks/adapter.ts')).href)

  // Verificar que la copia tiene el protocolo v1
  assert.ok(adapter.isAddress)
  assert.ok(adapter.toTopic)
  assert.equal(adapter.toTopic('a4s/claude-1'), 'synagent/v1/a4s/claude-1')
  assert.equal(adapter.toTopic('a4s/all'), 'synagent/v1/a4s/all')
  assert.equal(adapter.toTopic('all'), 'synagent/v1/all')
})
