import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { reconcileEnvironment } from '../role-job-fixtures.ts'
import { compiledArtifact } from './admission.ts'

const env = reconcileEnvironment({ ...process.env, PRIMARY: workerData.primary, RUN: 'isolation' })
const empty = reconcileEnvironment({ ...process.env, RUNS: '[]' })
const fallbackHome = join(process.env.HOME, '.dagu')
compiledArtifact(fallbackHome)
parentPort.postMessage({ home: env.DAGU_HOME, emptyHome: empty.DAGU_HOME, fallbackHome })
