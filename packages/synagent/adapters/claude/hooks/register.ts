// Adaptador de canal de Claude para synagent (v1: direccionamiento jerárquico).
// Sobre bus MQTT (aedes).
//
// El adaptador habla con el bus por PUSH (no polling):
//   JALAR  — un bridge suscriptor (subproceso de por vida, $.process.spawn)
//            escribe cada mensaje canónico como una línea en stdout; el mod la
//            lee con `for await` ENTRE TURNOS y la entrega con $.prompt.submit.
//   ENVIAR — herramienta synagent_send (invocada por el modelo) publica al bus.
//
// TOPOLOGÍA v1:
//   synagent/v1/<proyecto>/<instancia>  — buzón directo (durable, clean=false)
//   synagent/v1/<proyecto>/all          — broadcast de proyecto (transient)
//   synagent/v1/all                     — broadcast global (transient, opt-in)
//
// DUAL-READ: durante la transición SUSCRIBE y ACEPTA legacy (a4s/inbox/claude)
// además de v1, pero PUBLICA solo v1. Dedupe compartido por id entre clientes.
//
// AUTOCONTENCIÓN: los bridges viven DENTRO del plugin (./bridge), para que
// viajen al instalar desde marketplace (copia solo el dir adapters/claude).
//
// ARRANQUE PEREZOSO: va en ensureStarted, llamado desde session.start Y el
// primer prompt.submit (recarga en caliente). Un flag de MÓDULO se resetea en
// cada carga para re-spawnear el bridge fresco.

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  createCanonical,
  directAddress,
  isAddress,
  isBroadcast,
  isBroadcastSteer,
  isForIdentity,
  LEGACY_TOPIC_ROOT,
  MESSAGE_KINDS,
  newId,
  parseCanonical,
  renderForAgent,
  resolveInstance,
  resolveProject,
  serialize,
  subscriptions,
  toTopic,
  type Identity,
  type MessageKind,
} from './adapter'

const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'
const PROCESSED_KEY = 'processed'
const INSTANCE_KEY = 'synagent-instance'
const LEGACY_ADDRESS = 'claude'
const MAX_SEEN = 1000
const MAX_BUF = 1_000_000

// Flag de módulo: se resetea en cada (re)carga del mod. Evita doble arranque.
let started = false

// Identidad resuelta (cacheada en esta carga del módulo).
let identity: Identity | undefined
let globalOptIn = false
// Aviso diferido: resolveBrokerUrl corre en register() sin `$`; se emite al arrancar.
let brokerWarning: string | undefined

const bridgeDir = ($: EngineInterface): string => `${$.plugin.root}/bridge`

// El bus no tiene auth: igual que el adaptador Pi, solo aceptamos brokers de
// loopback sin credenciales. Una URL no conforme se ignora y se usa el default.
function isLoopbackMqtt(value: string): boolean {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  return (
    u.protocol === 'mqtt:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    && !u.username
    && !u.password
    && (u.pathname === '' || u.pathname === '/')
    && !u.search
    && !u.hash
  )
}

function resolveBrokerUrl(options: PluginOptions): string {
  const v = options['brokerUrl']
  const candidate = typeof v === 'string' && v.length > 0 ? v : DEFAULT_BROKER_URL
  if (!isLoopbackMqtt(candidate)) {
    brokerWarning = `synagent: brokerUrl no loopback/sin credenciales rechazado (${candidate}); usando ${DEFAULT_BROKER_URL}`
    return DEFAULT_BROKER_URL
  }
  return candidate
}

function optString(options: PluginOptions, key: string): string | undefined {
  const v = options[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

// Resuelve la identidad (proyecto, instancia, global). Lanza si el proyecto no
// se puede determinar; el llamador cae a LEGACY-ONLY.
async function resolveIdentity($: EngineInterface, options: PluginOptions): Promise<Identity> {
  const env = await $.env.get('SYNAGENT_PROJECT')
  let remoteUrl: string | undefined
  try {
    const git = await $.process.run(['git', 'config', '--get', 'remote.origin.url'], { cwd: await $.session.cwd() })
    if (git.exitCode === 0 && git.stdout.trim()) remoteUrl = git.stdout.trim()
  } catch {
    // sin remoto: resolveProject decidirá con env/config o lanzará.
  }
  const project = resolveProject({ env, config: optString(options, 'project'), remoteUrl })

  // Instancia: SYNAGENT_INSTANCE > config > generada-persistida (ligada a esta
  // instalación del plugin en $.store; resume la conserva, otra la regenera).
  let generated = (await $.store.get(INSTANCE_KEY)) as string | undefined
  if (!generated) {
    generated = `c-${(await $.clock.now()).toString(36)}`
    await $.store.set(INSTANCE_KEY, generated)
  }
  const instance = resolveInstance({
    env: await $.env.get('SYNAGENT_INSTANCE'),
    config: optString(options, 'instance'),
    generated,
  })

  return { project, instance }
}

// Idempotencia por id: reserva ANTES de entregar (at-most-once). Dedupe
// compartido entre ambos clientes (precisión B): una sola cola stdout, un set.
async function reserve($: EngineInterface, id: string): Promise<boolean> {
  const list = ((await $.store.get(PROCESSED_KEY)) as string[] | undefined) ?? []
  if (list.includes(id)) return false
  const next = [...list, id]
  if (next.length > MAX_SEEN) next.splice(0, next.length - MAX_SEEN)
  await $.store.set(PROCESSED_KEY, next)
  return true
}

// Lanza el bridge-sub con los argv dados y corre el loop JALAR: cada línea es un
// mensaje canónico; se filtra por `accept`, se deduplica y se inyecta como turno.
function runJalar(
  $: EngineInterface,
  argv: readonly string[],
  accept: (message: ReturnType<typeof parseCanonical>) => boolean,
): void {
  void (async () => {
    try {
      const bridge = $.process.spawn({ argv: [...argv] })
      let buf = ''
      for await (const chunk of bridge) {
        if (chunk.stream !== 'stdout' || typeof chunk.text !== 'string') continue
        buf += chunk.text
        if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF)
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
          if (!accept(msg)) continue
          if (isBroadcastSteer(msg)) continue // steer solo directo (recepción)
          try {
            if (!(await reserve($, msg.id))) continue // ya entregado
            await $.prompt.submit({ text: renderForAgent(msg) })
          } catch (err) {
            void $.ui.status(`synagent: entrega falló (${msg.id}): ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      started = false
      void $.ui.status('synagent: bridge detenido; re-suscribe en el próximo prompt')
    } catch (err) {
      started = false
      void $.ui.status(`synagent: bridge error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

// Abre JALAR y registra la herramienta synagent_send + el comando debug.
// Idempotente por carga.
async function ensureStarted($: EngineInterface, brokerUrl: string, options: PluginOptions): Promise<void> {
  if (started) return
  started = true

  if (brokerWarning) void $.ui.status(brokerWarning)

  const bridgeSub = `${bridgeDir($)}/bridge-sub.cjs`

  try {
    identity = await resolveIdentity($, options)
    globalOptIn = options['global'] === true || options['global'] === 'true'
  } catch (err) {
    // LEGACY-ONLY: sin identidad v1, solo JALAR del buzón legacy (durable).
    identity = undefined
    globalOptIn = false
    void $.ui.status(
      `synagent: identidad no resuelta (${err instanceof Error ? err.message : String(err)}); operando LEGACY-ONLY`,
    )
    runJalar(
      $,
      ['node', bridgeSub, '--url', brokerUrl, '--durable-id', 'synagent-legacy-claude', '--durable', `${LEGACY_TOPIC_ROOT}/${LEGACY_ADDRESS}`],
      msg => msg.to === LEGACY_ADDRESS,
    )
    return
  }

  const self = identity
  const addr = directAddress(self)
  const plan = subscriptions({ identity: self, global: globalOptIn, legacyAddress: LEGACY_ADDRESS })
  const durableId = `synagent-${addr.replace(/\//g, ':')}`
  const transientId = `synagent-t-${addr.replace(/\//g, ':')}-${(await $.clock.now()).toString(36)}`

  const argv = ['node', bridgeSub, '--url', brokerUrl, '--durable-id', durableId, '--durable', ...plan.durable]
  if (plan.transient.length > 0) argv.push('--transient-id', transientId, '--transient', ...plan.transient)

  runJalar($, argv, msg => isForIdentity(msg, { identity: self, global: globalOptIn, legacyAddress: LEGACY_ADDRESS }))

  // ENVIAR por INTENCIÓN: tool que el MODELO invoca. No-fatal.
  try {
    await $.tool.register({
      name: 'synagent_send',
      description:
        'Envía un mensaje a otro agente por el bus synagent (v1). Úsalo solo cuando el usuario pida notificar/avisar/mandar algo a otro agente o proyecto. No para conversación con el usuario actual. El "body" debe ser un hecho autoexplicativo.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Dirección v1: "<proyecto>/<instancia>" (directo), "<proyecto>/all" (proyecto) o "all" (global).',
          },
          body: { type: 'string', description: 'Mensaje; un hecho autoexplicativo, no un comando suelto.' },
          kind: { type: 'string', enum: [...MESSAGE_KINDS], description: 'Tipo; default "prompt". "steer" solo a destino directo.' },
          reply_to: { type: 'string', description: 'Opcional: id del mensaje al que respondes.' },
        },
        required: ['to', 'body'],
      },
    })
  } catch (err) {
    void $.ui.status(`synagent_send no registrado: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ENVIAR (debug humano): /mq-send <to>: texto
  try {
    await $.command.register({
      name: 'mq-send',
      description: 'Publica un mensaje al bus synagent (debug)',
      argumentHint: '<to>: texto',
    })
  } catch (err) {
    void $.ui.status(`mq-send no registrado: ${err instanceof Error ? err.message : String(err)}`)
  }

  void $.ui.status(`synagent: ${addr} (JALAR activo, tool synagent_send + /mq-send)`)
}

// Publica un mensaje canónico v1 con el bridge-pub one-shot. Devuelve el id o un
// mensaje de error. Valida dirección y rechaza steer broadcast (envío).
async function publishV1(
  $: EngineInterface,
  brokerUrl: string,
  self: Identity,
  to: string,
  body: string,
  kind: MessageKind,
  replyTo: string | undefined,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isAddress(to)) {
    return { ok: false, error: `dirección v1 inválida: ${to} (usa "<proyecto>/<instancia>", "<proyecto>/all" o "all")` }
  }
  if (kind === 'steer' && isBroadcast(to)) return { ok: false, error: 'steer solo a destino directo, no broadcast' }
  const now = await $.clock.now()
  const from = directAddress(self)
  const id = newId(from, now)
  const message = createCanonical(body, { id, from, to, ts: now, kind, ...(replyTo ? { reply_to: replyTo } : {}) })
  let r
  try {
    r = await $.process.run(['node', `${bridgeDir($)}/bridge-pub.cjs`, toTopic(to), serialize(message), brokerUrl])
  } catch (err) {
    return { ok: false, error: `publish lanzó: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (r.exitCode !== 0) return { ok: false, error: `publish falló (exit ${r.exitCode}): ${r.stderr || r.stdout}` }
  return { ok: true, id }
}

export const register: Register = (on, options) => {
  const brokerUrl = resolveBrokerUrl(options)

  on('session.start', async ($, e, next) => {
    await ensureStarted($, brokerUrl, options)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ensureStarted($, brokerUrl, options)
    return next(e)
  })

  // ENVIAR por INTENCIÓN: el modelo llama synagent_send. Sin matcher (el nombre
  // dinámico mcp__<plugin>__<tool> no está en la unión de tipos): filtramos por
  // e.tool y dejamos pasar los demás con next. Los args van ESPARCIDOS en e.
  on('tool.call', async ($, e, next) => {
    const a = e as unknown as Record<string, unknown>
    if (a.tool !== 'mcp__synagent-adapter-mqtt__synagent_send') return next(e)
    const result = (text: string) => ({ result: text })
    if (!identity) return result('error: identidad v1 no resuelta (legacy-only); configura project/instance o SYNAGENT_PROJECT/SYNAGENT_INSTANCE')
    const to = typeof a.to === 'string' ? a.to : ''
    const body = typeof a.body === 'string' ? a.body : ''
    const kind = typeof a.kind === 'string' ? a.kind : 'prompt'
    const replyTo = typeof a.reply_to === 'string' ? a.reply_to : undefined
    if (!to || !body) return result('error: synagent_send requiere "to" y "body"')
    if (!MESSAGE_KINDS.includes(kind as MessageKind)) return result(`error: kind inválido: ${kind}`)
    const sent = await publishV1($, brokerUrl, identity, to, body, kind as MessageKind, replyTo)
    return result(sent.ok ? `enviado ${sent.id} a ${to} (kind=${kind})` : `error: ${sent.error}`)
  })

  // ENVIAR (debug): /mq-send <to>: texto
  on('command.run', { command: 'mq-send' }, async ($, e) => {
    const raw = (e.args ?? '').trim()
    if (!raw) return { text: 'mq-send: /mq-send <to>: texto  (<to> = "<proyecto>/<instancia>", "<proyecto>/all" o "all")' }
    if (!identity) return { text: 'mq-send: identidad v1 no resuelta (legacy-only)' }
    const m = raw.match(/^([^:]+):\s*([\s\S]*)$/)
    if (!m) return { text: 'mq-send: formato /mq-send <to>: texto' }
    const to = (m[1] ?? '').trim()
    const body = (m[2] ?? '').trim()
    if (!body) return { text: 'mq-send: falta el texto' }
    const sent = await publishV1($, brokerUrl, identity, to, body, 'prompt', undefined)
    return { text: sent.ok ? `mq-send → publicado ${sent.id} a ${to}` : `mq-send ERROR: ${sent.error}` }
  })

  // Nota de capacidad en el system prompt.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return {
      ...r,
      sections: [
        ...r.sections,
        {
          id: 'synagent',
          scope: 'session',
          text:
            'Bus synagent (v1): para mandar a otro agente usa la herramienta synagent_send (solo cuando el usuario pida notificar/mensajear a otro agente o proyecto, no en conversación normal). '
            + 'Direcciones: "<proyecto>/<instancia>" (directo), "<proyecto>/all" (proyecto), "all" (global). Los mensajes deben ser hechos autoexplicativos. '
            + `Tu dirección: ${identity ? directAddress(identity) : 'no configurada (legacy-only)'}.`,
        },
      ],
    }
  })
}
