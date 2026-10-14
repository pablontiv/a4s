import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  createSynagentAdapter,
  type SynagentAdapterHost,
  type SynagentAdapterOptions,
} from '../session/engine.ts'
import { settingsPaths } from '../session/settings.ts'

export type SynagentPiOptions = SynagentAdapterOptions

const PI_HOST: SynagentAdapterHost = {
  displayName: 'Pi',
  componentName: 'pi',
  harnessName: 'pion',
  scopeName: 'a4s.synagent.pi',
  diagnosticEventPrefix: 'synagent.pi',
  settleEventName: 'agent_settled',
  settingsPaths,
  bindSettle(pi, release) {
    pi.on('agent_settled', (_event, ctx) => release(ctx))
  },
}

export function createSynagentPi(options: SynagentPiOptions = {}): (pi: ExtensionAPI) => void {
  return createSynagentAdapter(PI_HOST, options)
}

export default createSynagentPi()
