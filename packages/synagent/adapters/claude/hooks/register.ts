// Adaptador de canal de Claude para synagent, sobre bus MQTT (aedes).
//
// El adaptador habla con el bus por PUSH (no polling):
//   JALAR  — un bridge suscriptor (subproceso de por vida, $.process.spawn)
//            escribe cada mensaje canónico como una línea en stdout; el mod la
//            lee con `for await` ENTRE TURNOS y la entrega con $.prompt.submit.
//   ENVIAR — /mq-send publica al bus con un publisher one-shot ($.process.run).
//
// Emula inbox/outbox con topics: a4s/inbox/<address>. Mi inbox = lo que suscribo;
// mi outbox = publicar al inbox del destinatario.
//
// SEPARACIÓN DE RESPONSABILIDADES:
//   - El BUS (broker) es una app aparte, se arranca por shell: `npm run bus`
//     (packages/synagent/bus/broker.cjs). El adaptador NO lo levanta; se conecta.
//   - El ADAPTADOR (este módulo + sus bridges) solo se suscribe y publica.
//
// AUTOCONTENCIÓN: los bridges (cliente MQTT) viven DENTRO del plugin, en
// ./bridge, y se resuelven desde $.plugin.root. Así, cuando el plugin se instala
// desde un marketplace (Claude Code copia solo el dir del plugin e instala sus
// deps de package.json), los bridges y su dependencia `mqtt` viajan con él. El
// broker queda fuera del plugin a propósito (es el bus, no el adaptador).
//
// ARRANQUE PEREZOSO: la suscripción y el registro del comando NO van en
// session.start (un mod añadido/editado a mitad de sesión no re-dispara ese
// evento). Van en `ensureStarted`, llamado desde session.start (arranque limpio)
// Y desde el primer prompt.submit (recarga en caliente). Un flag de MÓDULO (no
// $.state) lo guarda: se resetea en cada recarga, así el bridge se respawnea
// fresco (misma clientId => el broker desaloja al viejo).
//
// La URL del broker es configurable (userConfig `brokerUrl`); por defecto
// mqtt://127.0.0.1:1884 (el bus escucha solo en loopback).

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  DEFAULT_PEER,
  isForSelf,
  newId,
  parseCanonical,
  renderForAgent,
  SELF_ADDRESS,
} from './adapter'

const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'
const PROCESSED_KEY = 'processed'
// Tope del set de dedupe: entrega at-most-once al modelo, LRU acotado para que
// el store no crezca sin límite.
const MAX_SEEN = 1000
const MAX_BUF = 1_000_000

// Flag de módulo: resetea en cada (re)carga del mod. Evita doble arranque dentro
// de una misma carga cuando session.start y prompt.submit se disparan.
let started = false

// Los bridges viven dentro del plugin (./bridge), para que viajen al instalar.
const bridgeDir = ($: EngineInterface): string => `${$.plugin.root}/bridge`

function resolveBrokerUrl(options: PluginOptions): string {
  const v = options['brokerUrl']
  return typeof v === 'string' && v.length > 0 ? v : DEFAULT_BROKER_URL
}

// Idempotencia por id: reserva ANTES de entregar (lección del PoC de fs). Esto
// da entrega at-most-once al modelo: evita re-inyectar el mismo turno, a costa
// de poder perder uno si la entrega falla tras reservar. El set se acota a las
// últimas MAX_SEEN ids para que el store no crezca indefinidamente.
async function reserve($: EngineInterface, id: string): Promise<boolean> {
  const list = ((await $.store.get(PROCESSED_KEY)) as string[] | undefined) ?? []
  if (list.includes(id)) return false
  const next = [...list, id]
  if (next.length > MAX_SEEN) next.splice(0, next.length - MAX_SEEN)
  await $.store.set(PROCESSED_KEY, next)
  return true
}

// Abre la suscripción JALAR y registra /mq-send. Idempotente por carga.
async function ensureStarted($: EngineInterface, brokerUrl: string): Promise<void> {
  if (started) return
  started = true // marcar ANTES de await para que no entren dos a la vez

  const bridgeSub = `${bridgeDir($)}/bridge-sub.cjs`

  // JALAR es lo CORE: se spawnea PRIMERO. El registro del comando va después y
  // es no-fatal (try/catch), para que un fallo de $.command.register —p. ej. una
  // colisión de nombre con otro adaptador cargado— nunca bloquee la suscripción.
  // El bridge suscriptor vive lo que viva la sesión; su stdout es el canal de
  // datos. Este loop corre entre turnos. Todo va protegido: un fallo de entrega
  // o la muerte del bridge no deben tumbar la sesión, y al terminar el loop se
  // libera `started` para que el próximo prompt re-suscriba.
  void (async () => {
    try {
      const bridge = $.process.spawn({ argv: ['node', bridgeSub, SELF_ADDRESS, brokerUrl] })
      let buf = ''
      for await (const chunk of bridge) {
        if (chunk.stream !== 'stdout' || typeof chunk.text !== 'string') continue
        buf += chunk.text
        if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF) // guard: línea sin \n no crece sin tope
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line.trim()) continue
          let msg
          try {
            msg = parseCanonical(line)
          } catch {
            continue // malformado no detiene el bridge
          }
          if (!isForSelf(msg)) continue
          try {
            if (!(await reserve($, msg.id))) continue // ya entregado
            await $.prompt.submit({ text: renderForAgent(msg) })
          } catch (err) {
            void $.ui.status(`synagent: entrega falló (${msg.id}): ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      // El bridge terminó (caída o desalojo por clientId): permitir re-arranque.
      started = false
      void $.ui.status('synagent: bridge detenido; re-suscribe en el próximo prompt')
    } catch (err) {
      started = false
      void $.ui.status(`synagent: bridge error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()

  // ENVIAR: registro del comando (no-fatal). Nombre propio del adaptador MQTT
  // para no chocar con otros adaptadores cargados (p. ej. un PoC de filesystem
  // que registre /bus-send).
  try {
    await $.command.register({
      name: 'mq-send',
      description: 'Publica un mensaje al bus MQTT (synagent)',
      argumentHint: '[to:] texto',
    })
  } catch (err) {
    void $.ui.status(`mq-send no registrado: ${err instanceof Error ? err.message : String(err)}`)
  }

  void $.ui.status(`synagent: ${SELF_ADDRESS} (JALAR activo)`)
}

export const register: Register = (on, options) => {
  const brokerUrl = resolveBrokerUrl(options)

  // Arranque limpio: session.start arranca el adaptador.
  on('session.start', async ($, e, next) => {
    await ensureStarted($, brokerUrl)
    return next(e)
  })

  // Recarga en caliente (mod añadido/editado a mitad de sesión): el primer
  // prompt del usuario arranca el adaptador sin necesidad de reiniciar.
  on('prompt.submit', async ($, e, next) => {
    await ensureStarted($, brokerUrl)
    return next(e)
  })

  // ENVIAR: /mq-send [to:] texto   (to por defecto = pi)
  on('command.run', { command: 'mq-send' }, async ($, e) => {
    const raw = (e.args ?? '').trim()
    if (!raw) {
      return { text: 'mq-send: /mq-send [to:] texto  (p. ej. /mq-send pi: hola pi)' }
    }
    let to = DEFAULT_PEER
    let body = raw
    const m = raw.match(/^([A-Za-z][\w-]*):\s*([\s\S]*)$/)
    if (m) {
      to = m[1] ?? to
      body = m[2] ?? body
    }
    const id = newId(await $.clock.now())
    const bridgePub = `${bridgeDir($)}/bridge-pub.cjs`
    const r = await $.process.run([
      'node', bridgePub, to, body, SELF_ADDRESS, 'prompt', id, '', brokerUrl,
    ])
    if (r.exitCode !== 0) {
      return { text: `mq-send ERROR (exit ${r.exitCode}): ${r.stderr || r.stdout}` }
    }
    return { text: `mq-send → publicado ${id} (to=${to})` }
  })
}
