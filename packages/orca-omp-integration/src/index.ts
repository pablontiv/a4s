import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  createOrcaLifecycleGuard,
  type OrcaLifecycleGuardOptions,
} from './lifecycle-guard.ts'
import {
  createOrcaModelRouter,
  type OrcaModelRouterOptions,
} from './model-router.ts'

export interface OrcaOmpIntegrationOptions {
  lifecycle?: OrcaLifecycleGuardOptions
  routing?: OrcaModelRouterOptions
}

export function createOrcaOmpIntegration(options: OrcaOmpIntegrationOptions = {}) {
  const lifecycle = createOrcaLifecycleGuard(options.lifecycle)
  const routing = createOrcaModelRouter(options.routing)

  return function orcaOmpIntegration(pi: ExtensionAPI): void {
    lifecycle(pi)
    routing(pi)
  }
}

export {
  createOrcaLifecycleGuard,
  createOrcaModelRouter,
}
export type { OrcaLifecycleGuardOptions } from './lifecycle-guard.ts'
export type {
  OrcaModelRoute,
  OrcaModelRouterOptions,
} from './model-router.ts'

export default createOrcaOmpIntegration()
