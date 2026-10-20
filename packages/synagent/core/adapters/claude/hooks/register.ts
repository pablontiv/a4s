// Adaptador de canal de Claude para synagent (ADR 0069: identidad por sesión
// nativa, sin variables de entorno). Sobre bus MQTT (aedes).
//
//   JALAR  — bridge suscriptor (subproceso de por vida); cada mensaje canónico
//            llega como una línea en stdout y se inyecta con $.prompt.submit.
//   ENVIAR — herramienta synagent_send (invocada por el modelo) publica al bus.
//
// IDENTIDAD (ADR 0069): la instancia sale de $.session.id() (única por sesión →
// sin colisión aunque haya cientos de sesiones); el proyecto, del remoto
// remote.origin.url del repo ($.session.repo()). Si no se resuelve, el
// adaptador queda inactivo con remediación para configurar remote.origin.url.
//
// Topología v2: synagent/v2/<proyecto>/<instancia> (directo, durable),
// /all (proyecto, transient), synagent/v2/all (global, transient por defecto).

import type {
  EngineInterface,
  PluginOptions,
  Register,
  TurnCompleteInput,
} from 'claude-code'

import {
  acceptInbound,
  assertSupportedTopicVersion,
  directAddress,
  instanceFromHostSession,
  isTaskRequestKind,
  makeOutbound,
  newId,
  parseCanonical,
  renderForAgent,
  resolveProjectWithSource,
  serialize,
  subscriptions,
  SYNAGENT_SEND_KINDS,
  toTopic,
  type CanonicalMessage,
  type DeliveryResult,
  type Identity,
  type MessageKind,
  type SynagentSendKind,
} from './adapter'

const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'
const LEGACY_CLIENT_ID = 'synagent-legacy-claude'
const PROCESSED_KEY = 'processed'
const OFFERS_KEY = 'offers'
const MAX_SEEN = 1000
const MAX_BUF = 1_000_000
type OfferClaim = { closed: boolean; from: string; id: string }
type OutgoingOffer = {
  assignedClaimId?: string
  assignedTo?: string
  assignmentSent: boolean
  body: string
  claims: OfferClaim[]
  id: string
}

export type ClaudeDeliveryResult = DeliveryResult

type TrackedDelivery = {
  generation: number
  message: CanonicalMessage
  prompt: string
  recipient: Identity
}

export function mapClaudeDeliveryResult(
  reason: TurnCompleteInput['reason'],
  text: string,
): ClaudeDeliveryResult {
  return reason === 'answer'
    ? { reason, status: 'complete', text }
    : { cause: reason, reason, status: 'failed', text }
}

let started = false
// Session id para el que arrancamos. ADR 0069: la identidad sale de
// $.session.id(). `/clear` NO dispara session.start pero cambia el session id y el
// módulo puede seguir cargado; detectamos el cambio para re-resolver y re-suscribir.
// (La compactación conserva el session id, así que no reinicia.)
let startedSessionId: string | undefined
// Generación del arranque actual: invalida los loops de bridges previos para que
// su cierre no pise el estado del arranque nuevo.
let generation = 0
// Detiene el bridge-sub vivo (mata el subproceso vía HookStream.return()).
let stopBridge: (() => void) | undefined
let identity: Identity | undefined
let globalEnabled = true
let acceptOffersEnabled = false
let sessionIdle = true
const outgoingOffers = new Map<string, OutgoingOffer>()
// resolveBrokerUrl corre en register() sin `$`; el aviso se emite al arrancar.
let brokerWarning: string | undefined
// Como máximo una migración one-shot en vuelo por activación del módulo. Tras
// éxito queda hecha; si falta el broker puede reintentarse en un prompt futuro.
let retirementInFlightOrDone = false
let pendingDeliveries: TrackedDelivery[] = []
const activeDeliveries = new Map<string, TrackedDelivery>()

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

// Identidad SOLO de APIs nativas de sesión (ADR 0069). Lanza si no resuelve.
// instancia = $.session.id() (única por sesión);
// proyecto = remote.origin.url.
async function resolveIdentity(
  $: EngineInterface,
): Promise<{ identity: Identity; source: ReturnType<typeof resolveProjectWithSource>['source'] }> {
  const repo = await $.session.repo()
  const resolved = resolveProjectWithSource({ ...(repo?.remote ? { origin: repo.remote } : {}) })
  const instance = instanceFromHostSession(await $.session.id())
  return { identity: { project: resolved.project, instance }, source: resolved.source }
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
function parseOffer(value: unknown): OutgoingOffer | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || !('id' in value)
    || !('body' in value)
    || !('claims' in value)
    || !('assignmentSent' in value)
    || typeof value.id !== 'string'
    || typeof value.body !== 'string'
    || !Array.isArray(value.claims)
    || typeof value.assignmentSent !== 'boolean'
  ) return undefined
  const claims: OfferClaim[] = []
  for (const claim of value.claims) {
    if (
      typeof claim !== 'object'
      || claim === null
      || !('id' in claim)
      || !('from' in claim)
      || !('closed' in claim)
      || typeof claim.id !== 'string'
      || typeof claim.from !== 'string'
      || typeof claim.closed !== 'boolean'
    ) return undefined
    claims.push({ closed: claim.closed, from: claim.from, id: claim.id })
  }
  const assignedTo = 'assignedTo' in value ? value.assignedTo : undefined
  const assignedClaimId = 'assignedClaimId' in value ? value.assignedClaimId : undefined
  if (
    (assignedTo !== undefined && typeof assignedTo !== 'string')
    || (assignedClaimId !== undefined && typeof assignedClaimId !== 'string')
  ) return undefined
  return {
    assignmentSent: value.assignmentSent,
    body: value.body,
    claims,
    id: value.id,
    ...(assignedTo === undefined ? {} : { assignedTo }),
    ...(assignedClaimId === undefined ? {} : { assignedClaimId }),
  }
}

async function restoreOffers($: EngineInterface): Promise<void> {
  outgoingOffers.clear()
  const stored = await $.store.get(OFFERS_KEY)
  if (!Array.isArray(stored)) return
  for (const value of stored) {
    const offer = parseOffer(value)
    if (offer) outgoingOffers.set(offer.id, offer)
  }
}

async function persistOffers($: EngineInterface): Promise<void> {
  await $.store.set(OFFERS_KEY, [...outgoingOffers.values()].map(offer => ({
    ...offer,
    claims: offer.claims.map(claim => ({ ...claim })),
  })))
}
async function recordOutgoingOffer($: EngineInterface, message: CanonicalMessage): Promise<void> {
  outgoingOffers.set(message.id, {
    assignmentSent: false,
    body: message.body,
    claims: [],
    id: message.id,
  })
  await persistOffers($)
}



function retireLegacySession($: EngineInterface, brokerUrl: string): void {
  if (retirementInFlightOrDone) return
  retirementInFlightOrDone = true
  const argv = [
    'node',
    `${bridgeDir($)}/bridge-sub.cjs`,
    '--url',
    brokerUrl,
    '--retire-id',
    LEGACY_CLIENT_ID,
  ]
  // No bloquear el arranque: el bridge usa clean=true, sin retries, y termina.
  void $.process.run(argv).then((result) => {
    if (result.exitCode !== 0) {
      retirementInFlightOrDone = false
      void $.ui.status(`synagent: no se pudo retirar la sesión legacy (${result.stderr || `exit ${result.exitCode}`})`)
    }
  }).catch((err) => {
    retirementInFlightOrDone = false
    void $.ui.status(`synagent: no se pudo retirar la sesión legacy (${err instanceof Error ? err.message : String(err)})`)
  })
}

function trackInboundDelivery(
  gen: number,
  recipient: Identity,
  message: CanonicalMessage,
  prompt: string,
): TrackedDelivery {
  const delivery = { generation: gen, message, prompt, recipient }
  pendingDeliveries.push(delivery)
  return delivery
}

function forgetPendingDelivery(delivery: TrackedDelivery): void {
  pendingDeliveries = pendingDeliveries.filter(candidate => candidate !== delivery)
}

function resetDeliveryTracking(): void {
  pendingDeliveries = []
  activeDeliveries.clear()
}

async function recordDeliveryResult(
  $: EngineInterface,
  delivery: TrackedDelivery,
  result: ClaudeDeliveryResult,
): Promise<void> {
  const payload = JSON.stringify({
    sessionId: await $.session.id(),
    messageId: delivery.message.id,
    messageKind: delivery.message.kind,
    result,
  })
  try {
    const recorded = await $.process.run(
      ['node', `${bridgeDir($)}/bridge-result.cjs`],
      { stdin: payload },
    )
    if (recorded.exitCode !== 0) {
      void $.ui.status(`synagent: no se pudo registrar resultado para ${delivery.message.id}`)
    }
  } catch {
    void $.ui.status(`synagent: no se pudo registrar resultado para ${delivery.message.id}`)
  }
}

type BridgeFrame = { topic: string; payload: string }

async function handleOfferProtocol(
  $: EngineInterface,
  brokerUrl: string,
  self: Identity,
  message: CanonicalMessage,
): Promise<boolean> {
  if (message.kind === 'task.offer') {
    if (acceptOffersEnabled && sessionIdle) {
      const claim = await publishCanonical(
        $, brokerUrl, self, message.from, `Reclamo oferta ${message.id}`, 'task.claim',
        message.id, message.id, message.id,
      )
      if (!claim.ok) void $.ui.status(`synagent: reclamo falló (${message.id}): ${claim.error}`)
    }
    return true
  }
  if (message.kind === 'task.offer.closed') {
    void $.ui.status(`synagent: ${message.body}`)
    return true
  }
  if (message.kind !== 'task.claim') return false
  const offer = message.reply_to ? outgoingOffers.get(message.reply_to) : undefined
  if (!offer) return true
  const claim: OfferClaim = { closed: offer.assignedTo !== undefined, from: message.from, id: message.id }
  offer.claims.push(claim)
  if (!offer.assignedTo) {
    offer.assignedClaimId = claim.id
    offer.assignedTo = claim.from
    await persistOffers($)
    const assignment = await publishCanonical(
      $, brokerUrl, self, claim.from, offer.body, 'task.request',
      offer.id, offer.id, claim.id,
    )
    if (!assignment.ok) {
      void $.ui.status(`synagent: asignación falló (${offer.id}): ${assignment.error}`)
      return true
    }
    offer.assignmentSent = true
    await persistOffers($)
    return true
  }
  await persistOffers($)
  const closed = await publishCanonical(
    $, brokerUrl, self, claim.from, `Oferta ya asignada: ${offer.id}`, 'task.offer.closed',
    claim.id, offer.id, offer.assignedClaimId ?? offer.id,
  )
  if (!closed.ok) {
    void $.ui.status(`synagent: cierre de oferta falló (${offer.id}): ${closed.error}`)
    return true
  }
  claim.closed = true
  await persistOffers($)
  return true
}

// Loop JALAR: cada línea stdout es una trama {topic,payload}; la versión se
// valida antes del parser canónico, luego procesa ofertas mecánicamente, filtra
// por `accept`, deduplica e inyecta los demás mensajes como turno.
function runJalar(
  gen: number,
  $: EngineInterface,
  argv: readonly string[],
  brokerUrl: string,
  self: Identity,
  accept: (message: CanonicalMessage) => boolean,
): void {
  void (async () => {
    try {
      const bridge = $.process.spawn({ argv: [...argv] })
      // Permite detener ESTE bridge (p. ej. al cambiar de sesión con /clear).
      if (gen === generation) stopBridge = () => void bridge.return(undefined as never)
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
          let frame: BridgeFrame
          try {
            const decoded: unknown = JSON.parse(line)
            if (
              typeof decoded !== 'object'
              || decoded === null
              || !('topic' in decoded)
              || typeof decoded.topic !== 'string'
              || !('payload' in decoded)
              || typeof decoded.payload !== 'string'
            ) throw new TypeError('trama bridge inválida')
            frame = { topic: decoded.topic, payload: decoded.payload }
            assertSupportedTopicVersion(frame.topic)
          } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'MESSAGE_INVALID'
            void $.ui.status(`synagent: mensaje rechazado (${code}): ${error instanceof Error ? error.message : String(error)}`)
            continue
          }
          let msg
          try {
            msg = parseCanonical(frame.payload)
          } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'MESSAGE_INVALID'
            void $.ui.status(`synagent: mensaje rechazado (${code}): ${error instanceof Error ? error.message : String(error)}`)
            continue
          }
          if (!accept(msg)) continue
          try {
            if (!(await reserve($, msg.id))) continue
            if (await handleOfferProtocol($, brokerUrl, self, msg)) continue
            if (msg.kind === 'task.delivered') continue
            sessionIdle = false
            const prompt = renderForAgent(msg)
            const tracked = trackInboundDelivery(gen, self, msg, prompt)
            try {
              await $.prompt.submit({ text: prompt })
            } catch (error) {
              forgetPendingDelivery(tracked)
              throw error
            }
          } catch (err) {
            void $.ui.status(`synagent: entrega falló (${msg.id}): ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      if (gen === generation) {
        started = false
        void $.ui.status('synagent: bridge detenido; re-suscribe en el próximo prompt')
      }
    } catch (err) {
      if (gen === generation) {
        started = false
        void $.ui.status(`synagent: bridge error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })()
}

async function ensureStarted($: EngineInterface, brokerUrl: string, options: PluginOptions): Promise<void> {
  // La sesión histórica tenía un clientId fijo distinto de los clientId actuales.
  // Se retira incluso si luego no puede resolverse la identidad actual.
  retireLegacySession($, brokerUrl)

  // ADR 0069: la identidad depende del session id. `/clear` lo cambia SIN disparar
  // session.start y el módulo puede seguir cargado; si ya arrancamos para otra
  // sesión, detenemos el bridge viejo y re-resolvemos. Compactación: mismo id → no-op.
  const sid = await $.session.id()
  if (startedSessionId !== undefined && startedSessionId !== sid) resetDeliveryTracking()
  if (started && startedSessionId === sid) return
  if (started) {
    stopBridge?.()
    stopBridge = undefined
  }
  const gen = ++generation
  started = true
  startedSessionId = sid
  if (brokerWarning) void $.ui.status(brokerWarning)

  const bridgeSub = `${bridgeDir($)}/bridge-sub.cjs`

  let activation: Awaited<ReturnType<typeof resolveIdentity>>
  try {
    activation = await resolveIdentity($)
    identity = activation.identity
    globalEnabled = options['global'] !== false && options['global'] !== 'false'
    acceptOffersEnabled = options['acceptOffers'] === true || options['acceptOffers'] === 'true'
    await restoreOffers($)
  } catch (err) {
    identity = undefined
    globalEnabled = true
    acceptOffersEnabled = false
    outgoingOffers.clear()
    started = false
    void $.ui.status(
      `synagent: identidad no resuelta (${err instanceof Error ? err.message : String(err)}); inactive=true; configura remote.origin.url`,
    )
    return
  }

  const self = identity
  const addr = directAddress(self)
  const plan = subscriptions({ identity: self, global: globalEnabled })
  const durableId = `synagent-${addr.replace(/\//g, ':')}`
  const transientId = `synagent-t-${addr.replace(/\//g, ':')}`

  const argv = [
    'node',
    bridgeSub,
    '--url',
    brokerUrl,
    '--durable-id',
    durableId,
    '--stale-durable',
    toTopic(addr, 'v1'),
    '--durable',
    ...plan.durable,
  ]
  if (plan.transient.length > 0) argv.push('--transient-id', transientId, '--transient', ...plan.transient)

  runJalar(gen, $, argv, brokerUrl, self, msg => acceptInbound(self, msg, { global: globalEnabled }))

  try {
    await $.tool.register({
      name: 'synagent_send',
      description:
        'Envía un comando de tarea o una nota publicada por el bus synagent (v2). '
        + 'Úsalo solo cuando el usuario pida mensajear a otro agente o proyecto. El body debe ser autoexplicativo.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Dirección canónica: "<proyecto>/<instancia>" (directo), "<proyecto>/all" (proyecto) o "all" (global).',
          },
          body: { type: 'string', description: 'Mensaje autoexplicativo.' },
          kind: {
            type: 'string',
            enum: [...SYNAGENT_SEND_KINDS],
            description: 'Tipo; default "task.request". "task.redirect" solo a destino directo.',
          },
          reply_to: { type: 'string', description: 'Opcional: id del mensaje al que respondes.' },
          correlation_id: { type: 'string', description: 'Opcional: id del comando raíz.' },
          causation_id: { type: 'string', description: 'Opcional: id del mensaje causante.' },
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
  try {
    await $.command.register({
      name: 'synagent-offer',
      description: 'Ofrece una tarea al proyecto',
      argumentHint: '<descripción>',
    })
  } catch (err) {
    void $.ui.status(`synagent-offer no registrado: ${err instanceof Error ? err.message : String(err)}`)
  }


  void $.ui.status(
    `synagent: ${addr} (source=${activation.source}; accept-offers=${acceptOffersEnabled}; `
    + 'JALAR activo, tool synagent_send + /mq-send)',
  )
}

// Publica un mensaje canónico v2 con el bridge-pub one-shot. makeOutbound valida
// dirección y rechaza task.redirect broadcast (lanza). Devuelve el id o un error.
async function publishCanonical(
  $: EngineInterface,
  brokerUrl: string,
  self: Identity,
  to: string,
  body: string,
  kind: MessageKind,
  replyTo: string | undefined,
  correlationId: string | undefined,
  causationId: string | undefined,
  beforePublish?: (message: CanonicalMessage) => void | Promise<void>,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const now = await $.clock.now()
  let built
  try {
    built = makeOutbound(self, to, {
      body,
      kind,
      id: newId(directAddress(self), now),
      ts: now,
      ...(replyTo ? { replyTo } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(causationId ? { causationId } : {}),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (beforePublish) {
    try {
      await beforePublish(built.message)
    } catch (err) {
      return { ok: false, error: `persistencia falló: ${err instanceof Error ? err.message : String(err)}` }
    }
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

async function publishTaskEvent(
  $: EngineInterface,
  brokerUrl: string,
  delivery: TrackedDelivery,
  kind: 'task.delivered' | 'task.completed',
  body: string,
): Promise<void> {
  const command = delivery.message
  const sent = await publishCanonical(
    $,
    brokerUrl,
    delivery.recipient,
    command.from,
    body,
    kind,
    command.id,
    command.correlation_id ?? command.id,
    command.id,
  )
  if (!sent.ok) {
    void $.ui.status(`synagent: no se pudo publicar ${kind} para ${command.id}: ${sent.error}`)
  }
}

export const register: Register = (on, options) => {
  const brokerUrl = resolveBrokerUrl(options)

  on('turn.start', async ($, e, next) => {
    sessionIdle = false
    const index = pendingDeliveries.findIndex(delivery =>
      delivery.generation === generation && e.text.includes(delivery.prompt))
    if (index >= 0) {
      const [delivery] = pendingDeliveries.splice(index, 1)
      if (delivery) {
        activeDeliveries.set(e.turnId, delivery)
        if (isTaskRequestKind(delivery.message.kind)) {
          await publishTaskEvent($, brokerUrl, delivery, 'task.delivered', '')
        }
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    sessionIdle = true
    if (e.agentId === undefined) {
      const delivery = activeDeliveries.get(e.turnId)
      if (delivery) {
        activeDeliveries.delete(e.turnId)
        const result = mapClaudeDeliveryResult(e.reason, e.answer)
        await recordDeliveryResult($, delivery, result)
        if (result.status === 'complete' && isTaskRequestKind(delivery.message.kind)) {
          await publishTaskEvent($, brokerUrl, delivery, 'task.completed', result.text)
        }
      }
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    sessionIdle = true
    await ensureStarted($, brokerUrl, options)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    sessionIdle = false
    await ensureStarted($, brokerUrl, options)
    return next(e)
  })

  // ENVIAR por INTENCIÓN: synagent_send. Sin matcher; filtramos por e.tool y
  // dejamos pasar los demás con next. Los args van ESPARCIDOS en e.
  on('tool.call', async ($, e, next) => {
    const a = e as unknown as Record<string, unknown>
    if (a.tool !== 'mcp__synagent-adapter-mqtt__synagent_send') return next(e)
    const result = (text: string, isError = false) => ({ result: text, ...(isError && { isError }) })
    if (!identity) return result('error: identidad no resuelta; configura remote.origin.url del repo', true)
    const to = typeof a.to === 'string' ? a.to : ''
    const body = typeof a.body === 'string' ? a.body : ''
    const kind = typeof a.kind === 'string' ? a.kind : 'task.request'
    const replyTo = typeof a.reply_to === 'string' ? a.reply_to : undefined
    const correlationId = typeof a.correlation_id === 'string' ? a.correlation_id : undefined
    const causationId = typeof a.causation_id === 'string' ? a.causation_id : undefined
    if (!to || !body) return result('error: synagent_send requiere "to" y "body"', true)
    if (!SYNAGENT_SEND_KINDS.includes(kind as SynagentSendKind)) return result(`error: kind inválido: ${kind}`, true)
    if (kind === 'task.offer' && to !== `${identity.project}/all`) {
      return result(`error: task.offer requiere destino ${identity.project}/all`, true)
    }
    const sent = await publishCanonical(
      $, brokerUrl, identity, to, body, kind as SynagentSendKind, replyTo, correlationId, causationId,
      kind === 'task.offer' ? message => recordOutgoingOffer($, message) : undefined,
    )
    return result(sent.ok ? `enviado ${sent.id} a ${to} (kind=${kind})` : `error: ${sent.error}`, !sent.ok)
  })

  on('command.run', { command: 'mq-send' }, async ($, e) => {
    const raw = (e.args ?? '').trim()
    if (!raw) return { text: 'mq-send: /mq-send <to>: texto  (<to> = "<proyecto>/<instancia>", "<proyecto>/all" o "all")' }
    if (!identity) return { text: 'mq-send: identidad no resuelta' }
    const m = raw.match(/^([^:]+):\s*([\s\S]*)$/)
    if (!m) return { text: 'mq-send: formato /mq-send <to>: texto' }
    const to = (m[1] ?? '').trim()
    const body = (m[2] ?? '').trim()
    if (!body) return { text: 'mq-send: falta el texto' }
    const sent = await publishCanonical($, brokerUrl, identity, to, body, 'task.request', undefined, undefined, undefined)
    return { text: sent.ok ? `mq-send → publicado ${sent.id} a ${to}` : `mq-send ERROR: ${sent.error}` }
  })

  on('command.run', { command: 'synagent-offer' }, async ($, e) => {
    const body = (e.args ?? '').trim()
    if (!body) return { text: 'synagent-offer: /synagent-offer <descripción>' }
    if (!identity) return { text: 'synagent-offer: identidad no resuelta' }
    const to = `${identity.project}/all`
    const sent = await publishCanonical(
      $, brokerUrl, identity, to, body, 'task.offer', undefined, undefined, undefined,
      message => recordOutgoingOffer($, message),
    )
    return {
      text: sent.ok
        ? `synagent-offer → publicado ${sent.id} a ${to}`
        : `synagent-offer ERROR: ${sent.error}`,
    }
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
            'Bus synagent (v2): para mandar a otro agente usa la herramienta synagent_send (solo cuando el usuario pida notificar/mensajear a otro agente o proyecto, no en conversación normal). '
            + 'Direcciones: "<proyecto>/<instancia>" (directo), "<proyecto>/all" (proyecto), "all" (global). Los mensajes deben ser hechos autoexplicativos. '
            + `Tu dirección: ${identity ? directAddress(identity) : 'no configurada (adaptador inactivo)'}.`
        },
      ],
    }
  })
}
