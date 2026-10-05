// Adaptador de canal de Claude para synagent (ADR 0069: identidad por sesión
// nativa, sin variables de entorno). Sobre bus MQTT (aedes).
//
//   JALAR  — bridge suscriptor (subproceso de por vida); cada mensaje canónico
//            llega como una línea en stdout y se inyecta con $.prompt.submit.
//   ENVIAR — herramienta synagent_send (invocada por el modelo) publica al bus.
//
// IDENTIDAD (ADR 0069): la instancia sale de $.session.id() (única por sesión →
// sin colisión aunque haya cientos de sesiones); el proyecto, de un setting del
// host (userConfig `project`) o del remoto `origin` del repo ($.session.repo()).
// NADA de env ni de launcher. Si no se resuelve, se opera LEGACY-ONLY.
//
// Topología v1: synagent/v1/<proyecto>/<instancia> (directo, durable),
// /all (proyecto, transient), synagent/v1/all (global, transient opt-in).
// DUAL-READ: también acepta legacy a4s/inbox/claude; publica solo v1.

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  acceptInbound,
  directAddress,
  instanceFromHostSession,
  LEGACY_TOPIC_ROOT,
  makeOutbound,
  MESSAGE_KINDS,
  newId,
  parseCanonical,
  renderForAgent,
  resolveProject,
  serialize,
  subscriptions,
  type Identity,
  type MessageKind,
} from './adapter'

const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'
const PROCESSED_KEY = 'processed'
const LEGACY_ADDRESS = 'claude'
const MAX_SEEN = 1000
const MAX_BUF = 1_000_000

let started = false
let identity: Identity | undefined
let globalOptIn = false
// resolveBrokerUrl corre en register() sin `$`; el aviso se emite al arrancar.
let brokerWarning: string | undefined

const bridgeDir = ($: EngineInterface): string => `${$.plugin.root}/bridge`

function optString(options: PluginOptions, key: string): string | undefined {
  const v = options[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

// El bus no tiene auth: solo aceptamos brokers de loopback sin credenciales
// (paridad con el adaptador Pi). Una URL no conforme cae al default.
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
  const candidate = optString(options, 'brokerUrl') ?? DEFAULT_BROKER_URL
  if (!isLoopbackMqtt(candidate)) {
    brokerWarning = `synagent: brokerUrl no loopback/sin credenciales rechazado (${candidate}); usando ${DEFAULT_BROKER_URL}`
    return DEFAULT_BROKER_URL
  }
  return candidate
}

// Identidad SOLO de APIs nativas de sesión (ADR 0069). Lanza si no resuelve; el
// llamador cae a LEGACY-ONLY. instancia = $.session.id() (única por sesión);
// proyecto = setting del host > nombre del repo del remoto origin.
async function resolveIdentity($: EngineInterface, options: PluginOptions): Promise<Identity> {
  const instance = instanceFromHostSession(await $.session.id())
  const repo = await $.session.repo()
  const project = resolveProject({
    ...(optString(options, 'project') !== undefined ? { setting: optString(options, 'project') } : {}),
    ...(repo?.remote ? { origin: repo.remote } : {}),
  })
  return { project, instance }
}

// Idempotencia por id (at-most-once); dedupe compartido entre clientes.
async function reserve($: EngineInterface, id: string): Promise<boolean> {
  const list = ((await $.store.get(PROCESSED_KEY)) as string[] | undefined) ?? []
  if (list.includes(id)) return false
  const next = [...list, id]
  if (next.length > MAX_SEEN) next.splice(0, next.length - MAX_SEEN)
  await $.store.set(PROCESSED_KEY, next)
  return true
}

// Loop JALAR: cada línea stdout es un mensaje canónico; se filtra por `accept`,
// se deduplica y se inyecta como turno.
function runJalar($: EngineInterface, argv: readonly string[], accept: (m: ReturnType<typeof parseCanonical>) => boolean): void {
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
            continue
          }
          if (!accept(msg)) continue
          try {
            if (!(await reserve($, msg.id))) continue
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

async function ensureStarted($: EngineInterface, brokerUrl: string, options: PluginOptions): Promise<void> {
  if (started) return
  started = true
  if (brokerWarning) void $.ui.status(brokerWarning)

  const bridgeSub = `${bridgeDir($)}/bridge-sub.cjs`

  try {
    identity = await resolveIdentity($, options)
    globalOptIn = options['global'] === true || options['global'] === 'true'
  } catch (err) {
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
  const transientId = `synagent-t-${addr.replace(/\//g, ':')}`

  const argv = ['node', bridgeSub, '--url', brokerUrl, '--durable-id', durableId, '--durable', ...plan.durable]
  if (plan.transient.length > 0) argv.push('--transient-id', transientId, '--transient', ...plan.transient)

  runJalar($, argv, msg => acceptInbound(self, msg, { global: globalOptIn, legacyAddress: LEGACY_ADDRESS }))

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

  try {
    await $.command.register({ name: 'mq-send', description: 'Publica un mensaje al bus synagent (debug)', argumentHint: '<to>: texto' })
  } catch (err) {
    void $.ui.status(`mq-send no registrado: ${err instanceof Error ? err.message : String(err)}`)
  }

  void $.ui.status(`synagent: ${addr} (JALAR activo, tool synagent_send + /mq-send)`)
}

// Publica un mensaje canónico v1 con el bridge-pub one-shot. makeOutbound valida
// dirección y rechaza steer broadcast (lanza). Devuelve el id o un error.
async function publishV1(
  $: EngineInterface,
  brokerUrl: string,
  self: Identity,
  to: string,
  body: string,
  kind: MessageKind,
  replyTo: string | undefined,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const now = await $.clock.now()
  let built
  try {
    built = makeOutbound(self, to, { body, kind, id: newId(directAddress(self), now), ts: now, ...(replyTo ? { replyTo } : {}) })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  let r
  try {
    r = await $.process.run(['node', `${bridgeDir($)}/bridge-pub.cjs`, built.topic, serialize(built.message), brokerUrl])
  } catch (err) {
    return { ok: false, error: `publish lanzó: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (r.exitCode !== 0) return { ok: false, error: `publish falló (exit ${r.exitCode}): ${r.stderr || r.stdout}` }
  return { ok: true, id: built.message.id }
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

  // ENVIAR por INTENCIÓN: synagent_send. Sin matcher; filtramos por e.tool y
  // dejamos pasar los demás con next. Los args van ESPARCIDOS en e.
  on('tool.call', async ($, e, next) => {
    const a = e as unknown as Record<string, unknown>
    if (a.tool !== 'mcp__synagent-adapter-mqtt__synagent_send') return next(e)
    const result = (text: string) => ({ result: text })
    if (!identity) return result('error: identidad v1 no resuelta (legacy-only); configura el setting project o verifica el remoto origin del repo')
    const to = typeof a.to === 'string' ? a.to : ''
    const body = typeof a.body === 'string' ? a.body : ''
    const kind = typeof a.kind === 'string' ? a.kind : 'prompt'
    const replyTo = typeof a.reply_to === 'string' ? a.reply_to : undefined
    if (!to || !body) return result('error: synagent_send requiere "to" y "body"')
    if (!MESSAGE_KINDS.includes(kind as MessageKind)) return result(`error: kind inválido: ${kind}`)
    const sent = await publishV1($, brokerUrl, identity, to, body, kind as MessageKind, replyTo)
    return result(sent.ok ? `enviado ${sent.id} a ${to} (kind=${kind})` : `error: ${sent.error}`)
  })

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
