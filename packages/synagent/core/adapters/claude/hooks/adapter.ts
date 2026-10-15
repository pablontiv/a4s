// GENERADO — copia de packages/synagent/core/protocol.ts. NO editar a mano.
// Regenerar: node adapters/claude/scripts/sync-protocol.mjs (desde packages/synagent/core).
// El plugin se instala copiándose solo; por eso lleva su propia copia del contrato.

// Contrato canónico de synagent, direccionamiento v1 y CORE host-neutral de
// adaptadores (ADR 0069, supera a 0068).
//
// Fuente ÚNICA del contrato. Solo importa built-ins de Node: el plugin de
// Claude lleva una COPIA GENERADA (adapters/claude/hooks/adapter.ts) anclada por
// un test de paridad, porque el marketplace lo instala copiándose solo.
//
// Topología v1 (regla: topic == `${TOPIC_ROOT}/${version}/${to}`):
//   synagent/v1/<proyecto>/<instancia>  — buzón directo
//   synagent/v1/<proyecto>/all          — broadcast de proyecto
//   synagent/v1/all                     — broadcast global (activo por defecto)
//
// IDENTIDAD (ADR 0069): cada binding la deriva de APIs NATIVAS de sesión del
// host, NO de variables de entorno ni de un launcher. La instancia viene del id
// de sesión nativo (único por sesión → sin colisión aunque haya cientos); el
// proyecto, del remoto remote.origin.url del repo. El alias humano/tab es solo
// presentación, nunca identidad.
//
// CONTRATO DE MENSAJERÍA: `task.request` y `task.redirect` piden trabajo;
// `task.cancel` intenta retirar un pedido aún no inyectado. Solo los pedidos de
// trabajo producen los eventos mecánicos `task.delivered` y `task.completed`;
// `task.expired` informa que el deadline se observó antes de la inyección.
// `note.published` y los eventos nunca producen eventos adicionales.
// `correlation_id` identifica el comando raíz y `causation_id` el mensaje que
// causó el sobre actual. Añadir kinds y campos opcionales compatibles conserva v1.
//
// CONTRATO DE ADAPTADOR (extensible a hosts futuros): un adaptador provee un
// HarnessBinding (identity/reserve/deliver) y un transporte Publish/Subscribe;
// la lógica de direccionamiento vive en funciones puras (makeOutbound/
// acceptInbound/resolveProject/instanceFromHostSession) que la suite de
// conformidad ejercita por igual en todo adaptador.

export const TASK_REQUEST_KINDS = ['task.request', 'task.redirect'] as const
export const COMMAND_KINDS = [...TASK_REQUEST_KINDS, 'task.cancel'] as const
export const EVENT_KINDS = ['task.delivered', 'task.completed', 'task.expired', 'note.published'] as const
export const MESSAGE_KINDS = [...COMMAND_KINDS, ...EVENT_KINDS] as const
export const SYNAGENT_SEND_KINDS = [...COMMAND_KINDS, 'note.published'] as const

export type TaskRequestKind = (typeof TASK_REQUEST_KINDS)[number]
export type CommandKind = (typeof COMMAND_KINDS)[number]
export type EventKind = (typeof EVENT_KINDS)[number]
export type MessageKind = (typeof MESSAGE_KINDS)[number]
export type SynagentSendKind = (typeof SYNAGENT_SEND_KINDS)[number]

export interface CanonicalMessage {
  id: string
  from: string
  to: string
  kind: MessageKind
  body: string
  reply_to?: string
  correlation_id?: string
  causation_id?: string
  // Epoch Unix absoluto en ms. Solo el adaptador emisor lo calcula desde request-ttl.
  deadline?: number
  ts: number
}

// --- versión y raíces de topic -------------------------------------------------

export const PROTOCOL_VERSION = 'v1'
export const TOPIC_ROOT = 'synagent'
export const LEGACY_TOPIC_ROOT = 'a4s/inbox'
export const GLOBAL_ADDRESS = 'all'

// Token NO-LOSSY (ADR 0069): sensible a mayúsculas y admite punto, para
// representar ids de host (UUIDs, nombres con mayúsculas o '.') sin saneado.
// Seguro para un nivel de topic MQTT: sin '/', '+' ni '#'. 1..256 chars.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

export function isToken(value: string): boolean {
  return TOKEN_RE.test(value)
}

// --- gramática de direcciones --------------------------------------------------

export type Address =
  | { readonly scope: 'direct'; readonly project: string; readonly instance: string }
  | { readonly scope: 'project'; readonly project: string }
  | { readonly scope: 'global' }

// Parsea el campo canónico `to`. `all` reservado al global; `<proyecto>/all` es
// broadcast de proyecto, por lo que una instancia NUNCA puede llamarse `all` ni
// un proyecto puede llamarse `all`.
export function parseAddress(to: string): Address | null {
  if (to === GLOBAL_ADDRESS) return { scope: 'global' }
  const parts = to.split('/')
  if (parts.length !== 2) return null
  const project = parts[0] as string
  const leaf = parts[1] as string
  if (!isToken(project) || project === GLOBAL_ADDRESS) return null
  if (leaf === GLOBAL_ADDRESS) return { scope: 'project', project }
  if (!isToken(leaf)) return null
  return { scope: 'direct', project, instance: leaf }
}

export function isAddress(to: string): boolean {
  return parseAddress(to) !== null
}

export function isBroadcast(to: string): boolean {
  const address = parseAddress(to)
  return address !== null && address.scope !== 'direct'
}

export function formatAddress(address: Address): string {
  if (address.scope === 'global') return GLOBAL_ADDRESS
  if (address.scope === 'project') return `${address.project}/${GLOBAL_ADDRESS}`
  return `${address.project}/${address.instance}`
}

// --- identidad del agente ------------------------------------------------------

export interface Identity {
  readonly project: string
  readonly instance: string
}

export function directAddress(identity: Identity): string {
  return `${identity.project}/${identity.instance}`
}

export function projectAddress(project: string): string {
  return `${project}/${GLOBAL_ADDRESS}`
}

// --- mapa dirección → topic ----------------------------------------------------

export function toTopic(to: string, version: string = PROTOCOL_VERSION): string {
  if (!isAddress(to)) throw new Error(`dirección v1 inválida: ${to}`)
  return `${TOPIC_ROOT}/${version}/${to}`
}

export function legacyTopic(address: string): string {
  return `${LEGACY_TOPIC_ROOT}/${address}`
}

// --- plan de suscripción -------------------------------------------------------
// durable   (clean=false): buzón directo (+ legacy solo si se pide explícitamente).
// transient (clean=true):  broadcasts de proyecto + global por defecto → online-only.

export interface SubscriptionPlan {
  readonly durable: readonly string[]
  readonly transient: readonly string[]
}

export function subscriptions(options: {
  identity: Identity
  global?: boolean
  legacyAddress?: string
  version?: string
}): SubscriptionPlan {
  const version = options.version ?? PROTOCOL_VERSION
  const durable: string[] = [toTopic(directAddress(options.identity), version)]
  if (options.legacyAddress) durable.push(legacyTopic(options.legacyAddress))
  const transient: string[] = [toTopic(projectAddress(options.identity.project), version)]
  if (options.global !== false) transient.push(toTopic(GLOBAL_ADDRESS, version))
  return { durable, transient }
}

// --- enrutado de recepción -----------------------------------------------------

// Igualdad exacta de dirección (buzón directo o legacy plano).
export function isFor(message: CanonicalMessage, address: string): boolean {
  return message.to === address
}

// ¿Este mensaje es para mí? Directo a mi identidad, broadcast de mi proyecto,
// global (si está habilitado) o legacy plano (compatibilidad explícita).
export function isForIdentity(
  message: CanonicalMessage,
  options: { identity: Identity; global?: boolean; legacyAddress?: string },
): boolean {
  if (options.legacyAddress && message.to === options.legacyAddress) return true
  const address = parseAddress(message.to)
  if (!address) return false
  if (address.scope === 'direct') {
    return address.project === options.identity.project && address.instance === options.identity.instance
  }
  if (address.scope === 'project') return address.project === options.identity.project
  return options.global !== false
}

// `task.redirect` solo tiene sentido directo: se rechaza en envío y recepción.
export function isBroadcastRedirect(message: CanonicalMessage): boolean {
  return message.kind === 'task.redirect' && isBroadcast(message.to)
}

export function isCommandKind(kind: MessageKind): kind is CommandKind {
  return COMMAND_KINDS.includes(kind as CommandKind)
}

export function isTaskRequestKind(kind: MessageKind): kind is TaskRequestKind {
  return TASK_REQUEST_KINDS.includes(kind as TaskRequestKind)
}

export function isEventKind(kind: MessageKind): kind is EventKind {
  return EVENT_KINDS.includes(kind as EventKind)
}

// --- resolución de identidad por sesión nativa (ADR 0069) ----------------------

// Nombre canónico del repo desde la URL del remoto `origin` (último segmento sin
// `.git`). Determinista y compartido entre hosts: el mismo repo da el mismo
// token en Pi y en Claude. NO usa el basename del cwd. Devuelve null si no parsea.
export function repoNameFromOrigin(origin: string): string | null {
  const cleaned = origin.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const match = cleaned.match(/[/:]([^/:]+)$/)
  const name = match?.[1]
  return name && isToken(name) ? name : null
}

// Proyecto: nombre canónico del repo desde remote.origin.url.
// FALLA explícito si no es válido (sin env, basename ni saneado).
export function resolveProjectWithSource(options: {
  origin?: string
}): { project: string; source: 'origin' } {
  const origin = options.origin?.trim()
  if (origin) {
    const name = repoNameFromOrigin(origin)
    if (!name) throw new Error(`no se pudo derivar un proyecto-token de remote.origin.url: ${origin}`)
    return { project: name, source: 'origin' }
  }
  throw new Error('no se pudo resolver <proyecto>: configura remote.origin.url del repo')
}

// API histórica para callers que solo necesitan el proyecto como string.
export function resolveProject(options: { origin?: string }): string {
  return resolveProjectWithSource(options).project
}

// Instancia: derivada del id de sesión NATIVO del host (único por sesión). Un
// resume conserva el id; new/fork/clear lo re-resuelven. FALLA explícito si el id
// nativo no es un token válido (no se trunca ni se sanea: provocaría colisión).
export function instanceFromHostSession(sessionId: string): string {
  const id = sessionId.trim()
  if (!isToken(id)) throw new Error(`id de sesión del host no es un token válido para instancia: ${sessionId}`)
  return id
}

// --- contrato de adaptador host-neutral ----------------------------------------
// Un adaptador implementa estas piezas; la lógica de direccionamiento es común.

// Lo que un host expone al core para entregar/deduplicar bajo su identidad.
export interface HarnessBinding {
  readonly identity: Identity
  // Reserva un id ANTES de entregar (at-most-once). true si es nuevo.
  reserve(id: string): boolean | Promise<boolean>
  // Entrega un mensaje aceptado al host (inyecta turno / sendUserMessage).
  deliver(message: CanonicalMessage): void | Promise<void>
}

export type Publish = (topic: string, payload: string) => void | Promise<void>
export type Subscribe = (
  topics: readonly string[],
  onMessage: (payload: string) => void,
) => void | Promise<void>

export interface Transport {
  readonly publish: Publish
  readonly subscribe: Subscribe
}

// Construye un envío v1 (single-write): valida la dirección, rechaza
// `task.redirect` a broadcast y arma {topic, message}. Todo comando raíz se
// correlaciona con su propio id cuando el caller no aporta otra correlación.
export function makeOutbound(
  self: Identity,
  to: string,
  options: {
    body: string
    kind?: MessageKind
    replyTo?: string
    correlationId?: string
    causationId?: string
    deadline?: number
    id: string
    ts: number
  },
): { topic: string; message: CanonicalMessage } {
  if (!isAddress(to)) throw new Error(`dirección v1 inválida: ${to}`)
  const kind = options.kind ?? 'task.request'
  if (kind === 'task.redirect' && isBroadcast(to)) {
    throw new Error('task.redirect solo a destino directo, no broadcast')
  }
  const correlationId = options.correlationId ?? (isCommandKind(kind) ? options.id : undefined)
  const message = createCanonical(options.body, {
    id: options.id,
    from: directAddress(self),
    to,
    ts: options.ts,
    kind,
    ...(options.replyTo ? { reply_to: options.replyTo } : {}),
    ...(correlationId ? { correlation_id: correlationId } : {}),
    ...(options.causationId ? { causation_id: options.causationId } : {}),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  })
  return { topic: toTopic(to), message }
}

// ¿Aceptar un mensaje entrante? Enrutado para mi identidad y sin redirect a broadcast.
export function acceptInbound(
  self: Identity,
  message: CanonicalMessage,
  options: { global?: boolean; legacyAddress?: string } = {},
): boolean {
  // Self-echo: un broadcast propio vuelve por mi propia suscripción. No entregar
  // lo que yo mismo emití (comparando la dirección de origen con la mía).
  if (message.from === directAddress(self)) return false
  if (isBroadcastRedirect(message)) return false
  return isForIdentity(message, { identity: self, ...options })
}

// --- contrato canónico (mensaje) -----------------------------------------------

export function createCanonical(
  body: string,
  options: {
    id: string
    from: string
    to: string
    ts: number
    kind?: MessageKind
    reply_to?: string
    correlation_id?: string
    causation_id?: string
    deadline?: number
  },
): CanonicalMessage {
  return {
    id: options.id,
    from: options.from,
    to: options.to,
    kind: options.kind ?? 'task.request',
    body,
    ...(options.reply_to ? { reply_to: options.reply_to } : {}),
    ...(options.correlation_id ? { correlation_id: options.correlation_id } : {}),
    ...(options.causation_id ? { causation_id: options.causation_id } : {}),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ts: options.ts,
  }
}

export function serialize(message: CanonicalMessage): string {
  return JSON.stringify(message)
}

export function parseCanonical(text: string): CanonicalMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('mensaje canónico no es JSON válido')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mensaje canónico debe ser un objeto')
  }

  const message = value as Record<string, unknown>
  for (const field of ['id', 'from', 'to', 'kind', 'body', 'ts'] as const) {
    if (message[field] === undefined || message[field] === null) throw new Error(`falta campo canónico: ${field}`)
  }
  for (const field of ['id', 'from', 'to', 'kind'] as const) {
    if (typeof message[field] !== 'string' || message[field].length === 0) {
      throw new Error(`campo canónico inválido: ${field}`)
    }
  }
  if (typeof message.body !== 'string') throw new Error('campo canónico inválido: body')
  if (typeof message.ts !== 'number' || !Number.isFinite(message.ts)) {
    throw new Error('campo canónico inválido: ts')
  }
  if (!MESSAGE_KINDS.includes(message.kind as MessageKind)) {
    throw new Error(`kind inválido: ${String(message.kind)}`)
  }
  for (const field of ['reply_to', 'correlation_id', 'causation_id'] as const) {
    if (message[field] !== undefined && (typeof message[field] !== 'string' || message[field].length === 0)) {
      throw new Error(`campo canónico inválido: ${field}`)
    }
  }
  if (message.deadline !== undefined && (typeof message.deadline !== 'number' || !Number.isFinite(message.deadline))) {
    throw new Error('campo canónico inválido: deadline')
  }

  return {
    id: message.id as string,
    from: message.from as string,
    to: message.to as string,
    kind: message.kind as MessageKind,
    body: message.body,
    ...(message.reply_to === undefined ? {} : { reply_to: message.reply_to as string }),
    ...(message.correlation_id === undefined ? {} : { correlation_id: message.correlation_id as string }),
    ...(message.causation_id === undefined ? {} : { causation_id: message.causation_id as string }),
    ...(message.deadline === undefined ? {} : { deadline: message.deadline as number }),
    ts: message.ts,
  }
}

export function renderForAgent(message: CanonicalMessage): string {
  const head = `[bus:${message.kind}] de ${message.from} (id ${message.id})`
  const metadata = [
    message.reply_to ? `responder a: ${message.reply_to}` : undefined,
    message.correlation_id ? `correlación: ${message.correlation_id}` : undefined,
    message.causation_id ? `causado por: ${message.causation_id}` : undefined,
  ].filter((line): line is string => line !== undefined)
  return `${head}\n${message.body}${metadata.length > 0 ? `\n(${metadata.join('; ')})` : ''}`
}

// id opaco y legible: incluye la dirección de origen y el ts.
export function newId(address: string, ts: number): string {
  return `${address}-${ts}-${Math.random().toString(36).slice(2, 8)}`
}
