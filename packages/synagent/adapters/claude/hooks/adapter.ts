// Núcleo de traducción PURO del adaptador Claude (boceto §3/§4): sin `$`,
// testeable aislado. Traduce entre el contrato canónico del bus y lo que el
// agente ve/manda. No importa nada del runtime de Claude Code, así que se
// typecheckea y testea como código de paquete normal.

export const SELF_ADDRESS = 'claude'
export const DEFAULT_PEER = 'pi'

export type MessageKind = 'prompt' | 'steer' | 'result' | 'notify' | 'ack'

export interface CanonicalMessage {
  id: string
  from: string
  to: string
  kind: MessageKind
  body: string
  reply_to?: string
  ts: number
}

const KINDS: readonly MessageKind[] = ['prompt', 'steer', 'result', 'notify', 'ack']

// Salida del agente -> mensaje canónico (ENVIAR).
export function toCanonical(
  body: string,
  opts: { id: string; ts: number; to?: string; from?: string; kind?: MessageKind; reply_to?: string },
): CanonicalMessage {
  return {
    id: opts.id,
    from: opts.from ?? SELF_ADDRESS,
    to: opts.to ?? DEFAULT_PEER,
    kind: opts.kind ?? 'prompt',
    body,
    ...(opts.reply_to ? { reply_to: opts.reply_to } : {}),
    ts: opts.ts,
  }
}

export function serialize(msg: CanonicalMessage): string {
  return JSON.stringify(msg)
}

// Texto del bus -> mensaje canónico validado (JALAR). Rechaza lo malformado.
export function parseCanonical(text: string): CanonicalMessage {
  const o = JSON.parse(text) as Record<string, unknown>
  for (const f of ['id', 'from', 'to', 'kind', 'body', 'ts'] as const) {
    if (o[f] === undefined || o[f] === null) throw new Error(`falta campo canónico: ${f}`)
  }
  if (!KINDS.includes(o.kind as MessageKind)) throw new Error(`kind inválido: ${String(o.kind)}`)
  return {
    id: String(o.id),
    from: String(o.from),
    to: String(o.to),
    kind: o.kind as MessageKind,
    body: String(o.body),
    ...(o.reply_to ? { reply_to: String(o.reply_to) } : {}),
    ts: Number(o.ts),
  }
}

export function isForSelf(msg: CanonicalMessage): boolean {
  return msg.to === SELF_ADDRESS
}

// Mensaje canónico -> texto que se inyecta como turno del agente.
export function renderForAgent(msg: CanonicalMessage): string {
  const head = `[bus:${msg.kind}] de ${msg.from} (id ${msg.id})`
  const tail = msg.reply_to ? `\n(responder a: ${msg.reply_to})` : ''
  return `${head}\n${msg.body}${tail}`
}

export function newId(ts: number): string {
  return `${SELF_ADDRESS}-${ts}-${Math.random().toString(36).slice(2, 8)}`
}
