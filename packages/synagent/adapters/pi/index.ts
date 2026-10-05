import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { ExtensionAPI, ExtensionContext, SettingsScope } from '@pablontiv/pion'
import { connect, type MqttClient } from 'mqtt'
import { Type } from 'typebox'

import {
  acceptInbound,
  directAddress,
  instanceFromHostSession,
  isAddress,
  isBroadcastSteer,
  isToken,
  legacyTopic,
  makeOutbound,
  MESSAGE_KINDS,
  newId,
  parseCanonical,
  renderForAgent,
  resolveProject,
  serialize,
  subscriptions,
  type CanonicalMessage,
  type Identity,
  type MessageKind,
  type SubscriptionPlan,
} from '../../protocol.ts'

const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1884'
// Dirección LEGACY (plana) para dual-read durante el cutover a v1.
const DEFAULT_LEGACY_ADDRESS = 'pi'
const DEFAULT_PEER = 'claude'
const MAX_SEEN = 1000
const SEEN_ENTRY = 'synagent-delivered'
// Topics durables efectivamente suscritos; sirve para limpiar stale tras cambiar de identidad.
const STATE_ENTRY = 'synagent-state'
const DEFAULT_DELIVERY_START_TIMEOUT_MS = 30_000

type SeenEntry = { id: string }
type StateEntry = { topics: string }
type QueuedDelivery = { generation: number; message: CanonicalMessage }
type DeliveryMode = 'idle' | 'steer' | 'followUp'
type ActiveDelivery = {
  confirmed: boolean
  id: string
  marker: string
  mode: DeliveryMode
  token: number
}
type ClientRole = 'durable' | 'transient'
type SendResult = { ok: true; message: string } | { ok: false; message: string }

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
  const legacyAddressSetting = pi.registerSetting({
    key: 'a4s.synagent.address',
    schema: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' }),
    defaultValue: DEFAULT_LEGACY_ADDRESS,
    title: 'Synagent legacy address',
    description:
      'LEGACY flat address (a4s/inbox/<addr>) still accepted on receive for dual-read during the v1 cutover. '
      + 'Outbound traffic always uses the v1 hierarchical identity; this only widens what we accept.',
  })
  const projectSetting = pi.registerSetting({
    key: 'a4s.synagent.project',
    schema: Type.String(),
    defaultValue: '',
    title: 'Synagent project',
    description: 'Optional v1 project token. When empty it is derived from the session cwd git origin remote.',
  })
  const globalSetting = pi.registerSetting({
    key: 'a4s.synagent.global',
    schema: Type.Boolean(),
    defaultValue: false,
    title: 'Synagent global broadcast opt-in',
    description: 'Subscribe to the v1 global broadcast address (synagent/v1/all) in addition to the project broadcast.',
  })
  const defaultPeer = pi.registerSetting({
    key: 'a4s.synagent.default-peer',
    schema: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]*$' }),
    defaultValue: DEFAULT_PEER,
    title: 'Synagent default peer',
    description:
      'Recipient used by /mq-send when no address prefix is given. A bare token is qualified with our own project.',
  })

  let durable: MqttClient | undefined
  let transient: MqttClient | undefined
  let durableTopics: string[] = []
  let lastDurableTopics: string[] = []
  let persistedDurableTopics: string | undefined
  let identity: Identity | undefined
  let legacyOnly = false
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

  pi.registerTool({
    name: 'synagent_send',
    label: 'Send Synagent message',
    description:
      'Send a message to another agent through Synagent v1. Use only when the user asks to notify or message another agent or project, not for normal conversation. The body must be self-contained.',
    parameters: Type.Object({
      to: Type.String({ description: 'v1 address: <project>/<instance>, <project>/all, or all.' }),
      body: Type.String({ description: 'Self-contained message body.' }),
      kind: Type.Optional(Type.Union([
        Type.Literal('prompt'),
        Type.Literal('steer'),
        Type.Literal('result'),
        Type.Literal('notify'),
        Type.Literal('ack'),
      ], { description: 'Message kind; defaults to prompt.' })),
      reply_to: Type.Optional(Type.String({ description: 'Message id being replied to.' })),
    }),
    annotations: { openWorldHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await send(params, ctx)
      return {
        content: [{ type: 'text', text: result.message }],
        details: {},
        ...(result.ok ? {} : { isError: true }),
      }
    },
  })

  pi.registerCommand('mq-send', {
    description: 'Debug-only Synagent publish command',
    handler: async (args, ctx) => {
      const parsed = parseSendArgs(args, defaultPeer.get())
      if (!parsed) {
        ctx.ui.notify('Usage: /mq-send [to:] text (debug only)', 'warning')
        return
      }
      const result = await send(parsed, ctx)
      ctx.ui.notify(result.message, result.ok ? 'info' : 'error')
    },
  })

  pi.registerCommand('synagent', {
    description: 'Inspect or configure the Synagent Pi adapter',
    handler: async (args, ctx) => {
      useCurrentContext(ctx)
      const [action = 'status', key, ...rest] = args.trim().split(/\s+/)
      if (action === 'status') {
        let state = 'disabled'
        if (enabled.get()) state = durable?.connected ? 'connected' : 'connecting'
        const identityStatus = identity
          ? `address=${directAddress(identity)}`
          : 'address=unresolved legacy-only=true; remediate with /synagent set project <project> or configure remote.origin.url'
        ctx.ui.notify(
          `Synagent ${state}; ${identityStatus} legacy=${legacyAddressSetting.get()} `
          + `global=${globalSetting.get() === true} peer=${defaultPeer.get()} broker=${brokerUrl.get()}`,
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
        ctx.ui.notify(
          'Usage: /synagent status|enable|disable|resume|set '
          + '<broker-url|address|project|global|default-peer> <value>',
          'warning',
        )
        return
      }

      const value = rest.join(' ')
      try {
        setSetting(key, value, key === 'project' ? 'project' : 'global')
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
      legacyAddressSetting.onChange(() => void restart(ctx, true)),
      projectSetting.onChange(() => void restart(ctx, true)),
      globalSetting.onChange(() => void restart(ctx, true)),
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

  async function send(
    params: { to: string; body: string; kind?: string; reply_to?: string },
    ctx: ExtensionContext,
  ): Promise<SendResult> {
    if (!useCurrentContext(ctx)) return { ok: false, message: 'Synagent session is no longer active' }
    if (!params.body.trim()) return { ok: false, message: 'Synagent send requires a non-empty body' }
    const active = durable
    if (!active?.connected) return { ok: false, message: 'Synagent is not connected' }
    if (legacyOnly || !identity) {
      return {
        ok: false,
        message: 'Synagent cannot send: identity unresolved (legacy-only); configure the project setting or remote origin',
      }
    }
    const to = resolveDestination(params.to, identity)
    if (!to) return { ok: false, message: `Invalid Synagent address: ${params.to}` }
    const kind = params.kind ?? 'prompt'
    if (!MESSAGE_KINDS.includes(kind as MessageKind)) {
      return { ok: false, message: `Invalid Synagent kind: ${kind}` }
    }

    const ts = Date.now()
    try {
      const outbound = makeOutbound(identity, to, {
        body: params.body,
        kind: kind as MessageKind,
        id: newId(directAddress(identity), ts),
        ts,
        ...(params.reply_to ? { replyTo: params.reply_to } : {}),
      })
      await publish(active, outbound.topic, serialize(outbound.message))
      return { ok: true, message: `Synagent message sent: ${outbound.message.id}` }
    } catch (error) {
      return { ok: false, message: `Synagent publish failed: ${formatError(error)}` }
    }
  }

  function setSetting(key: string, value: string, scope: SettingsScope): void {
    if (key === 'broker-url') {
      assertLoopbackBrokerUrl(value)
      brokerUrl.set(value, { scope })
      return
    }
    if (key === 'address') {
      const token = value.trim()
      if (!isToken(token)) throw new Error(`Invalid Synagent legacy address: ${value}`)
      legacyAddressSetting.set(token, { scope })
      return
    }
    if (key === 'default-peer') {
      const peer = value.trim()
      if (!isAddress(peer) && !isToken(peer)) throw new Error(`Invalid Synagent peer: ${value}`)
      defaultPeer.set(peer, { scope })
      return
    }
    if (key === 'project') {
      const token = value.trim()
      if (!isToken(token)) throw new Error(`Invalid Synagent ${key}: ${value}`)
      projectSetting.set(token, { scope })
      return
    }
    if (key === 'global') {
      if (value !== 'true' && value !== 'false') throw new Error(`Invalid Synagent global (use true|false): ${value}`)
      globalSetting.set(value === 'true', { scope })
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
        const staleTopics = await disconnect(removeSubscription)
        if (requestedGeneration !== connectionGeneration || !isCurrentSession(ctx) || !enabled.get()) return
        start(ctx, staleTopics)
      })
      .catch(error => ctx.ui.notify(`Synagent restart failed: ${formatError(error)}`, 'error'))
    return lifecycle
  }

  function stop(): Promise<void> {
    ++connectionGeneration
    lifecycle = lifecycle.then(() => disconnect(false).then(() => undefined))
    return lifecycle
  }

  function start(ctx: ExtensionContext, staleFromDisconnect: string[] = []): void {
    const configuredUrl = brokerUrl.get()
    let url = configuredUrl
    try {
      assertLoopbackBrokerUrl(configuredUrl)
    } catch (error) {
      url = DEFAULT_BROKER_URL
      ctx.ui.notify(
        `Synagent broker URL rejected (${configuredUrl}); falling back to ${DEFAULT_BROKER_URL}`,
        'warning',
      )
    }

    const legacyAddress = legacyAddressSetting.get()
    const global = globalSetting.get() === true

    // Resolución de identidad; si lanza, operamos LEGACY-ONLY sin tumbar la sesión.
    let plan: SubscriptionPlan
    try {
      identity = computeIdentity(ctx)
      legacyOnly = false
      plan = subscriptions({ identity, global, legacyAddress })
      ctx.ui.notify(`Synagent identity ${directAddress(identity)} legacy=${legacyAddress} global=${global}`, 'info')
    } catch (error) {
      identity = undefined
      legacyOnly = true
      plan = { durable: [legacyTopic(legacyAddress)], transient: [] }
      ctx.ui.notify(
        `Synagent identity unresolved; operating legacy-only on ${legacyTopic(legacyAddress)}: ${formatError(error)}`,
        'warning',
      )
    }

    const sessionId = ctx.sessionManager.getSessionId()
    const newDurableTopics = [...plan.durable]
    durableTopics = newDurableTopics

    // Limpieza de suscripciones durables obsoletas (el cliente clean=false las retiene).
    const topicsToRemove = [...new Set([...staleFromDisconnect, ...lastDurableTopics])]
      .filter(topic => !newDurableTopics.includes(topic))

    durable = connectClient({
      ctx,
      url,
      clientId: `a4s-pi-${sessionId}`,
      clean: false,
      topics: newDurableTopics,
      staleTopics: topicsToRemove,
      role: 'durable',
    })

    transient = plan.transient.length > 0
      ? connectClient({
        ctx,
        url,
        clientId: `a4s-pi-${sessionId}:transient`,
        clean: true,
        topics: [...plan.transient],
        role: 'transient',
      })
      : undefined
  }

  function connectClient(opts: {
    ctx: ExtensionContext
    url: string
    clientId: string
    clean: boolean
    topics: string[]
    staleTopics?: string[]
    role: ClientRole
  }): MqttClient {
    const { ctx, url, clientId, clean, topics, role } = opts
    const staleTopics = opts.staleTopics ?? []
    const active = connect(url, { clean, clientId, reconnectPeriod: 1000 })
    let lastError = ''
    const isActive = (): boolean => (role === 'durable' ? durable === active : transient === active)

    active.on('connect', () => {
      if (!isActive()) return
      const subscribeCurrent = (): void => {
        if (topics.length === 0) return
        active.subscribe(topics, { qos: 1 }, error => {
          if (!isActive()) return
          if (error) {
            ctx.ui.notify(`Synagent subscribe failed: ${error.message}`, 'error')
            return
          }
          lastError = ''
          if (role === 'durable') {
            lastDurableTopics = [...topics]
            persistDurableTopics(topics)
          }
          ctx.ui.notify(`Synagent subscribed to ${topics.join(', ')}`, 'info')
        })
      }
      const stale = staleTopics.filter(topic => !topics.includes(topic))
      if (stale.length === 0) {
        subscribeCurrent()
        return
      }
      active.unsubscribe(stale, error => {
        if (!isActive()) return
        if (error) ctx.ui.notify(`Synagent stale subscription cleanup failed: ${error.message}`, 'warning')
        subscribeCurrent()
      })
    })
    active.on('message', (receivedTopic, payload) => {
      if (!isActive() || !topics.includes(receivedTopic)) return
      enqueueDelivery(payload.toString(), ctx)
    })
    active.on('error', error => {
      if (error.message === lastError) return
      lastError = error.message
      ctx.ui.notify(`Synagent connection error: ${error.message}`, 'error')
    })
    return active
  }

  async function disconnect(removeSubscription: boolean): Promise<string[]> {
    const activeDurable = durable
    const activeTransient = transient
    const oldDurableTopics = durableTopics
    durable = undefined
    transient = undefined
    durableTopics = []

    // El cliente transient es clean=true: su sesión no retiene suscripciones, basta cerrarlo.
    if (activeTransient) {
      activeTransient.removeAllListeners()
      await endClient(activeTransient)
    }

    if (!activeDurable) return removeSubscription ? oldDurableTopics : []

    let stale: string[] = []
    if (removeSubscription && oldDurableTopics.length > 0) {
      if (activeDurable.connected) {
        try {
          await unsubscribeAll(activeDurable, oldDurableTopics)
        } catch {
          // El próximo start con este clientId reintenta la limpieza.
          stale = oldDurableTopics
        }
      } else {
        stale = oldDurableTopics
      }
    }
    activeDurable.removeAllListeners()
    await endClient(activeDurable)
    return stale
  }

  function enqueueDelivery(text: string, ctx: ExtensionContext): void {
    if (!isCurrentSession(ctx)) return
    let message: CanonicalMessage
    try {
      message = parseCanonical(text)
    } catch (error) {
      ctx.ui.notify(`Synagent ignored invalid message: ${formatError(error)}`, 'warning')
      return
    }
    if (!acceptsMessage(message)) {
      if (isBroadcastSteer(message)) {
        ctx.ui.notify(`Synagent rejected broadcast steer: ${message.id}`, 'warning')
      }
      return
    }
    if (seen.has(message.id)) return

    seen.add(message.id)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string)
    pi.appendEntry<SeenEntry>(SEEN_ENTRY, { id: message.id })
    queuedDeliveries.push({ generation: deliveryGeneration, message })
    drainDeliveries(context ?? ctx)
  }

  function acceptsMessage(message: CanonicalMessage): boolean {
    const legacyAddress = legacyAddressSetting.get()
    if (legacyOnly || !identity) return message.to === legacyAddress && !isBroadcastSteer(message)
    return acceptInbound(identity, message, { global: globalSetting.get() === true, legacyAddress })
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

  function computeIdentity(ctx: ExtensionContext): Identity {
    const setting = emptyToUndefined(projectSetting.get())
    const origin = setting ? undefined : readGitRemote(ctx.cwd)
    return {
      project: resolveProject({ setting: setting!, origin: origin! }),
      instance: instanceFromHostSession(ctx.sessionManager.getSessionId()),
    }
  }

  function persistDurableTopics(topics: string[]): void {
    const joined = topics.join(',')
    if (joined === persistedDurableTopics) return
    persistedDurableTopics = joined
    pi.appendEntry<StateEntry>(STATE_ENTRY, { topics: joined })
  }

  function restoreState(ctx: ExtensionContext): void {
    seen.clear()
    lastDurableTopics = []
    persistedDurableTopics = undefined
    identity = undefined
    legacyOnly = false
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
      if (entry.type !== 'custom' || !('data' in entry)) continue
      if (entry.customType === STATE_ENTRY) {
        const topics = (entry.data as StateEntry | undefined)?.topics
        if (typeof topics === 'string' && topics.length > 0) {
          lastDurableTopics = topics.split(',').filter(Boolean)
          persistedDurableTopics = topics
        }
      }
    }
  }
}

export default createSynagentPi()

function resolveDestination(raw: string, identity: Identity): string | undefined {
  if (isAddress(raw)) return raw
  // Un token simple (p.ej. el default-peer) se cualifica con nuestro propio proyecto.
  if (isToken(raw)) {
    const qualified = `${identity.project}/${raw}`
    if (isAddress(qualified)) return qualified
  }
  return undefined
}

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
  // Prefijo de dirección: token plano o dirección v1 jerárquica (con '/').
  const match = raw.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*):\s*([\s\S]*)$/)
  if (match) {
    const body = (match[2] as string).trim()
    return body ? { to: match[1] as string, body } : undefined
  }
  return { to: fallback, body: raw }
}

function emptyToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readGitRemote(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8' }).trim()
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
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

function unsubscribeAll(client: MqttClient, topics: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    client.unsubscribe(topics, error => error ? reject(error) : resolve())
  })
}

function endClient(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.end(false, {}, error => error ? reject(error) : resolve())
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
