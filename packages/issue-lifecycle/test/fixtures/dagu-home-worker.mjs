import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

// Inherited --import preloads isolate the home, but tsx's source loader is not
// active in a new worker. Register it before loading the TypeScript fixtures.
register()
const { reconcileEnvironment } = await import('../role-job-fixtures.ts')
const { compiledArtifact } = await import('./admission.ts')

const env = reconcileEnvironment({ ...process.env, PRIMARY: workerData.primary, RUN: 'isolation' })
const empty = reconcileEnvironment({ ...process.env, RUNS: '[]' })
const fallbackHome = join(process.env.HOME, '.dagu')
compiledArtifact(fallbackHome)
parentPort.postMessage({ home: env.DAGU_HOME, emptyHome: empty.DAGU_HOME, fallbackHome })
