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

export function isFor(message: CanonicalMessage, address: string): boolean {
  return message.to === address
}

export function renderForAgent(message: CanonicalMessage): string {
  const head = `[bus:${message.kind}] de ${message.from} (id ${message.id})`
  const tail = message.reply_to ? `\n(responder a: ${message.reply_to})` : ''
  return `${head}\n${message.body}${tail}`
}

export function newId(address: string, ts: number): string {
  return `${address}-${ts}-${Math.random().toString(36).slice(2, 8)}`
}

export function isAddress(value: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(value)
}
