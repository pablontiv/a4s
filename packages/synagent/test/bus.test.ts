// Prueba del bus: arranca un broker aedes efímero en memoria y verifica el
// round-trip pub/sub sobre a4s/inbox/<address> (QoS1) y el addressing (un
// suscriptor solo recibe lo dirigido a su inbox). Usa los providers MQTT reales
// (aedes + mqtt) vía require, igual que los scripts del bus en runtime.
import { createRequire } from 'node:module'
import net from 'node:net'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const require = createRequire(import.meta.url)
const { Aedes } = require('aedes')
const mqtt = require('mqtt')

interface Started { broker: any; server: net.Server; url: string }

async function startBroker(): Promise<Started> {
  const broker = await Aedes.createBroker({})
  const server = net.createServer(broker.handle)
  await new Promise<void>((res) => server.listen(0, res))
  const port = (server.address() as { port: number }).port
  return { broker, server, url: `mqtt://127.0.0.1:${port}` }
}

function connect(url: string, clientId: string): Promise<any> {
  return new Promise((res, rej) => {
    const c = mqtt.connect(url, { clientId, clean: true })
    c.on('connect', () => res(c))
    c.on('error', rej)
  })
}

test('bus: round-trip pub/sub y addressing por inbox', async (t) => {
  const { broker, server, url } = await startBroker()
  const sub = await connect(url, 'test-sub-claude')
  const pub = await connect(url, 'test-pub')

  after(async () => {
    await new Promise<void>((r) => sub.end(true, r))
    await new Promise<void>((r) => pub.end(true, r))
    await new Promise<void>((r) => server.close(() => r()))
    await new Promise<void>((r) => broker.close(() => r()))
  })

  const received: any[] = []
  sub.on('message', (_topic: string, payload: Buffer) => {
    received.push(JSON.parse(payload.toString()))
  })
  await new Promise<void>((res, rej) =>
    sub.subscribe('a4s/inbox/claude', { qos: 1 }, (e: Error | null) => (e ? rej(e) : res())),
  )

  const msg = { id: 'b1', from: 'pi', to: 'claude', kind: 'prompt', body: 'hola claude', ts: 1 }
  const otro = { id: 'b2', from: 'claude', to: 'pi', kind: 'prompt', body: 'no es para claude', ts: 2 }

  await new Promise<void>((res, rej) =>
    pub.publish('a4s/inbox/claude', JSON.stringify(msg), { qos: 1 }, (e: Error | null) =>
      e ? rej(e) : res(),
    ),
  )
  // Mensaje dirigido a pi: el suscriptor de claude NO debe recibirlo.
  await new Promise<void>((res, rej) =>
    pub.publish('a4s/inbox/pi', JSON.stringify(otro), { qos: 1 }, (e: Error | null) =>
      e ? rej(e) : res(),
    ),
  )

  // Espera corta a que lleguen los mensajes encaminados.
  await new Promise((r) => setTimeout(r, 150))

  assert.equal(received.length, 1)
  assert.deepEqual(received[0], msg)
})
