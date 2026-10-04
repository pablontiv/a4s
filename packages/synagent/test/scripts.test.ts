// Smoke test de los SCRIPTS reales del bus (broker.cjs + bridge-sub.cjs +
// bridge-pub.cjs), ejecutándolos como procesos igual que en runtime. Esto
// cubre el modo de carga (ESM/CJS) y el round-trip real, que bus.test.ts no
// ejercita porque construye su propio broker en memoria.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const BUS = new URL('../bus/', import.meta.url).pathname

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

test('scripts del bus: broker.cjs + bridges arrancan y hacen round-trip real', async () => {
  const db = await mkdtemp(join(tmpdir(), 'synagent-scripts-'))
  const broker = spawn('node', [join(BUS, 'broker.cjs'), '0', db]) as ChildProcessWithoutNullStreams
  const procs: ChildProcessWithoutNullStreams[] = [broker]

  after(async () => {
    for (const p of procs) p.kill('SIGKILL')
    await rm(db, { recursive: true, force: true })
  })

  // El broker imprime el puerto REAL escuchado (arrancamos con 0 = efímero).
  const ready = await waitFor(broker, 'stdout', /BROKER READY :(\d+)/)
  const port = ready[1]
  const url = `mqtt://127.0.0.1:${port}`

  const sub = spawn('node', [join(BUS, 'bridge-sub.cjs'), 'claude', url]) as ChildProcessWithoutNullStreams
  procs.push(sub)
  // bridge-sub loguea la suscripción a stderr; esperamos a estar suscritos.
  await waitFor(sub, 'stderr', /suscrito a a4s\/inbox\/claude/)

  const gotLine = waitFor(sub, 'stdout', /\{.*"id"\s*:\s*"scripts-1".*\}/)

  const pub = spawn('node', [
    join(BUS, 'bridge-pub.cjs'), 'claude', 'hola desde scripts.test', 'pi', 'prompt', 'scripts-1', '', url,
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
