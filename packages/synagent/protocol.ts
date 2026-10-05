// Contrato canónico de synagent y direccionamiento JERÁRQUICO v1 (ADR 0068).
//
// Este módulo es la ÚNICA fuente del contrato: gramática de direcciones, mapa
// dirección→topic, plan de suscripción, enrutado de recepción y resolución de
// proyecto/instancia. Ambos adaptadores (Claude y Pi) lo consumen. El plugin de
// Claude, al instalarse desde un marketplace, se copia solo, por lo que lleva
// una COPIA GENERADA de este archivo (adapters/claude/hooks/adapter.ts) anclada
// por un test de paridad: este archivo no debe importar nada (autocontenido).
//
// Topología v1 (regla: topic == `${TOPIC_ROOT}/${version}/${to}`):
//   synagent/v1/<proyecto>/<instancia>  — buzón directo de un agente
//   synagent/v1/<proyecto>/all          — broadcast de proyecto
//   synagent/v1/all                     — broadcast global (opt-in)
//
// Transición (dual-read/single-write): durante el cutover cada adaptador SUSCRIBE
// y ACEPTA legacy (a4s/inbox/<addr>) además de v1, pero PUBLICA solo v1.

export const MESSAGE_KINDS = ['prompt', 'steer', 'result', 'notify', 'ack'] as const

export type MessageKind = (typeof MESSAGE_KINDS)[number]

export interface CanonicalMessage {
  id: string
  from: string
  to: string
  kind: MessageKind
  body: string
  reply_to?: string
  ts: number
}

// --- versión y raíces de topic -------------------------------------------------

export const PROTOCOL_VERSION = 'v1'
export const TOPIC_ROOT = 'synagent'
export const LEGACY_TOPIC_ROOT = 'a4s/inbox'
export const GLOBAL_ADDRESS = 'all'

// Token legible: minúsculas, direccionable por intención. 1..64 chars.
const TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isToken(value: string): boolean {
  return TOKEN_RE.test(value)
}

// --- gramática de direcciones --------------------------------------------------

export type Address =
  | { readonly scope: 'direct'; readonly project: string; readonly instance: string }
  | { readonly scope: 'project'; readonly project: string }
  | { readonly scope: 'global' }

// Parsea el campo canónico `to`. `all` reservado para global; `<proyecto>/all`
// es broadcast de proyecto, por lo que una instancia NUNCA puede llamarse `all`.
export function parseAddress(to: string): Address | null {
  if (to === GLOBAL_ADDRESS) return { scope: 'global' }
  const parts = to.split('/')
  if (parts.length !== 2) return null
  const project = parts[0] as string
  const leaf = parts[1] as string
  // 'all' está reservado para el global; un proyecto no puede llamarse 'all'.
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

// --- plan de suscripción (precisión F) -----------------------------------------
// durable   (clean=false): buzón directo + legacy → entrega offline encolada.
// transient (clean=true):  broadcast de proyecto + global opt-in → online-only.

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
  if (options.global) transient.push(toTopic(GLOBAL_ADDRESS, version))
  return { durable, transient }
}

// --- enrutado de recepción -----------------------------------------------------

// Igualdad exacta de dirección (buzón directo o legacy plano).
export function isFor(message: CanonicalMessage, address: string): boolean {
  return message.to === address
}

// ¿Este mensaje es para mí? Acepta directo a mi identidad, broadcast de mi
// proyecto, global (solo si opté por él) y legacy plano (dual-read).
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
  return options.global === true
}

// steer solo tiene sentido directo: un broadcast no puede interrumpir el turno de
// muchos. Se rechaza en ENVÍO y en RECEPCIÓN (precisión F).
export function isBroadcastSteer(message: CanonicalMessage): boolean {
  return message.kind === 'steer' && isBroadcast(message.to)
}

// --- resolución de proyecto / instancia (precisiones C y E) --------------------

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

// Normalización determinista a token. NO saneado lossy silencioso: aplica una
// única transformación (separadores de ruta/punto → '-') y, si aún no es token,
// FALLA en vez de truncar en silencio.
export function normalizeProject(raw: string): string {
  const lowered = raw.trim().toLowerCase()
  if (isToken(lowered)) return lowered
  const mapped = lowered.replace(/[/.]+/g, '-').replace(/^-+|-+$/g, '')
  if (isToken(mapped)) return mapped
  throw new Error(`proyecto no normalizable a token [a-z0-9][a-z0-9_-]{0,63}: ${raw}`)
}

// Deriva <proyecto> del remoto como `${owner}-${repo}` (collision-safe frente al
// basename de cwd, precisión E). Soporta https://host/owner/repo(.git) y
// git@host:owner/repo(.git).
export function deriveProjectFromRemote(remoteUrl: string): string {
  const cleaned = remoteUrl.trim().replace(/\.git$/, '')
  const match = cleaned.match(/[/:]([^/:]+)\/([^/]+)$/)
  if (!match) throw new Error(`no se pudo derivar owner/repo del remoto: ${remoteUrl}`)
  return normalizeProject(`${match[1]}-${match[2]}`)
}

// Resuelve <proyecto> por cadena de prioridad: env (SYNAGENT_PROJECT) > config >
// derivado del remoto origin. Falla si ninguno resuelve (no usa basename de cwd).
export function resolveProject(options: { env?: string; config?: string; remoteUrl?: string }): string {
  const explicit = firstNonEmpty(options.env, options.config)
  if (explicit !== undefined) return normalizeProject(explicit)
  const remote = firstNonEmpty(options.remoteUrl)
  if (remote !== undefined) return deriveProjectFromRemote(remote)
  throw new Error('no se pudo resolver <proyecto>: define SYNAGENT_PROJECT, config o un remoto origin')
}

// Resuelve <instancia> por cadena: env (SYNAGENT_INSTANCE) > config > generado y
// persistido. Un valor explícito inválido FALLA (no se sanea en silencio). La
// instancia va ligada a la tarea/sesión; nunca es un escalar global compartido.
export function resolveInstance(options: { env?: string; config?: string; generated: string }): string {
  const explicit = firstNonEmpty(options.env, options.config)
  if (explicit !== undefined) {
    const lowered = explicit.toLowerCase()
    if (!isToken(lowered)) throw new Error(`instancia inválida (SYNAGENT_INSTANCE/config): ${explicit}`)
    return lowered
  }
  const generated = options.generated.trim().toLowerCase()
  if (!isToken(generated)) throw new Error(`instancia generada inválida: ${options.generated}`)
  return generated
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
  },
): CanonicalMessage {
  return {
    id: options.id,
    from: options.from,
    to: options.to,
    kind: options.kind ?? 'prompt',
    body,
    ...(options.reply_to ? { reply_to: options.reply_to } : {}),
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
  if (message.reply_to !== undefined && (typeof message.reply_to !== 'string' || message.reply_to.length === 0)) {
    throw new Error('campo canónico inválido: reply_to')
  }

  return {
    id: message.id as string,
    from: message.from as string,
    to: message.to as string,
    kind: message.kind as MessageKind,
    body: message.body,
    ...(message.reply_to === undefined ? {} : { reply_to: message.reply_to as string }),
    ts: message.ts,
  }
}

export function renderForAgent(message: CanonicalMessage): string {
  const head = `[bus:${message.kind}] de ${message.from} (id ${message.id})`
  const tail = message.reply_to ? `\n(responder a: ${message.reply_to})` : ''
  return `${head}\n${message.body}${tail}`
}

// id opaco y legible: incluye la dirección de origen y el ts.
export function newId(address: string, ts: number): string {
  return `${address}-${ts}-${Math.random().toString(36).slice(2, 8)}`
}
