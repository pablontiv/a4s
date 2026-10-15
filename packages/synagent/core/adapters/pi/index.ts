import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  createSynagentAdapter,
  type DeliveryResultCapture,
  type DeliveryResultKey,
  type SynagentAdapterHost,
  type SynagentAdapterOptions,
} from '../session/engine.ts'
import { settingsPaths } from '../session/settings.ts'

export type SynagentPiOptions = SynagentAdapterOptions

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

const PI_HOST: SynagentAdapterHost = {
  displayName: 'Pi',
  componentName: 'pi',
  harnessName: 'pion',
  scopeName: 'a4s.synagent.pi',
  diagnosticEventPrefix: 'synagent.pi',
  settleEventName: 'agent_settled',
  settingsPaths,
  createDeliveryResultCapture,
  bindSettle(pi, release) {
    pi.on('agent_settled', (_event, ctx) => release(ctx))
  },
}

export function createSynagentPi(options: SynagentPiOptions = {}): (pi: ExtensionAPI) => void {
  return createSynagentAdapter(PI_HOST, options)
}

export default createSynagentPi()
