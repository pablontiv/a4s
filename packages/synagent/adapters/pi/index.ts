import { randomUUID } from 'node:crypto'

import type { ExtensionAPI, ExtensionContext, SettingsScope } from '@pablontiv/pion'
import { connect, type MqttClient } from 'mqtt'
import { Type } from 'typebox'

import {
  createCanonical,
  isAddress,
  isFor,
  newId,
  parseCanonical,
  renderForAgent,
  serialize,
  type CanonicalMessage,
} from '../../protocol.ts'

const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'
const DEFAULT_ADDRESS = 'pi'
const DEFAULT_PEER = 'claude'
const MAX_SEEN = 1000
const SEEN_ENTRY = 'synagent-delivered'
const STATE_ENTRY = 'synagent-state'
const DEFAULT_DELIVERY_START_TIMEOUT_MS = 30_000

type SeenEntry = { id: string }
type StateEntry = { address: string }
type QueuedDelivery = { generation: number; message: CanonicalMessage }
type DeliveryMode = 'idle' | 'steer' | 'followUp'
type ActiveDelivery = {
  confirmed: boolean
  id: string
  marker: string
  mode: DeliveryMode
  token: number
}

export type SynagentPiOptions = { deliveryStartTimeoutMs?: number }

export function createSynagentPi(options: SynagentPiOptions = {}): (pi: ExtensionAPI) => void {
  const deliveryStartTimeoutMs = options.deliveryStartTimeoutMs ?? DEFAULT_DELIVERY_START_TIMEOUT_MS
  return pi => synagentPi(pi, deliveryStartTimeoutMs)
}

function synagentPi(pi: ExtensionAPI, deliveryStartTimeoutMs: number): void {
  const enabled = pi.registerSetting({
    key: 'a4s.synagent.enabled',
    schema: Type.Boolean(),
    defaultValue: true,
    title: 'Synagent enabled',
    description: 'Connect the Pi channel adapter to the Synagent MQTT bus.',
    ui: {
      control: 'select',
      choices: [
        { label: 'Enabled', value: true },
        { label: 'Disabled', value: false },
      ],
    },
  })
  const brokerUrl = pi.registerSetting({
    key: 'a4s.synagent.broker-url',
    schema: Type.String({ pattern: '^mqtt://(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::[0-9]{1,5})?/?$' }),
    defaultValue: DEFAULT_BROKER_URL,
    title: 'Synagent broker URL',
    description: 'Loopback MQTT URL used by the Pi channel adapter.',
  })
  const address = pi.registerSetting({
    key: 'a4s.synagent.address',
    schema: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]*$' }),
    defaultValue: DEFAULT_ADDRESS,
    title: 'Synagent address',
    description: 'Logical bus address subscribed by this Pi session.',
  })
  const defaultPeer = pi.registerSetting({
    key: 'a4s.synagent.default-peer',
    schema: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]*$' }),
    defaultValue: DEFAULT_PEER,
    title: 'Synagent default peer',
    description: 'Recipient used by /mq-send when no address prefix is given.',
  })

  let client: MqttClient | undefined
  let subscribedTopic: string | undefined
  let lastSubscribedAddress: string | undefined
  let activeSessionId: string | undefined
  let context: ExtensionContext | undefined
  let lifecycle = Promise.resolve()
  let connectionGeneration = 0
  let deliveryGeneration = 0
  let deliveryDispatchToken = 0
  let deliveryStartTimer: NodeJS.Timeout | undefined
  let activeDelivery: ActiveDelivery | undefined
  let awaitingSettlement = false
  let unsubscribeSettings: Array<() => void> = []
  const queuedDeliveries: QueuedDelivery[] = []
  const seen = new Set<string>()

  pi.registerCommand('mq-send', {
    description: 'Publish a prompt to the Synagent MQTT bus',
    handler: async (args, ctx) => {
      useCurrentContext(ctx)
      const parsed = parseSendArgs(args, defaultPeer.get())
      if (!parsed) {
        ctx.ui.notify('Usage: /mq-send [to:] text', 'warning')
        return
      }
      if (!isAddress(parsed.to)) {
        ctx.ui.notify(`Invalid Synagent address: ${parsed.to}`, 'error')
        return
      }
      const active = client
      if (!active?.connected) {
        ctx.ui.notify('Synagent is not connected', 'error')
        return
      }

      const from = address.get()
      const ts = Date.now()
      const message = createCanonical(parsed.body, {
        id: newId(from, ts),
        from,
        to: parsed.to,
        ts,
      })
      try {
        await publish(active, `a4s/inbox/${parsed.to}`, serialize(message))
        ctx.ui.notify(`Synagent message sent: ${message.id}`, 'info')
      } catch (error) {
        ctx.ui.notify(`Synagent publish failed: ${formatError(error)}`, 'error')
      }
    },
  })

  pi.registerCommand('synagent', {
    description: 'Inspect or configure the Synagent Pi adapter',
    handler: async (args, ctx) => {
      useCurrentContext(ctx)
      const [action = 'status', key, ...rest] = args.trim().split(/\s+/)
      if (action === 'status') {
        let state = 'disabled'
        if (enabled.get()) state = client?.connected ? 'connected' : 'connecting'
        ctx.ui.notify(
          `Synagent ${state}; address=${address.get()} peer=${defaultPeer.get()} broker=${brokerUrl.get()}`,
          'info',
        )
        return
      }
      if (action === 'enable' || action === 'disable') {
        enabled.set(action === 'enable')
        ctx.ui.notify(`Synagent ${action === 'enable' ? 'enabled' : 'disabled'}`, 'info')
        return
      }
      if (action === 'resume') {
        if (!awaitingSettlement) {
          ctx.ui.notify('Synagent has no blocked delivery', 'info')
          return
        }
        clearDeliveryStartTimer()
        ++deliveryDispatchToken
        activeDelivery = undefined
        awaitingSettlement = false
        ctx.ui.notify('Synagent delivery queue resumed manually; ordering is now best-effort', 'warning')
        drainDeliveries(ctx)
        return
      }
      if (action !== 'set' || !key || rest.length === 0) {
        ctx.ui.notify('Usage: /synagent status|enable|disable|resume|set <broker-url|address|default-peer> <value>', 'warning')
        return
      }

      const value = rest.join(' ')
      try {
        setSetting(key, value, 'global')
        ctx.ui.notify(`Synagent ${key} updated`, 'info')
      } catch (error) {
        ctx.ui.notify(formatError(error), 'error')
      }
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    activeSessionId = ctx.sessionManager.getSessionId()
    context = ctx
    restoreState(ctx)
    resetDeliveryQueue()
    resetActiveDelivery()
    unsubscribeSettings.forEach(unsubscribe => unsubscribe())
    unsubscribeSettings = [
      enabled.onChange(value => void restart(ctx, !value)),
      brokerUrl.onChange(() => void restart(ctx, true)),
      address.onChange(() => void restart(ctx, true)),
    ]
    await restart(ctx, false)
  })

  pi.on('message_start', (event, ctx) => {
    if (!useCurrentContext(ctx)) return
    const active = activeDelivery
    if (!active || event.message.role !== 'user') return
    const text = userMessageText(event.message.content)
    if (text.startsWith(`${active.marker}\n`)) confirmActiveDelivery(active, ctx)
  })

  pi.on('agent_settled', (_event, ctx) => {
    if (!useCurrentContext(ctx) || !activeDelivery?.confirmed) return
    clearDeliveryStartTimer()
    activeDelivery = undefined
    awaitingSettlement = false
    drainDeliveries(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!isCurrentSession(ctx)) return
    activeSessionId = undefined
    context = undefined
    resetDeliveryQueue()
    resetActiveDelivery()
    unsubscribeSettings.forEach(unsubscribe => unsubscribe())
    unsubscribeSettings = []
    await stop()
  })

  function setSetting(key: string, value: string, scope: SettingsScope): void {
    if (key === 'broker-url') {
      assertLoopbackBrokerUrl(value)
      brokerUrl.set(value, { scope })
      return
    }
    if (key === 'address' || key === 'default-peer') {
      if (!isAddress(value)) throw new Error(`Invalid Synagent address: ${value}`)
      ;(key === 'address' ? address : defaultPeer).set(value, { scope })
      return
    }
    throw new Error(`Unknown Synagent setting: ${key}`)
  }

  function restart(ctx: ExtensionContext, removeSubscription: boolean): Promise<void> {
    if (removeSubscription) resetDeliveryQueue()
    const requestedGeneration = ++connectionGeneration
    lifecycle = lifecycle
      .then(async () => {
        if (requestedGeneration !== connectionGeneration) return
        const staleTopic = await disconnect(removeSubscription)
        if (requestedGeneration !== connectionGeneration || !isCurrentSession(ctx) || !enabled.get()) return
        start(ctx, staleTopic)
      })
      .catch(error => ctx.ui.notify(`Synagent restart failed: ${formatError(error)}`, 'error'))
    return lifecycle
  }

  function stop(): Promise<void> {
    ++connectionGeneration
    lifecycle = lifecycle.then(() => disconnect(false).then(() => undefined))
    return lifecycle
  }

  function start(ctx: ExtensionContext, staleTopic?: string): void {
    const url = brokerUrl.get()
    const ownAddress = address.get()
    try {
      assertLoopbackBrokerUrl(url)
      if (!isAddress(ownAddress)) throw new Error(`Invalid Synagent address: ${ownAddress}`)
    } catch (error) {
      ctx.ui.notify(formatError(error), 'error')
      return
    }

    const topic = `a4s/inbox/${ownAddress}`
    const previousTopic = lastSubscribedAddress && lastSubscribedAddress !== ownAddress
      ? `a4s/inbox/${lastSubscribedAddress}`
      : undefined
    const topicsToRemove = [...new Set([staleTopic, previousTopic].filter((value): value is string =>
      typeof value === 'string' && value !== topic,
    ))]
    const sessionId = ctx.sessionManager.getSessionId()
    const active = connect(url, {
      clean: false,
      clientId: `a4s-pi-${sessionId}`,
      reconnectPeriod: 1000,
    })
    client = active
    subscribedTopic = topic
    let lastError = ''

    active.on('connect', () => {
      if (client !== active) return
      const subscribeCurrent = (): void => {
        subscribedTopic = topic
        active.subscribe(topic, { qos: 1 }, error => {
          if (client !== active) return
          if (error) {
            ctx.ui.notify(`Synagent subscribe failed: ${error.message}`, 'error')
            return
          }
          subscribedTopic = topic
          lastError = ''
          if (lastSubscribedAddress !== ownAddress) {
            lastSubscribedAddress = ownAddress
            pi.appendEntry<StateEntry>(STATE_ENTRY, { address: ownAddress })
          }
          ctx.ui.notify(`Synagent subscribed to ${topic}`, 'info')
        })
      }
      if (topicsToRemove.length === 0) {
        subscribeCurrent()
        return
      }
      active.unsubscribe(topicsToRemove, error => {
        if (client !== active) return
        if (error) ctx.ui.notify(`Synagent stale subscription cleanup failed: ${error.message}`, 'warning')
        subscribeCurrent()
      })
    })
    active.on('message', (receivedTopic, payload) => {
      if (receivedTopic !== topic || client !== active) return
      enqueueDelivery(payload.toString(), ownAddress, ctx)
    })
    active.on('error', error => {
      if (error.message === lastError) return
      lastError = error.message
      ctx.ui.notify(`Synagent connection error: ${error.message}`, 'error')
    })
  }

  async function disconnect(removeSubscription: boolean): Promise<string | undefined> {
    const active = client
    const oldTopic = subscribedTopic
    client = undefined
    subscribedTopic = undefined
    if (!active) return removeSubscription ? oldTopic : undefined

    let staleTopic = removeSubscription ? oldTopic : undefined
    if (staleTopic && active.connected) {
      try {
        await unsubscribe(active, staleTopic)
        staleTopic = undefined
      } catch {
        // The next connection with this session-scoped client id retries cleanup.
      }
    }
    active.removeAllListeners()
    await new Promise<void>((resolve, reject) => {
      active.end(false, {}, error => error ? reject(error) : resolve())
    })
    return staleTopic
  }

  function enqueueDelivery(text: string, ownAddress: string, ctx: ExtensionContext): void {
    if (!isCurrentSession(ctx)) return
    let message: CanonicalMessage
    try {
      message = parseCanonical(text)
    } catch (error) {
      ctx.ui.notify(`Synagent ignored invalid message: ${formatError(error)}`, 'warning')
      return
    }
    if (!isFor(message, ownAddress) || seen.has(message.id)) return

    seen.add(message.id)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string)
    pi.appendEntry<SeenEntry>(SEEN_ENTRY, { id: message.id })
    queuedDeliveries.push({ generation: deliveryGeneration, message })
    drainDeliveries(context ?? ctx)
  }

  function drainDeliveries(ctx: ExtensionContext): void {
    if (!useCurrentContext(ctx) || awaitingSettlement) return
    while (queuedDeliveries.length > 0) {
      const queued = queuedDeliveries.shift() as QueuedDelivery
      if (queued.generation !== deliveryGeneration) continue
      const wasIdle = ctx.isIdle()
      let mode: DeliveryMode = 'followUp'
      if (wasIdle) mode = 'idle'
      else if (queued.message.kind === 'steer') mode = 'steer'
      try {
        awaitingSettlement = true
        const dispatchToken = ++deliveryDispatchToken
        const marker = `[synagent-delivery ${randomUUID()}]`
        const rendered = `${marker}\n${renderForAgent(queued.message)}`
        activeDelivery = {
          confirmed: false,
          id: queued.message.id,
          marker,
          mode,
          token: dispatchToken,
        }
        armDeliveryStartTimeout(
          dispatchToken,
          queued.message.id,
          ctx,
          'message_start',
        )
        if (mode === 'idle') pi.sendUserMessage(rendered)
        else if (mode === 'steer') pi.sendUserMessage(rendered, { deliverAs: 'steer' })
        else pi.sendUserMessage(rendered, { deliverAs: 'followUp' })
      } catch (error) {
        clearDeliveryStartTimer()
        activeDelivery = undefined
        awaitingSettlement = false
        ctx.ui.notify(`Synagent delivery failed: ${formatError(error)}`, 'error')
        continue
      }
      return
    }
  }

  function confirmActiveDelivery(active: ActiveDelivery, ctx: ExtensionContext): void {
    if (activeDelivery !== active || active.token !== deliveryDispatchToken) return
    active.confirmed = true
    armDeliveryStartTimeout(active.token, active.id, ctx, 'agent_settled')
  }

  function armDeliveryStartTimeout(
    dispatchToken: number,
    messageId: string,
    ctx: ExtensionContext,
    expectedEvent: 'message_start' | 'agent_settled',
  ): void {
    clearDeliveryStartTimer()
    deliveryStartTimer = setTimeout(() => {
      deliveryStartTimer = undefined
      if (!isCurrentSession(ctx) || !awaitingSettlement || dispatchToken !== deliveryDispatchToken) return
      ctx.ui.notify(
        `Synagent delivery reached no ${expectedEvent} before timeout: ${messageId}; `
        + 'use /synagent resume to override the ordering barrier',
        'warning',
      )
    }, deliveryStartTimeoutMs)
  }

  function clearDeliveryStartTimer(): void {
    if (deliveryStartTimer) clearTimeout(deliveryStartTimer)
    deliveryStartTimer = undefined
  }

  function isCurrentSession(ctx: ExtensionContext): boolean {
    return activeSessionId !== undefined && activeSessionId === ctx.sessionManager.getSessionId()
  }

  function useCurrentContext(ctx: ExtensionContext): boolean {
    if (!isCurrentSession(ctx)) return false
    context = ctx
    return true
  }

  function resetDeliveryQueue(): void {
    ++deliveryGeneration
    queuedDeliveries.length = 0
  }

  function resetActiveDelivery(): void {
    clearDeliveryStartTimer()
    ++deliveryDispatchToken
    activeDelivery = undefined
    awaitingSettlement = false
  }

  function restoreState(ctx: ExtensionContext): void {
    seen.clear()
    lastSubscribedAddress = undefined
    const branch = ctx.sessionManager.getBranch()
    const ids = branch
      .map(entry => {
        if (entry.type !== 'custom' || entry.customType !== SEEN_ENTRY || !('data' in entry)) return undefined
        return (entry.data as SeenEntry | undefined)?.id
      })
      .filter((id): id is string => typeof id === 'string')
      .slice(-MAX_SEEN)
    for (const id of ids) seen.add(id)

    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY || !('data' in entry)) continue
      const savedAddress = (entry.data as StateEntry | undefined)?.address
      if (typeof savedAddress === 'string' && isAddress(savedAddress)) lastSubscribedAddress = savedAddress
    }
  }
}

export default createSynagentPi()

function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const text: string[] = []
  for (const part of content) {
    if (
      typeof part === 'object'
      && part !== null
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
    ) text.push((part as { text: string }).text)
  }
  return text.join('\n')
}

function parseSendArgs(input: string, fallback: string): { to: string; body: string } | undefined {
  const raw = input.trim()
  if (!raw) return undefined
  const match = raw.match(/^([A-Za-z][\w-]*):\s*([\s\S]*)$/)
  if (match) {
    const body = (match[2] as string).trim()
    return body ? { to: match[1] as string, body } : undefined
  }
  return { to: fallback, body: raw }
}

function assertLoopbackBrokerUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid Synagent broker URL: ${value}`)
  }
  if (
    url.protocol !== 'mqtt:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash
  ) {
    throw new Error('Synagent broker URL must be an unauthenticated loopback mqtt:// URL')
  }
}

function publish(client: MqttClient, topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1 }, error => error ? reject(error) : resolve())
  })
}

function unsubscribe(client: MqttClient, topic: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.unsubscribe(topic, error => error ? reject(error) : resolve())
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
