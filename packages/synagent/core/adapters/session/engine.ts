import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { connect, type MqttClient } from 'mqtt'
import { Type } from 'typebox'

import {
  classifyDiagnosticError,
  createDiagnostics,
  type DiagnosticEvent,
  type Diagnostics,
  type DiagnosticsOptions,
} from '../../diagnostics.ts'
import {
  DEFAULT_SETTINGS,
  assertLoopbackBrokerUrl,
  findRejectedBrokerUrl,
  initializeSynagentSettings,
  loadSynagentSettings,
  parseSettingValue,
  persistSetting,
  resetSetting,
  type SynagentSettingKey,
  type SynagentSettings,
  type SynagentSettingsPaths,
} from './settings.ts'
import {
  acceptInbound,
  deadLetterTopic,
  directAddress,
  instanceFromHostSession,
  isAddress,
  isBroadcastRedirect,
  isTaskRequestKind,
  isToken,
  makeOutbound,
  MESSAGE_KINDS,
  newId,
  parseCanonical,
  parseDeadLetter,
  renderForAgent,
  resolveProjectWithSource,
  serialize,
  serializeDeadLetter,
  subscriptions,
  SYNAGENT_SEND_KINDS,
  toTopic,
  type CanonicalMessage,
  type DeadLetterCause,
  type DeadLetterRecord,
  type Identity,
  type MessageKind,
  type SubscriptionPlan,
  type SynagentSendKind,
} from '../../protocol.ts'

const MAX_SEEN = 1000
const SEEN_ENTRY = 'synagent-delivered'
const PENDING_ENTRY = 'synagent-pending'
const REQUEST_ENTRY = 'synagent-request'
const DEAD_LETTER_ENTRY = 'synagent-dlq'
const DEAD_LETTER_RETRY_ENTRY = 'synagent-dlq-retry'
// Topics durables efectivamente suscritos; sirve para limpiar stale tras cambiar de identidad.
const STATE_ENTRY = 'synagent-state'
const DEFAULT_DELIVERY_START_TIMEOUT_MS = 30_000

type SeenEntry = { id: string }
type StateEntry = { topics: string }
type PendingEntry = { message: CanonicalMessage; marker: string; payload: string; sessionId: string }
type QueuedDelivery = PendingEntry & { generation: number }
type DeadLetterEntry = { record: DeadLetterRecord; retriedAt?: string }
type DeadLetterRetryEntry = { id: string; retriedAt: string }
type RequestStatus = 'pending' | 'delivered' | 'completed' | 'expired' | 'cancelled'
type RequestEntry = {
  deadline?: number
  id: string
  kind: 'task.request' | 'task.redirect'
  status: RequestStatus
  to: string
  ts: number
  updatedAt: number
}
const REQUEST_STATUS_LABEL: Readonly<Record<RequestStatus, string>> = {
  pending: 'pendiente',
  delivered: 'entregado',
  completed: 'completo',
  expired: 'vencido',
  cancelled: 'cancelado',
}
type DeliveryMode = 'idle' | 'steer' | 'followUp'
type DestinationScope = 'direct' | 'project' | 'global' | 'invalid'
type ActiveDelivery = {
  confirmed: boolean
  destinationScope: DestinationScope
  generation: number
  id: string
  kind: MessageKind
  marker: string
  message: CanonicalMessage
  mode: DeliveryMode
  payload: string
  token: number
}
export type DeliveryResultKey = Pick<ActiveDelivery, 'generation' | 'id' | 'marker' | 'token'>
export type DeliveryResultCapture = {
  start: (delivery: DeliveryResultKey) => void
  result: (delivery: DeliveryResultKey) => string | undefined
  reset: () => void
}

type AdapterDiagnosticEvent = DiagnosticEvent & { deliveryText?: string }
type ClientRole = 'durable' | 'transient'
type ProjectSource = ReturnType<typeof resolveProjectWithSource>['source']
type SendResult = { ok: true; message: string } | { ok: false; message: string }

export type SynagentAdapterOptions = {
  deliveryStartTimeoutMs?: number
  diagnostics?: Omit<DiagnosticsOptions, 'harnessName' | 'instanceId'>
}

export type SynagentAdapterHost = {
  displayName: string
  componentName: string
  harnessName: string
  scopeName: string
  diagnosticEventPrefix: string
  settleEventName: string
  settingsPaths: () => SynagentSettingsPaths
  bindSettle: (
    pi: ExtensionAPI,
    release: (ctx: ExtensionContext) => void | Promise<void>,
  ) => void
}

export function createSynagentAdapter(
  host: SynagentAdapterHost,
  options: SynagentAdapterOptions = {},
): (pi: ExtensionAPI) => void {
  const deliveryStartTimeoutMs = options.deliveryStartTimeoutMs ?? DEFAULT_DELIVERY_START_TIMEOUT_MS
  return pi => synagentAdapter(pi, host, deliveryStartTimeoutMs, options.diagnostics)
}

function synagentAdapter(
  pi: ExtensionAPI,
  host: SynagentAdapterHost,
  deliveryStartTimeoutMs: number,
  diagnosticsOptions?: Omit<DiagnosticsOptions, 'harnessName' | 'instanceId'>,
): void {
  let durable: MqttClient | undefined
  let transient: MqttClient | undefined
  let diagnostics: Diagnostics | undefined
  let durableTopics: string[] = []
  let lastDurableTopics: string[] = []
  let persistedDurableTopics: string | undefined
  let identity: Identity | undefined
  let identitySource: ProjectSource | undefined
  let dlqTopic: string | undefined
  let activeSessionId: string | undefined
  let context: ExtensionContext | undefined
  let lifecycle = Promise.resolve()
  let connectionGeneration = 0
  let deliveryGeneration = 0
  let deliveryDispatchToken = 0
  let deliveryStartTimer: NodeJS.Timeout | undefined
  let requestExpiryTimer: NodeJS.Timeout | undefined
  let activeDelivery: ActiveDelivery | undefined
  let awaitingSettlement = false
  let settings: SynagentSettings = { ...DEFAULT_SETTINGS }
  let activeSettingsPaths: SynagentSettingsPaths | undefined
  const queuedDeliveries: QueuedDelivery[] = []
  const deliveryResultCapture = createDeliveryResultCapture(pi)
  const seen = new Set<string>()
  const pending = new Map<string, PendingEntry>()
  const deadLetters = new Map<string, DeadLetterEntry>()
  const deadLetteredMessageIds = new Set<string>()
  const requests = new Map<string, RequestEntry>()

  pi.registerTool({
    name: 'synagent_send',
    label: 'Send Synagent message',
    description:
      'Send a task command or published note to another agent through Synagent v1. '
      + 'Use only when the user asks to message another agent or project. The body must be self-contained.',
    parameters: Type.Object({
      to: Type.String({ description: 'v1 address: <project>/<instance>, <project>/all, or all.' }),
      body: Type.String({ description: 'Self-contained message body.' }),
      kind: Type.Optional(Type.Union([
        Type.Literal('task.request'),
        Type.Literal('task.redirect'),
        Type.Literal('task.cancel'),
        Type.Literal('note.published'),
      ], { description: 'Message kind; defaults to task.request.' })),
      reply_to: Type.Optional(Type.String({ description: 'Message id being replied to or cancelled.' })),
      correlation_id: Type.Optional(Type.String({ description: 'Root command id for this message chain.' })),
      causation_id: Type.Optional(Type.String({ description: 'Message id that caused this message.' })),
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
      const parsed = parseSendArgs(args, settings['default-peer'])
      if (!parsed) {
        ctx.ui.notify('Usage: /mq-send [to:] text (debug only)', 'warning')
        return
      }
      const result = await send(parsed, ctx)
      ctx.ui.notify(result.message, result.ok ? 'info' : 'error')
    },
  })

  pi.registerCommand('synagent-settings', {
    description: 'Edit Synagent settings',
    handler: async (_args, ctx) => {
      await showSettings(ctx)
    },
  })

  pi.registerCommand('synagent', {
    description: `Inspect or configure the Synagent ${host.displayName} adapter`,
    handler: async (args, ctx) => {
      useCurrentContext(ctx)
      const [action = 'status', key, ...rest] = args.trim().split(/\s+/)
      if (action === 'status') {
        let state = 'disabled'
        if (settings.enabled) state = identity ? (durable?.connected ? 'connected' : 'connecting') : 'inactive'
        const identityStatus = identity
          ? `address=${directAddress(identity)} source=${identitySource}`
          : 'address=unresolved inactive=true; remediate by configuring remote.origin.url'
        const requestTtl = settings['request-ttl'] === undefined ? 'none' : `${settings['request-ttl']}s`
        ctx.ui.notify(
          `Synagent ${state}; ${identityStatus} global=${settings.global} `
          + `peer=${settings['default-peer']} broker=${settings['broker-url']} request-ttl=${requestTtl}`,
          'info',
        )
        return
      }
      if (action === 'enable' || action === 'disable') {
        try {
          await applySetting('enabled', action === 'enable', ctx)
          ctx.ui.notify(`Synagent ${action === 'enable' ? 'enabled' : 'disabled'}`, 'info')
        } catch (error) {
          ctx.ui.notify(formatError(error), 'error')
        }
        return
      }
      if (action === 'pending') {
        expireTrackedRequests(ctx, Date.now())
        ctx.ui.notify(formatRequestRegistry(), 'info')
        return
      }
      if (action === 'dlq') {
        if (key === undefined) {
          ctx.ui.notify(formatDeadLetterRegistry(), 'info')
          return
        }
        if (key === 'retry' && rest.length === 1) {
          const result = await retryDeadLetter(rest[0] as string)
          ctx.ui.notify(result.message, result.ok ? 'info' : 'warning')
          return
        }
        ctx.ui.notify('Usage: /synagent dlq [retry <id>]', 'warning')
        return
      }
      if (action === 'cancel' && key && rest.length === 0) {
        const request = requests.get(key)
        if (!request) {
          ctx.ui.notify(`Synagent request not found: ${key}`, 'warning')
          return
        }
        if (request.status !== 'pending') {
          ctx.ui.notify(`Synagent request ${key} is ${REQUEST_STATUS_LABEL[request.status]}; cancellation not sent`, 'info')
          return
        }
        const result = await send({
          to: request.to,
          body: `Cancel request ${request.id}`,
          kind: 'task.cancel',
          reply_to: request.id,
          correlation_id: request.id,
          causation_id: request.id,
        }, ctx)
        ctx.ui.notify(result.message, result.ok ? 'info' : 'error')
        return
      }
      if (action === 'resume') {
        if (!awaitingSettlement) {
          ctx.ui.notify('Synagent has no blocked delivery', 'info')
          return
        }
        const resumed = activeDelivery
        clearDeliveryStartTimer()
        ++deliveryDispatchToken
        activeDelivery = undefined
        deliveryResultCapture.reset()
        awaitingSettlement = false
        logDiagnostic('delivery.resumed', {
          operation: 'delivery.resume',
          queueDepth: queuedDeliveries.length,
          ...(resumed ? messageDiagnostic(resumed.id) : {}),
          ...(resumed ? {
            deliveryMode: resumed.mode,
            destinationScope: resumed.destinationScope,
            generation: resumed.generation,
            messageKind: resumed.kind,
            timeoutMs: deliveryStartTimeoutMs,
          } : {}),
        })
        ctx.ui.notify('Synagent delivery queue resumed manually; ordering is now best-effort', 'warning')
        drainDeliveries(ctx)
        return
      }
      if (action !== 'set' || !key || rest.length === 0) {
        ctx.ui.notify(
          'Usage: /synagent status|pending|dlq|dlq retry <id>|cancel <request-id>|enable|disable|resume|set '
          + '<enabled|broker-url|global|default-peer|request-ttl> <value>',
          'warning',
        )
        return
      }

      try {
        const settingKey = requireSettingKey(key)
        const value = parseSettingValue(settingKey, rest.join(' '))
        await applySetting(settingKey, value, ctx)
        ctx.ui.notify(`Synagent ${key} updated`, 'info')
      } catch (error) {
        ctx.ui.notify(formatError(error), 'error')
      }
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    logDiagnostic('shutdown', {
      operation: 'lifecycle.rebind',
      queueDepth: queuedDeliveries.length,
    })
    closeDiagnostics()
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      diagnostics = createDiagnostics({
        ...diagnosticsOptions,
        componentName: host.componentName,
        harnessName: host.harnessName,
        instanceId: sessionId,
        scopeName: host.scopeName,
      })
    } catch {
      diagnostics = undefined
    }
    activeSessionId = sessionId
    context = ctx
    activeSettingsPaths = host.settingsPaths()
    try {
      settings = initializeSynagentSettings(activeSettingsPaths)
    } catch (error) {
      settings = loadSynagentSettings(activeSettingsPaths)
      ctx.ui.notify(`Synagent settings migration failed: ${formatError(error)}`, 'warning')
    }
    const rejectedBrokerUrl = findRejectedBrokerUrl(activeSettingsPaths)
    if (rejectedBrokerUrl) {
      ctx.ui.notify(
        `Synagent broker URL rejected (${rejectedBrokerUrl}); falling back to ${settings['broker-url']}`,
        'warning',
      )
    }
    resetDeliveryQueue()
    resetActiveDelivery()
    clearRequestExpiryTimer()
    restoreState(ctx)
    scheduleRequestExpiry(ctx)
    logDiagnostic('started', {
      operation: 'lifecycle.start',
      generation: connectionGeneration,
      queueDepth: queuedDeliveries.length,
    })
    await restart(ctx, false)
    requeuePending(ctx)
  })

  pi.on('message_start', async (event, ctx) => {
    if (!useCurrentContext(ctx)) return
    const active = activeDelivery
    if (!active || event.message.role !== 'user') return
    const text = messageText(event.message.content)
    if (text.startsWith(`${active.marker}\n`)) await confirmActiveDelivery(active, ctx)
  })

  host.bindSettle(pi, releaseSettledDelivery)

  async function releaseSettledDelivery(ctx: ExtensionContext): Promise<void> {
    if (!useCurrentContext(ctx)) return
    const settled = activeDelivery
    if (settled?.confirmed) {
      const deliveryText = deliveryResultCapture.result(settled)
      clearDeliveryStartTimer()
      logDiagnostic('delivery.settled', {
        operation: 'delivery.settle',
        generation: settled.generation,
        queueDepth: queuedDeliveries.length,
        deliveryMode: settled.mode,
        destinationScope: settled.destinationScope,
        messageKind: settled.kind,
        ...(deliveryText === undefined ? {} : { deliveryText }),
        ...messageDiagnostic(settled.id),
      })
      if (isTaskRequestKind(settled.message.kind)) {
        await publishTaskEvent(settled.message, 'task.completed', deliveryText ?? '', ctx)
      }
      activeDelivery = undefined
      deliveryResultCapture.reset()
      awaitingSettlement = false
    }
    drainDeliveries(ctx)
  }

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!isCurrentSession(ctx)) return
    const shutdownQueueDepth = queuedDeliveries.length
    activeSessionId = undefined
    context = undefined
    clearRequestExpiryTimer()
    resetDeliveryQueue()
    resetActiveDelivery()
    activeSettingsPaths = undefined
    try {
      await stop()
      logDiagnostic('shutdown', {
        operation: 'lifecycle.shutdown',
        generation: connectionGeneration,
        queueDepth: shutdownQueueDepth,
      })
    } catch (error) {
      logDiagnostic('shutdown', {
        operation: 'lifecycle.shutdown',
        generation: connectionGeneration,
        queueDepth: shutdownQueueDepth,
        severity: 'ERROR',
        error: classifyDiagnosticError(error, 'SHUTDOWN_FAILED', 'shutdown', false, `${host.componentName}.lifecycle`),
      })
      throw error
    } finally {
      closeDiagnostics()
    }
  })

  async function send(
    params: {
      to: string
      body: string
      kind?: string
      reply_to?: string
      correlation_id?: string
      causation_id?: string
    },
    ctx: ExtensionContext,
  ): Promise<SendResult> {
    const kind = params.kind ?? 'task.request'
    const loggedKind = MESSAGE_KINDS.includes(kind as MessageKind) ? kind : 'invalid'
    const destinationScope = destinationScopeOf(params.to)
    const reject = (code: string, message: string, phase = 'message.send'): SendResult => {
      logDiagnostic('message.rejected', {
        operation: 'message.send',
        messageKind: loggedKind,
        destinationScope,
        queueDepth: queuedDeliveries.length,
        severity: 'WARN',
        error: classifyDiagnosticError(undefined, code, phase, false, `${host.componentName}.send`),
      })
      return { ok: false, message }
    }

    if (!useCurrentContext(ctx)) return reject('SESSION_INACTIVE', 'Synagent session is no longer active')
    if (!params.body.trim()) return reject('MESSAGE_BODY_EMPTY', 'Synagent send requires a non-empty body')
    const active = durable
    if (!active?.connected && !settings.enabled) return reject('ADAPTER_DISABLED', 'Synagent is not connected')
    if (!identity) {
      return reject(
        'IDENTITY_UNRESOLVED',
        'Synagent cannot send: identity unresolved; configure remote.origin.url',
        'identity.resolve',
      )
    }
    if (!active?.connected) return reject('MQTT_DISCONNECTED', 'Synagent is not connected', 'mqtt.connect')
    const to = resolveDestination(params.to, identity)
    if (!to) return reject('DESTINATION_INVALID', `Invalid Synagent address: ${params.to}`)
    if (!SYNAGENT_SEND_KINDS.includes(kind as SynagentSendKind)) {
      return reject('MESSAGE_KIND_INVALID', `Invalid Synagent kind: ${kind}`)
    }
    if (kind === 'task.cancel' && !params.reply_to) {
      return reject('CANCELLATION_TARGET_REQUIRED', 'Synagent task.cancel requires reply_to')
    }

    const ts = Date.now()
    const requestTtl = settings['request-ttl']
    const deadline = isTaskRequestKind(kind as MessageKind) && requestTtl !== undefined
      ? ts + requestTtl * 1000
      : undefined
    let messageId: string | undefined
    try {
      const outbound = makeOutbound(identity, to, {
        body: params.body,
        kind: kind as SynagentSendKind,
        id: newId(directAddress(identity), ts),
        ts,
        ...(params.reply_to ? { replyTo: params.reply_to } : {}),
        ...(params.correlation_id ? { correlationId: params.correlation_id } : {}),
        ...(params.causation_id ? { causationId: params.causation_id } : {}),
        ...(deadline === undefined ? {} : { deadline }),
      })
      messageId = outbound.message.id
      await publish(active, outbound.topic, serialize(outbound.message))
      if (isTaskRequestKind(outbound.message.kind)) recordOutgoingRequest(outbound.message, ctx)
      if (outbound.message.kind === 'task.cancel' && outbound.message.reply_to) {
        markRequestCancelled(outbound.message.reply_to, ctx, outbound.message.ts)
      }
      logDiagnostic('message.sent', {
        operation: 'message.send',
        messageKind: outbound.message.kind,
        destinationScope: destinationScopeOf(outbound.message.to),
        queueDepth: queuedDeliveries.length,
        ...messageDiagnostic(outbound.message.id),
      })
      return { ok: true, message: `Synagent message sent: ${outbound.message.id}` }
    } catch (error) {
      logDiagnostic('message.rejected', {
        operation: 'message.send',
        messageKind: loggedKind,
        destinationScope: destinationScopeOf(to),
        queueDepth: queuedDeliveries.length,
        severity: 'ERROR',
        ...(messageId ? messageDiagnostic(messageId) : {}),
        error: classifyDiagnosticError(error, 'MQTT_PUBLISH_FAILED', 'message.send', true, 'mqtt.publish'),
      })
      return { ok: false, message: `Synagent publish failed: ${formatError(error)}` }
    }
  }

  async function publishTaskEvent(
    command: CanonicalMessage,
    kind: 'task.delivered' | 'task.completed' | 'task.expired',
    body: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const active = durable
    const currentIdentity = identity
    if (!active?.connected || !currentIdentity) {
      logDiagnostic('message.rejected', {
        operation: 'message.send',
        messageKind: kind,
        destinationScope: destinationScopeOf(command.from),
        queueDepth: queuedDeliveries.length,
        severity: 'ERROR',
        ...messageDiagnostic(command.id),
        error: classifyDiagnosticError(
          undefined,
          'TASK_EVENT_PUBLISH_UNAVAILABLE',
          'message.send',
          true,
          `${host.componentName}.event`,
        ),
      })
      ctx.ui.notify(`Synagent could not publish ${kind} for ${command.id}: adapter disconnected`, 'error')
      return
    }

    const ts = Date.now()
    const eventId = newId(directAddress(currentIdentity), ts)
    try {
      const outbound = makeOutbound(currentIdentity, command.from, {
        body,
        kind,
        id: eventId,
        ts,
        replyTo: command.id,
        correlationId: command.correlation_id ?? command.id,
        causationId: command.id,
      })
      await publish(active, outbound.topic, serialize(outbound.message))
      logDiagnostic('message.sent', {
        operation: 'message.send',
        messageKind: kind,
        destinationScope: destinationScopeOf(command.from),
        queueDepth: queuedDeliveries.length,
        ...messageDiagnostic(eventId),
      })
    } catch (error) {
      logDiagnostic('message.rejected', {
        operation: 'message.send',
        messageKind: kind,
        destinationScope: destinationScopeOf(command.from),
        queueDepth: queuedDeliveries.length,
        severity: 'ERROR',
        ...messageDiagnostic(eventId),
        error: classifyDiagnosticError(error, 'TASK_EVENT_PUBLISH_FAILED', 'message.send', true, 'mqtt.publish'),
      })
      ctx.ui.notify(`Synagent failed to publish ${kind} for ${command.id}: ${formatError(error)}`, 'error')
    }
  }

  async function applySetting<K extends SynagentSettingKey>(
    key: K,
    value: SynagentSettings[K],
    ctx: ExtensionContext,
  ): Promise<void> {
    const paths = requireSettingsPaths()
    const previous = settings[key]
    persistSetting(paths, key, value)
    const next = loadSynagentSettings(paths)
    settings = next
    if (Object.is(previous, next[key]) || key === 'default-peer' || key === 'request-ttl') return
    void restart(ctx, key === 'enabled' ? next.enabled === false : true).then(() => requeuePending(ctx))
  }

  async function applyReset(key: SynagentSettingKey, ctx: ExtensionContext): Promise<void> {
    const paths = requireSettingsPaths()
    const previous = settings[key]
    resetSetting(paths, key)
    const next = loadSynagentSettings(paths)
    settings = next
    if (Object.is(previous, next[key]) || key === 'default-peer' || key === 'request-ttl') return
    void restart(ctx, key === 'enabled' ? next.enabled === false : true).then(() => requeuePending(ctx))
  }

  async function showSettings(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify('Synagent settings require an interactive UI', 'warning')
      return
    }
    if (!useCurrentContext(ctx)) {
      ctx.ui.notify('Synagent settings require an active session', 'warning')
      return
    }

    while (true) {
      const choice = await ctx.ui.select('Synagent settings', [
        `Enabled: ${settings.enabled}`,
        `Broker URL: ${settings['broker-url']}`,
        `Global broadcast: ${settings.global}`,
        `Default peer: ${settings['default-peer']}`,
        `Request TTL: ${settings['request-ttl'] === undefined ? 'none' : settings['request-ttl']}`,
        'Reset a setting',
        'Cancel',
      ])
      if (!choice || choice === 'Cancel') return
      try {
        if (choice.startsWith('Enabled:')) {
          const selected = await ctx.ui.select('Synagent enabled', ['true', 'false', 'Cancel'])
          if (selected && selected !== 'Cancel') {
            await applySetting('enabled', parseSettingValue('enabled', selected) as boolean, ctx)
          }
        } else if (choice.startsWith('Broker URL:')) {
          const value = await ctx.ui.input('Synagent broker URL', settings['broker-url'])
          if (value !== undefined) {
            await applySetting('broker-url', parseSettingValue('broker-url', value) as string, ctx)
          }
        } else if (choice.startsWith('Global broadcast:')) {
          const selected = await ctx.ui.select('Synagent global broadcast', ['true', 'false', 'Cancel'])
          if (selected && selected !== 'Cancel') {
            await applySetting('global', parseSettingValue('global', selected) as boolean, ctx)
          }
        } else if (choice.startsWith('Default peer:')) {
          const value = await ctx.ui.input('Synagent default peer', settings['default-peer'])
          if (value !== undefined) {
            await applySetting('default-peer', parseSettingValue('default-peer', value) as string, ctx)
          }
        } else if (choice.startsWith('Request TTL:')) {
          const placeholder = settings['request-ttl'] === undefined ? '' : String(settings['request-ttl'])
          const value = await ctx.ui.input('Synagent request TTL in seconds', placeholder)
          if (value !== undefined) {
            await applySetting('request-ttl', parseSettingValue('request-ttl', value) as number, ctx)
          }
        } else if (choice === 'Reset a setting') {
          const selected = await ctx.ui.select('Reset Synagent setting', [
            'enabled', 'broker-url', 'global', 'default-peer', 'request-ttl', 'Cancel',
          ])
          if (selected && selected !== 'Cancel') {
            const key = requireSettingKey(selected)
            if (await ctx.ui.confirm('Reset Synagent setting', `Reset ${key} to its inherited value?`)) {
              await applyReset(key, ctx)
            }
          }
        }
      } catch (error) {
        ctx.ui.notify(formatError(error), 'error')
      }
    }
  }

  function requireSettingsPaths(): SynagentSettingsPaths {
    if (!activeSettingsPaths) throw new Error('Synagent settings require an active session')
    return activeSettingsPaths
  }

  function restart(ctx: ExtensionContext, removeSubscription: boolean): Promise<void> {
    if (removeSubscription) resetDeliveryQueue()
    const requestedGeneration = ++connectionGeneration
    lifecycle = lifecycle
      .then(async () => {
        if (requestedGeneration !== connectionGeneration) return
        const staleTopics = await disconnect(removeSubscription)
        if (requestedGeneration !== connectionGeneration || !isCurrentSession(ctx) || !settings.enabled) return
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
    const configuredUrl = settings['broker-url']
    let url = configuredUrl
    try {
      assertLoopbackBrokerUrl(configuredUrl)
    } catch (error) {
      url = DEFAULT_SETTINGS['broker-url']
      ctx.ui.notify(
        `Synagent broker URL rejected (${configuredUrl}); falling back to ${DEFAULT_SETTINGS['broker-url']}`,
        'warning',
      )
    }

    const global = settings.global

    // Sin identidad v1 no hay ningún topic seguro al que suscribirse.
    let plan: SubscriptionPlan
    try {
      const resolved = computeIdentity(ctx)
      identity = resolved.identity
      identitySource = resolved.source
      dlqTopic = deadLetterTopic(identity)
      const basePlan = subscriptions({ identity, global })
      plan = {
        durable: [...basePlan.durable, dlqTopic],
        transient: basePlan.transient,
      }
      logDiagnostic('identity.resolved', {
        operation: 'identity.resolve',
        generation: connectionGeneration,
        queueDepth: queuedDeliveries.length,
      })
      ctx.ui.notify(
        `Synagent identity ${directAddress(identity)} source=${identitySource} global=${global}`,
        'info',
      )
    } catch (error) {
      identity = undefined
      identitySource = undefined
      dlqTopic = undefined
      plan = { durable: [], transient: [] }
      logDiagnostic('identity.failed', {
        operation: 'identity.resolve',
        generation: connectionGeneration,
        queueDepth: queuedDeliveries.length,
        severity: 'ERROR',
        error: classifyDiagnosticError(error, 'IDENTITY_UNRESOLVED', 'identity.resolve', false, `${host.componentName}.identity`),
      })
      ctx.ui.notify(
        `Synagent identity unresolved; adapter inactive until remote.origin.url is configured: ${formatError(error)}`,
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
    let active: MqttClient
    try {
      active = connect(url, { clean, clientId, reconnectPeriod: 1000 })
    } catch (error) {
      logDiagnostic('mqtt.failed', {
        operation: 'mqtt.connect',
        generation: connectionGeneration,
        role,
        queueDepth: queuedDeliveries.length,
        severity: 'ERROR',
        error: classifyDiagnosticError(error, 'MQTT_CONNECT_FAILED', 'mqtt.connect', true, 'mqtt.client'),
      })
      throw error
    }
    let lastError = ''
    const isActive = (): boolean => (role === 'durable' ? durable === active : transient === active)

    active.on('connect', () => {
      if (!isActive()) return
      logDiagnostic('mqtt.connected', {
        operation: 'mqtt.connect',
        generation: connectionGeneration,
        role,
        queueDepth: queuedDeliveries.length,
      })
      const subscribeCurrent = (): void => {
        if (topics.length === 0) return
        active.subscribe(topics, { qos: 1 }, error => {
          if (!isActive()) return
          if (error) {
            logDiagnostic('mqtt.failed', {
              operation: 'mqtt.subscribe',
              generation: connectionGeneration,
              role,
              queueDepth: queuedDeliveries.length,
              severity: 'ERROR',
              error: classifyDiagnosticError(error, 'MQTT_SUBSCRIBE_FAILED', 'mqtt.connect', true, 'mqtt.subscribe'),
            })
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
        if (error) {
          logDiagnostic('mqtt.failed', {
            operation: 'mqtt.unsubscribe',
            generation: connectionGeneration,
            role,
            queueDepth: queuedDeliveries.length,
            severity: 'WARN',
            error: classifyDiagnosticError(error, 'MQTT_UNSUBSCRIBE_FAILED', 'mqtt.connect', true, 'mqtt.unsubscribe'),
          })
          ctx.ui.notify(`Synagent stale subscription cleanup failed: ${error.message}`, 'warning')
        }
        subscribeCurrent()
      })
    })
    active.on('message', (receivedTopic, payload) => {
      if (!isActive() || !topics.includes(receivedTopic)) return
      const text = payload.toString()
      if (receivedTopic === dlqTopic) {
        receiveDeadLetter(text, ctx)
        return
      }
      enqueueDelivery(text, ctx)
    })
    active.on('error', error => {
      if (error.message === lastError) return
      lastError = error.message
      logDiagnostic('mqtt.failed', {
        operation: 'mqtt.connect',
        generation: connectionGeneration,
        role,
        queueDepth: queuedDeliveries.length,
        severity: 'ERROR',
        error: classifyDiagnosticError(error, 'MQTT_CONNECTION_FAILED', 'mqtt.connect', true, 'mqtt.client'),
      })
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
      try {
        // Unsubscribe from all topics before closing
        if (activeTransient.connected) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('unsubscribe timeout')), 500)
            activeTransient.unsubscribe('#', () => {
              clearTimeout(timeout)
              resolve()
            })
          })
        }
      } catch {
        // Ignore unsubscribe errors
      }
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

  function receiveDeadLetter(text: string, ctx: ExtensionContext): void {
    try {
      recordDeadLetter(parseDeadLetter(text), ctx)
    } catch (error) {
      ctx.ui.notify(`Synagent ignored invalid DLQ record: ${formatError(error)}`, 'warning')
    }
  }

  function recordDeadLetter(record: DeadLetterRecord, ctx: ExtensionContext): void {
    if (deadLetters.has(record.id)) return
    try {
      const message = parseCanonical(record.payload)
      pending.delete(message.id)
      deadLetteredMessageIds.add(message.id)
    } catch {}
    try {
      pi.appendEntry<DeadLetterRecord>(DEAD_LETTER_ENTRY, record)
      deadLetters.set(record.id, { record })
    } catch (error) {
      ctx.ui.notify(`Synagent DLQ index could not be persisted: ${formatError(error)}`, 'error')
    }
  }

  function publishDeadLetter(payload: string, cause: DeadLetterCause, ctx: ExtensionContext): void {
    const record: DeadLetterRecord = {
      id: randomUUID(),
      payload,
      cause,
      time: new Date().toISOString(),
      harness: host.harnessName,
    }
    recordDeadLetter(record, ctx)
    const active = durable
    const topic = dlqTopic
    if (!active?.connected || !topic) {
      ctx.ui.notify(`Synagent could not publish ${cause} to DLQ: adapter disconnected`, 'error')
      return
    }
    void publish(active, topic, serializeDeadLetter(record)).catch(error => {
      ctx.ui.notify(`Synagent DLQ publish failed: ${formatError(error)}`, 'error')
    })
  }

  async function retryDeadLetter(id: string): Promise<SendResult> {
    const entry = deadLetters.get(id)
    if (!entry) return { ok: false, message: `Synagent DLQ record not found: ${id}` }
    if (entry.retriedAt) return { ok: false, message: `Synagent DLQ record already retried: ${id}` }
    const active = durable
    const currentIdentity = identity
    if (!active?.connected || !currentIdentity) {
      return { ok: false, message: 'Synagent cannot retry DLQ record: adapter disconnected' }
    }
    const retriedAt = new Date().toISOString()
    try {
      pi.appendEntry<DeadLetterRetryEntry>(DEAD_LETTER_RETRY_ENTRY, { id, retriedAt })
    } catch (error) {
      return { ok: false, message: `Synagent DLQ retry could not be persisted: ${formatError(error)}` }
    }
    entry.retriedAt = retriedAt
    try {
      const message = parseCanonical(entry.record.payload)
      seen.delete(message.id)
      deadLetteredMessageIds.delete(message.id)
    } catch {}
    try {
      await publish(active, toTopic(directAddress(currentIdentity)), entry.record.payload)
      return { ok: true, message: `Synagent DLQ record reinjected: ${id}` }
    } catch (error) {
      return { ok: false, message: `Synagent DLQ reinjection failed: ${formatError(error)}` }
    }
  }

  function formatDeadLetterRegistry(): string {
    if (deadLetters.size === 0) return 'Synagent DLQ: vacía'
    const rows = [...deadLetters.values()].map(entry => {
      const status = entry.retriedAt ? `reintentado=${entry.retriedAt}` : 'estado=disponible'
      const { record } = entry
      return `${record.id} causa=${record.cause} hora=${record.time} harness=${record.harness} `
        + `${status} payload=${JSON.stringify(record.payload)}`
    })
    return `Synagent DLQ:\n${rows.join('\n')}`
  }

  function enqueueDelivery(text: string, ctx: ExtensionContext): void {
    if (!isCurrentSession(ctx)) return
    let message: CanonicalMessage
    try {
      message = parseCanonical(text)
    } catch (error) {
      let cause: DeadLetterCause = 'INVALID_MESSAGE'
      try {
        JSON.parse(text)
      } catch {
        cause = 'INVALID_JSON'
      }
      publishDeadLetter(text, cause, ctx)
      logDiagnostic('message.rejected', {
        operation: 'message.receive',
        destinationScope: 'invalid',
        queueDepth: queuedDeliveries.length,
        severity: 'WARN',
        error: classifyDiagnosticError(error, 'MESSAGE_INVALID', 'message.receive', false, 'protocol.parse'),
      })
      ctx.ui.notify(`Synagent ignored invalid message: ${formatError(error)}`, 'warning')
      return
    }
    const messageFields = {
      messageKind: message.kind,
      destinationScope: destinationScopeOf(message.to),
      ...messageDiagnostic(message.id),
    }
    if (!acceptsMessage(message)) {
      logDiagnostic('message.rejected', {
        operation: 'message.receive',
        queueDepth: queuedDeliveries.length,
        severity: 'WARN',
        ...messageFields,
        error: classifyDiagnosticError(
          undefined,
          isBroadcastRedirect(message) ? 'BROADCAST_REDIRECT_REJECTED' : 'DESTINATION_REJECTED',
          'message.receive',
          false,
          'protocol.accept',
        ),
      })
      if (isBroadcastRedirect(message)) {
        ctx.ui.notify(`Synagent rejected broadcast task.redirect: ${message.id}`, 'warning')
      }
      return
    }
    if (seen.has(message.id) || pending.has(message.id) || deadLetteredMessageIds.has(message.id)) {
      logDiagnostic('message.duplicate', {
        operation: 'message.receive',
        queueDepth: queuedDeliveries.length,
        ...messageFields,
      })
      return
    }

    logDiagnostic('message.received', {
      operation: 'message.receive',
      queueDepth: queuedDeliveries.length,
      ...messageFields,
    })
    if (message.kind === 'task.cancel') {
      applyInboundCancellation(message, ctx)
      return
    }
    updateRequestFromReply(message, ctx)
    if (message.kind === 'task.delivered') {
      rememberSeen(message.id)
      persistSeen(message.id, ctx)
      return
    }
    const delivery: PendingEntry = {
      marker: `[synagent-delivery ${randomUUID()}]`,
      message,
      payload: text,
      sessionId: ctx.sessionManager.getSessionId(),
    }
    try {
      pi.appendEntry<PendingEntry>(PENDING_ENTRY, delivery)
    } catch (error) {
      logPersistenceFailure(message, error, ctx, 'pending')
      return
    }
    pending.set(message.id, delivery)
    queuedDeliveries.push({ ...delivery, generation: deliveryGeneration })
    drainDeliveries(context ?? ctx)
  }

  function acceptsMessage(message: CanonicalMessage): boolean {
    if (!identity) return false
    return acceptInbound(identity, message, { global: settings.global })
  }

  function drainDeliveries(ctx: ExtensionContext): void {
    if (!useCurrentContext(ctx) || awaitingSettlement) return
    while (queuedDeliveries.length > 0) {
      const queued = queuedDeliveries[0] as QueuedDelivery
      if (queued.generation !== deliveryGeneration) {
        queuedDeliveries.shift()
        continue
      }
      const now = Date.now()
      if (queued.message.deadline !== undefined && now >= queued.message.deadline) {
        queuedDeliveries.shift()
        pending.delete(queued.message.id)
        rememberSeen(queued.message.id)
        persistSeen(queued.message.id, ctx)
        logDiagnostic('request.expired', {
          operation: 'request.expire',
          queueDepth: queuedDeliveries.length,
          messageKind: queued.message.kind,
          destinationScope: destinationScopeOf(queued.message.to),
          ...messageDiagnostic(queued.message.id),
        })
        void publishTaskEvent(queued.message, 'task.expired', JSON.stringify({
          event: 'request.expired',
          deadline: queued.message.deadline,
          expired_at: now,
        }), ctx)
        continue
      }
      const wasIdle = ctx.isIdle()
      if (queued.message.kind === 'task.request' && queued.message.deadline !== undefined && !wasIdle) return
      queuedDeliveries.shift()
      let mode: DeliveryMode = 'followUp'
      if (wasIdle) mode = 'idle'
      else if (queued.message.kind === 'task.redirect') mode = 'steer'
      try {
        awaitingSettlement = true
        const dispatchToken = ++deliveryDispatchToken
        const marker = queued.marker
        const rendered = `${marker}\n${renderForAgent(queued.message)}`
        activeDelivery = {
          confirmed: false,
          destinationScope: destinationScopeOf(queued.message.to),
          generation: queued.generation,
          id: queued.message.id,
          kind: queued.message.kind,
          marker,
          message: queued.message,
          mode,
          payload: queued.payload,
          token: dispatchToken,
        }
        deliveryResultCapture.start(activeDelivery)
        armDeliveryStartTimeout(
          dispatchToken,
          queued.message.id,
          ctx,
          'message_start',
        )
        if (mode === 'idle') pi.sendUserMessage(rendered)
        else if (mode === 'steer') pi.sendUserMessage(rendered, { deliverAs: 'steer' })
        else pi.sendUserMessage(rendered, { deliverAs: 'followUp' })
        logDiagnostic('delivery.dispatched', {
          operation: 'delivery.dispatch',
          generation: queued.generation,
          queueDepth: queuedDeliveries.length,
          deliveryMode: mode,
          timeoutMs: deliveryStartTimeoutMs,
          messageKind: queued.message.kind,
          destinationScope: destinationScopeOf(queued.message.to),
          ...messageDiagnostic(queued.message.id),
        })
      } catch (error) {
        clearDeliveryStartTimer()
        activeDelivery = undefined
        deliveryResultCapture.reset()
        awaitingSettlement = false
        logDiagnostic('delivery.failed', {
          operation: 'delivery.dispatch',
          generation: queued.generation,
          queueDepth: queuedDeliveries.length,
          deliveryMode: mode,
          messageKind: queued.message.kind,
          destinationScope: destinationScopeOf(queued.message.to),
          severity: 'ERROR',
          ...messageDiagnostic(queued.message.id),
          error: classifyDiagnosticError(error, 'DELIVERY_DISPATCH_FAILED', 'delivery.dispatch', false, `${host.harnessName}.sendUserMessage`),
        })
        publishDeadLetter(queued.payload, 'DELIVERY_DISPATCH_FAILED', ctx)
        ctx.ui.notify(`Synagent delivery failed: ${formatError(error)}`, 'error')
        continue
      }
      return
    }
  }

  async function confirmActiveDelivery(active: ActiveDelivery, ctx: ExtensionContext): Promise<void> {
    if (activeDelivery !== active || active.token !== deliveryDispatchToken || active.confirmed) return
    persistSeen(active.id, ctx)
    pending.delete(active.id)
    rememberSeen(active.id)
    active.confirmed = true
    logDiagnostic('delivery.confirmed', {
      operation: 'delivery.confirm',
      generation: active.generation,
      queueDepth: queuedDeliveries.length,
      deliveryMode: active.mode,
      destinationScope: active.destinationScope,
      messageKind: active.kind,
      timeoutMs: deliveryStartTimeoutMs,
      ...messageDiagnostic(active.id),
    })
    if (isTaskRequestKind(active.message.kind)) {
      await publishTaskEvent(active.message, 'task.delivered', '', ctx)
    }
    armDeliveryStartTimeout(active.token, active.id, ctx, host.settleEventName)
  }

  function armDeliveryStartTimeout(
    dispatchToken: number,
    messageId: string,
    ctx: ExtensionContext,
    expectedEvent: string,
  ): void {
    clearDeliveryStartTimer()
    deliveryStartTimer = setTimeout(() => {
      deliveryStartTimer = undefined
      if (!isCurrentSession(ctx) || !awaitingSettlement || dispatchToken !== deliveryDispatchToken) return
      logDiagnostic('delivery.timeout', {
        operation: expectedEvent === 'message_start' ? 'delivery.confirm' : 'delivery.settle',
        queueDepth: queuedDeliveries.length,
        ...(activeDelivery ? {
          deliveryMode: activeDelivery.mode,
          destinationScope: activeDelivery.destinationScope,
          generation: activeDelivery.generation,
          messageKind: activeDelivery.kind,
        } : {}),
        timeoutMs: deliveryStartTimeoutMs,
        severity: 'WARN',
        ...messageDiagnostic(messageId),
        error: classifyDiagnosticError(
          undefined,
          expectedEvent === 'message_start' ? 'DELIVERY_CONFIRM_TIMEOUT' : 'DELIVERY_SETTLE_TIMEOUT',
          'delivery.timeout',
          false,
          `${host.harnessName}.lifecycle`,
        ),
      })
      if (activeDelivery) publishDeadLetter(activeDelivery.payload, 'DELIVERY_TIMEOUT', ctx)
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
    deliveryResultCapture.reset()
  }

  function resetActiveDelivery(): void {
    clearDeliveryStartTimer()
    ++deliveryDispatchToken
    activeDelivery = undefined
    deliveryResultCapture.reset()
    awaitingSettlement = false
  }

  function logDiagnostic(eventName: string, event: AdapterDiagnosticEvent): void {
    try {
      diagnostics?.record(`${host.diagnosticEventPrefix}.${eventName}`, event)
    } catch {}
  }

  function closeDiagnostics(): void {
    const active = diagnostics
    diagnostics = undefined
    try {
      active?.close()
    } catch {}
  }

  function messageDiagnostic(messageId: string): Pick<DiagnosticEvent, 'messageId'> {
    return { messageId }
  }

  function resolveEffectiveProject(ctx: ExtensionContext): ReturnType<typeof resolveProjectWithSource> {
    const origin = readGitRemote(ctx.cwd)
    return resolveProjectWithSource(origin === undefined ? {} : { origin })
  }

  function computeIdentity(ctx: ExtensionContext): { identity: Identity; source: ProjectSource } {
    const resolved = resolveEffectiveProject(ctx)
    return {
      identity: {
        project: resolved.project,
        instance: instanceFromHostSession(ctx.sessionManager.getSessionId()),
      },
      source: resolved.source,
    }
  }

  function persistDurableTopics(topics: string[]): void {
    const joined = topics.join(',')
    if (joined === persistedDurableTopics) return
    persistedDurableTopics = joined
    pi.appendEntry<StateEntry>(STATE_ENTRY, { topics: joined })
  }

  function rememberSeen(id: string): void {
    seen.delete(id)
    seen.add(id)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string)
  }

  function persistSeen(id: string, ctx: ExtensionContext): void {
    try {
      pi.appendEntry<SeenEntry>(SEEN_ENTRY, { id })
    } catch (error) {
      logDiagnostic('delivery.failed', {
        operation: 'delivery.persist',
        queueDepth: queuedDeliveries.length,
        severity: 'ERROR',
        ...messageDiagnostic(id),
        error: classifyDiagnosticError(
          error,
          'DELIVERY_CONFIRM_PERSIST_FAILED',
          'delivery.persist',
          false,
          `${host.harnessName}.appendEntry`,
        ),
      })
      ctx.ui.notify(`Synagent delivery confirmation could not be persisted: ${formatError(error)}`, 'error')
    }
  }

  function logPersistenceFailure(
    message: CanonicalMessage,
    error: unknown,
    ctx: ExtensionContext,
    stage: 'pending',
  ): void {
    logDiagnostic('delivery.failed', {
      operation: 'delivery.persist',
      queueDepth: queuedDeliveries.length,
      messageKind: message.kind,
      destinationScope: destinationScopeOf(message.to),
      severity: 'ERROR',
      ...messageDiagnostic(message.id),
      error: classifyDiagnosticError(
        error,
        'DELIVERY_PENDING_PERSIST_FAILED',
        'delivery.persist',
        true,
        `${host.harnessName}.appendEntry.${stage}`,
      ),
    })
    ctx.ui.notify(`Synagent pending delivery could not be persisted: ${formatError(error)}`, 'error')
  }

  function applyInboundCancellation(message: CanonicalMessage, ctx: ExtensionContext): void {
    rememberSeen(message.id)
    persistSeen(message.id, ctx)
    const cancelledIndex = message.reply_to === undefined
      ? -1
      : queuedDeliveries.findIndex(delivery =>
          delivery.generation === deliveryGeneration
          && delivery.message.id === message.reply_to
          && delivery.message.from === message.from)
    if (cancelledIndex < 0) {
      logDiagnostic('request.cancel.missed', {
        operation: 'request.cancel',
        queueDepth: queuedDeliveries.length,
        messageKind: message.kind,
        destinationScope: destinationScopeOf(message.to),
        ...messageDiagnostic(message.id),
      })
      return
    }
    const [cancelled] = queuedDeliveries.splice(cancelledIndex, 1)
    if (!cancelled) return
    pending.delete(cancelled.message.id)
    rememberSeen(cancelled.message.id)
    persistSeen(cancelled.message.id, ctx)
    logDiagnostic('request.cancelled', {
      operation: 'request.cancel',
      queueDepth: queuedDeliveries.length,
      messageKind: cancelled.message.kind,
      destinationScope: destinationScopeOf(cancelled.message.to),
      ...messageDiagnostic(cancelled.message.id),
    })
  }

  function recordOutgoingRequest(message: CanonicalMessage, ctx: ExtensionContext): void {
    if (!isTaskRequestKind(message.kind)) return
    persistRequest({
      id: message.id,
      kind: message.kind,
      status: 'pending',
      to: message.to,
      ts: message.ts,
      updatedAt: message.ts,
      ...(message.deadline === undefined ? {} : { deadline: message.deadline }),
    }, ctx, true)
  }

  function markRequestCancelled(id: string, ctx: ExtensionContext, updatedAt: number): void {
    const request = requests.get(id)
    if (!request || request.status !== 'pending') return
    persistRequest({ ...request, status: 'cancelled', updatedAt }, ctx)
  }

  function updateRequestFromReply(message: CanonicalMessage, ctx: ExtensionContext): void {
    if (!message.reply_to) return
    const request = requests.get(message.reply_to)
    if (!request) return
    let status: RequestStatus
    if (message.kind === 'task.delivered') {
      if (request.status === 'completed' || request.status === 'expired') return
      status = 'delivered'
    } else if (message.kind === 'task.expired') {
      if (request.status === 'completed') return
      status = 'expired'
    } else {
      status = 'completed'
    }
    if (request.status === status) return
    persistRequest({ ...request, status, updatedAt: Date.now() }, ctx)
  }

  function persistRequest(
    request: RequestEntry,
    ctx: ExtensionContext,
    required = false,
    reschedule = true,
  ): void {
    requests.set(request.id, request)
    try {
      pi.appendEntry<RequestEntry>(REQUEST_ENTRY, request)
    } catch (error) {
      ctx.ui.notify(`Synagent request registry could not be persisted: ${formatError(error)}`, 'error')
      if (required) throw error
    } finally {
      if (reschedule) scheduleRequestExpiry(ctx)
    }
  }

  function expireTrackedRequests(ctx: ExtensionContext, now: number): void {
    for (const request of requests.values()) {
      if (request.status !== 'pending' || request.deadline === undefined || now < request.deadline) continue
      persistRequest({ ...request, status: 'expired', updatedAt: now }, ctx, false, false)
    }
    scheduleRequestExpiry(ctx)
  }

  function scheduleRequestExpiry(ctx: ExtensionContext): void {
    clearRequestExpiryTimer()
    let nextDeadline = Number.POSITIVE_INFINITY
    for (const request of requests.values()) {
      if (request.status === 'pending' && request.deadline !== undefined) {
        nextDeadline = Math.min(nextDeadline, request.deadline)
      }
    }
    if (!Number.isFinite(nextDeadline)) return
    const delay = Math.min(Math.max(0, nextDeadline - Date.now()), 2_147_483_647)
    requestExpiryTimer = setTimeout(() => {
      requestExpiryTimer = undefined
      if (!isCurrentSession(ctx)) return
      expireTrackedRequests(ctx, Date.now())
    }, delay)
  }

  function clearRequestExpiryTimer(): void {
    clearTimeout(requestExpiryTimer)
    requestExpiryTimer = undefined
  }

  function formatRequestRegistry(): string {
    if (requests.size === 0) return 'Synagent pedidos: ninguno'
    const rows = [...requests.values()].map(request => {
      const deadline = request.deadline === undefined ? 'sin-deadline' : String(request.deadline)
      return `${request.id} estado=${REQUEST_STATUS_LABEL[request.status]} to=${request.to} deadline=${deadline}`
    })
    return `Synagent pedidos:\n${rows.join('\n')}`
  }

  function requeuePending(ctx: ExtensionContext): void {
    if (!useCurrentContext(ctx) || !settings.enabled || !identity) return
    const sessionId = ctx.sessionManager.getSessionId()
    const alreadyQueued = new Set(queuedDeliveries.map(delivery => delivery.message.id))
    for (const delivery of pending.values()) {
      if (
        delivery.sessionId !== sessionId
        || delivery.message.id === activeDelivery?.id
        || alreadyQueued.has(delivery.message.id)
        || deadLetteredMessageIds.has(delivery.message.id)
        || !acceptsMessage(delivery.message)
      ) continue
      queuedDeliveries.push({ ...delivery, generation: deliveryGeneration })
      alreadyQueued.add(delivery.message.id)
    }
    drainDeliveries(ctx)
  }

  function parsePendingEntry(value: unknown): PendingEntry | undefined {
    if (
      typeof value !== 'object'
      || value === null
      || !('marker' in value)
      || !('sessionId' in value)
      || !('message' in value)
      || typeof value.marker !== 'string'
      || !value.marker.startsWith('[synagent-delivery ')
      || !value.marker.endsWith(']')
      || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0
    ) return undefined
    try {
      const message = parseCanonical(JSON.stringify(value.message))
      const payload = 'payload' in value && typeof value.payload === 'string'
        ? value.payload
        : serialize(message)
      return { marker: value.marker, message, payload, sessionId: value.sessionId }
    } catch {
      return undefined
    }
  }


  function parseRequestEntry(value: unknown): RequestEntry | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    if (
      !('id' in value)
      || !('kind' in value)
      || !('status' in value)
      || !('to' in value)
      || !('ts' in value)
      || !('updatedAt' in value)
      || typeof value.id !== 'string'
      || (value.kind !== 'task.request' && value.kind !== 'task.redirect')
      || typeof value.status !== 'string'
      || !Object.hasOwn(REQUEST_STATUS_LABEL, value.status)
      || typeof value.to !== 'string'
      || !isAddress(value.to)
      || typeof value.ts !== 'number'
      || !Number.isFinite(value.ts)
      || typeof value.updatedAt !== 'number'
      || !Number.isFinite(value.updatedAt)
      || ('deadline' in value && value.deadline !== undefined
        && (typeof value.deadline !== 'number' || !Number.isFinite(value.deadline)))
    ) return undefined
    return {
      id: value.id,
      kind: value.kind,
      status: value.status as RequestStatus,
      to: value.to,
      ts: value.ts,
      updatedAt: value.updatedAt,
      ...(!('deadline' in value) || value.deadline === undefined ? {} : { deadline: value.deadline as number }),
    }
  }

  function restoreState(ctx: ExtensionContext): void {
    seen.clear()
    pending.clear()
    deadLetters.clear()
    deadLetteredMessageIds.clear()
    requests.clear()
    lastDurableTopics = []
    persistedDurableTopics = undefined
    identity = undefined
    identitySource = undefined
    dlqTopic = undefined
    const branch = ctx.sessionManager.getBranch()
    const markers = new Map<string, string>()
    for (const entry of branch) {
      if (entry.type === 'custom' && 'data' in entry) {
        if (entry.customType === PENDING_ENTRY) {
          const delivery = parsePendingEntry(entry.data)
          if (
            delivery
            && !seen.has(delivery.message.id)
            && !deadLetteredMessageIds.has(delivery.message.id)
          ) {
            pending.set(delivery.message.id, delivery)
            markers.set(delivery.marker, delivery.message.id)
          }
        } else if (entry.customType === SEEN_ENTRY) {
          const data = entry.data
          if (typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string') {
            pending.delete(data.id)
            rememberSeen(data.id)
          }
        } else if (entry.customType === DEAD_LETTER_ENTRY) {
          try {
            const record = parseDeadLetter(JSON.stringify(entry.data))
            deadLetters.set(record.id, { record })
            try {
              const message = parseCanonical(record.payload)
              pending.delete(message.id)
              deadLetteredMessageIds.add(message.id)
            } catch {}
          } catch {}
        } else if (entry.customType === DEAD_LETTER_RETRY_ENTRY) {
          const data = entry.data
          if (
            typeof data === 'object'
            && data !== null
            && 'id' in data
            && 'retriedAt' in data
            && typeof data.id === 'string'
            && typeof data.retriedAt === 'string'
          ) {
            const deadLetter = deadLetters.get(data.id)
            if (deadLetter) {
              deadLetter.retriedAt = data.retriedAt
              try {
                const message = parseCanonical(deadLetter.record.payload)
                seen.delete(message.id)
                deadLetteredMessageIds.delete(message.id)
              } catch {}
            }
          }
        } else if (entry.customType === REQUEST_ENTRY) {
          const request = parseRequestEntry(entry.data)
          if (request) requests.set(request.id, request)
        } else if (entry.customType === STATE_ENTRY) {
          const data = entry.data
          if (
            typeof data === 'object'
            && data !== null
            && 'topics' in data
            && typeof data.topics === 'string'
            && data.topics.length > 0
          ) {
            lastDurableTopics = data.topics.split(',').filter(Boolean)
            persistedDurableTopics = data.topics
          }
        }
      } else if (entry.type === 'message' && entry.message.role === 'user') {
        const marker = messageText(entry.message.content).split('\n', 1)[0]
        if (!marker) continue
        const id = markers.get(marker)
        if (id) {
          pending.delete(id)
          rememberSeen(id)
        }
      }
    }
  }
}

function createDeliveryResultCapture(pi: ExtensionAPI): DeliveryResultCapture {
  let active: (DeliveryResultKey & {
    frozen: boolean
    lastText?: string
    started: boolean
  }) | undefined

  pi.on('message_start', event => {
    if (!active || event.message.role !== 'user') return
    const text = messageText(event.message.content)
    if (text.startsWith(`${active.marker}\n`)) {
      active.started = true
      return
    }
    if (active.started) active.frozen = true
  })

  pi.on('message_end', event => {
    if (!active?.started || active.frozen || event.message.role !== 'assistant') return
    const text = messageText(event.message.content)
    if (text.trim()) active.lastText = text
  })

  return {
    start(delivery) {
      active = { ...delivery, frozen: false, started: false }
    },
    result(delivery) {
      if (
        !active
        || active.id !== delivery.id
        || active.generation !== delivery.generation
        || active.marker !== delivery.marker
        || active.token !== delivery.token
      ) return undefined
      return active.lastText
    },
    reset() {
      active = undefined
    },
  }
}

function requireSettingKey(value: string): SynagentSettingKey {
  if (
    value === 'enabled'
    || value === 'broker-url'
    || value === 'global'
    || value === 'default-peer'
    || value === 'request-ttl'
  ) {
    return value
  }
  throw new Error(`Unknown Synagent setting: ${value}`)
}

function destinationScopeOf(destination: string): DestinationScope {
  if (destination === 'all') return 'global'
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/all$/.test(destination)) return 'project'
  if (isAddress(destination)) return 'direct'
  return 'invalid'
}

function resolveDestination(raw: string, identity: Identity): string | undefined {
  if (isAddress(raw)) return raw
  // Un token simple (p.ej. el default-peer) se cualifica con nuestro propio proyecto.
  if (isToken(raw)) {
    const qualified = `${identity.project}/${raw}`
    if (isAddress(qualified)) return qualified
  }
  return undefined
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const text: string[] = []
  for (const part of content) {
    if (
      typeof part === 'object'
      && part !== null
      && 'type' in part
      && part.type === 'text'
      && 'text' in part
      && typeof part.text === 'string'
    ) text.push(part.text)
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

function readGitRemote(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8' }).trim()
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

function publish(client: MqttClient, topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Set a timeout to prevent hanging if the callback never fires
    const timeout = setTimeout(() => {
      reject(new Error('publish timeout: callback did not fire within 5 seconds'))
    }, 5000)

    client.publish(topic, payload, { qos: 1 }, error => {
      clearTimeout(timeout)
      return error ? reject(error) : resolve()
    })
  })
}

function unsubscribeAll(client: MqttClient, topics: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    client.unsubscribe(topics, error => error ? reject(error) : resolve())
  })
}

function endClient(client: MqttClient): Promise<void> {
  return new Promise<void>((resolve) => {
    const mqttAny = client as any

    // Stop any reconnection attempts FIRST
    if (mqttAny.reconnecting !== undefined) {
      mqttAny.reconnecting = false
    }

    // Kill all timers that mqtt.js might have set up.
    // NOTE: This reaches into mqtt.js internal state and may need revisiting on an mqtt.js upgrade.
    const timersToKill = [
      'reconnectTimer',
      'keepaliveTimer',
      'pingTimer',
      'connackTimer',
      'pubackTimer',
      'pubrecTimer',
      'pubrelTimer',
      'pubcompTimer',
    ]
    timersToKill.forEach(timerName => {
      if (mqttAny[timerName]) {
        clearTimeout(mqttAny[timerName])
        clearInterval(mqttAny[timerName])
        mqttAny[timerName] = undefined
      }
    })

    // Remove all event listeners to break any pending callbacks
    client.removeAllListeners()

    // Set up close listener with timeout
    let closeTimeout: NodeJS.Timeout | undefined = setTimeout(() => {
      resolve()
    }, 500)

    client.once('close', () => {
      if (closeTimeout) {
        clearTimeout(closeTimeout)
        closeTimeout = undefined
      }
      resolve()
    })

    // Force destroy the underlying socket/stream immediately.
    // NOTE: Direct access to stream/socket is an mqtt.js internal detail; may require adjustment on upgrades.
    try {
      if (mqttAny.stream) {
        mqttAny.stream.destroy()
      }
      if (mqttAny.socket) {
        mqttAny.socket.destroy()
      }
    } catch {
      // Ignore errors
    }

    // Attempt to end the client
    try {
      client.end(true, () => {
        if (closeTimeout) {
          clearTimeout(closeTimeout)
          closeTimeout = undefined
        }
        resolve()
      })
    } catch {
      // If end() throws, resolve after timeout
      if (closeTimeout) {
        clearTimeout(closeTimeout)
        closeTimeout = undefined
      }
      resolve()
    }
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
