import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
  createSynagentAdapter,
  type SynagentAdapterHost,
  type SynagentAdapterOptions,
} from '../session/engine.ts'
import { settingsPaths } from '../session/settings.ts'

export type SynagentOmpOptions = SynagentAdapterOptions

const OMP_HOST: SynagentAdapterHost = {
  displayName: 'omp',
  componentName: 'omp',
  harnessName: 'omp',
  scopeName: 'a4s.synagent.omp',
  diagnosticEventPrefix: 'synagent.omp',
  settleEventName: 'agent_end',
  settingsPaths: () => settingsPaths(undefined, { agentDirName: '.omp', legacySettings: false }),
  bindSettle(pi, release) {
    pi.on('agent_end', (event, ctx) => {
      if ('willContinue' in event && event.willContinue === true) return
      return release(ctx)
    })
  },
}

export function createSynagentOmp(options: SynagentOmpOptions = {}): (pi: ExtensionAPI) => void {
  return createSynagentAdapter(OMP_HOST, options)
}

export default createSynagentOmp()
