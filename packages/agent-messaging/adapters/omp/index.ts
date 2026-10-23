import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  createAgentMessagingAdapter,
  type AgentMessagingAdapterHost,
  type AgentMessagingAdapterOptions,
} from '../session/engine.ts'
import { settingsPaths } from '../session/settings.ts'

export type AgentMessagingOmpOptions = AgentMessagingAdapterOptions

const OMP_HOST: AgentMessagingAdapterHost = {
  displayName: 'omp',
  componentName: 'omp',
  harnessName: 'omp',
  scopeName: 'a4s.agent-messaging.omp',
  diagnosticEventPrefix: 'a4s.agent-messaging.omp',
  settleEventName: 'agent_end',
  settingsPaths: () => settingsPaths(),
  bindSettle(pi, release) {
    pi.on('agent_end', (event, ctx) => {
      if ('willContinue' in event && event.willContinue === true) return
      if ('isTerminal' in event && event.isTerminal === false) return
      return release(ctx)
    })
  },
}

export function createAgentMessagingOmp(options: AgentMessagingOmpOptions = {}): (pi: ExtensionAPI) => void {
  return createAgentMessagingAdapter(OMP_HOST, options)
}

export default createAgentMessagingOmp()
