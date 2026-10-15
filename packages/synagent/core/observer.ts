import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { connect } from 'mqtt'

export interface Observation {
  topic: string
  received_at: string
  /** Original MQTT payload decoded as UTF-8, including non-JSON messages. */
  payload: string
}

type Envelope = Record<string, unknown>

function envelope(record: Observation): Envelope {
  try {
    const value: unknown = JSON.parse(record.payload)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Envelope
  } catch {
    // Every bus payload is observable, including malformed envelopes.
  }
  return {}
}

function field(value: Envelope, key: string): string | undefined {
  const text = value[key]
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

/** Connected components of id/reply_to and correlation_id, in receipt order. */
export function groupObservations(records: readonly Observation[]): Observation[][] {
  const parents = records.map((_, index) => index)
  const owners = new Map<string, number>()
  function root(index: number): number {
    let current = index
    while (parents[current] !== current) {
      const parent = parents[current]!
      parents[current] = parents[parent]!
      current = parent
    }
    return current
  }
  records.forEach((record, index) => {
    const message = envelope(record)
    const keys: string[] = []
    for (const name of ['id', 'reply_to', 'correlation_id']) {
      const value = field(message, name)
      if (value) keys.push(`${name === 'correlation_id' ? 'correlation' : 'message'}:${value}`)
    }
    for (const key of keys) {
      const owner = owners.get(key)
      if (owner === undefined) owners.set(key, index)
      else parents[root(index)] = root(owner)
    }
  })
  const chains = new Map<number, Observation[]>()
  records.forEach((record, index) => {
    const key = root(index)
    const chain = chains.get(key)
    if (chain) chain.push(record)
    else chains.set(key, [record])
  })
  return [...chains.values()]
}

/** A deterministic snapshot: live display and offline replay use the same renderer. */
export function renderObservations(records: readonly Observation[]): string {
  const lines = [`Synagent observer: ${records.length} message(s)`]
  groupObservations(records).forEach((chain, index) => {
    const messages = chain.map(envelope)
    const replies = new Set(messages.map(message => field(message, 'reply_to')).filter(value => value !== undefined))
    const ids = messages.map(message => field(message, 'id')).filter(value => value !== undefined)
    const requestedIds = new Set(ids)
    const missingParent = [...replies].find(id => !requestedIds.has(id))
    const request = messages.find(message => !field(message, 'reply_to'))
    const requestId = missingParent ?? (request && field(request, 'id')) ?? ids[0]
    const correlations = [...new Set(messages.map(message => field(message, 'correlation_id')).filter(value => value !== undefined))]
    const label = requestId ? `id=${JSON.stringify(requestId)}` : `#${index + 1}`
    lines.push('', `Chain ${label}${correlations.map(id => ` correlation_id=${JSON.stringify(id)}`).join('')}`)
    chain.forEach((record, messageIndex) => {
      const message = messages[messageIndex]!
      const metadata = ['id', 'reply_to', 'correlation_id', 'kind', 'from', 'to']
        .flatMap(key => {
          const value = field(message, key)
          return value === undefined ? [] : [`${key}=${JSON.stringify(value)}`]
        })
      lines.push(`  ${record.received_at} topic=${JSON.stringify(record.topic)}${metadata.length ? ` ${metadata.join(' ')}` : ''}`)
      lines.push(`    payload=${JSON.stringify(record.payload)}`)
    })
  })
  return `${lines.join('\n')}\n`
}

export async function replayObservations(file: string): Promise<Observation[]> {
  const records: Observation[] = []
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  try {
    for await (const line of lines) {
      lineNumber += 1
      if (!line.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`${file}:${lineNumber}: invalid JSON`)
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${file}:${lineNumber}: expected an observation object`)
      }
      const record = value as Record<string, unknown>
      if (typeof record.topic !== 'string' || typeof record.received_at !== 'string' || typeof record.payload !== 'string') {
        throw new Error(`${file}:${lineNumber}: expected string topic, received_at and payload`)
      }
      records.push({ topic: record.topic, received_at: record.received_at, payload: record.payload })
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return records
}

/** Subscribe only: no adapter, publisher, will, or persistent MQTT session. */
export async function observeBus(options: {
  brokerUrl: string
  output: string
  signal: AbortSignal
  onReady(): void
  onSnapshot(snapshot: string): void
}): Promise<void> {
  const file = openSync(options.output, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR, 0o600)
  const records: Observation[] = []
  try {
    // Appending to an otherwise complete JSONL file also works without its final newline.
    const size = fstatSync(file).size
    if (size > 0) {
      const last = Buffer.alloc(1)
      readSync(file, last, 0, 1, size - 1)
      if (last[0] !== 10) writeSync(file, '\n')
    }
    if (options.signal.aborted) return
    const client = connect(options.brokerUrl, { clean: true, reconnectPeriod: 0 })
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => resolve()
        options.signal.addEventListener('abort', abort, { once: true })
        const finish = (error?: Error) => {
          options.signal.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve()
        }
        client.on('error', error => finish(error))
        client.on('close', () => finish(new Error('MQTT connection closed')))
        client.on('connect', () => {
          client.subscribe('synagent/#', { qos: 1 }, (error, granted) => {
            if (error) return finish(error)
            if (!granted?.some(grant => grant.topic === 'synagent/#' && grant.qos <= 2)) {
              return finish(new Error('Broker rejected subscription to synagent/#'))
            }
            try {
              options.onReady()
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)))
            }
          })
        })
        client.on('message', (topic, payload) => {
          if (options.signal.aborted) return
          try {
            const record: Observation = { topic, received_at: new Date().toISOString(), payload: payload.toString('utf8') }
            writeSync(file, `${JSON.stringify(record)}\n`)
            records.push(record)
            options.onSnapshot(renderObservations(records))
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        })
      })
    } finally {
      await new Promise<void>(resolve => client.end(true, {}, () => resolve()))
    }
  } finally {
    closeSync(file)
  }
}
