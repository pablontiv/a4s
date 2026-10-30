import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { tsImport } from 'tsx/esm/api'

// Load the fixture graph through tsx explicitly instead of depending on native
// TypeScript flags or a worker's inherited loader state.
const { reconcileEnvironment } = await tsImport('../role-job-fixtures.ts', import.meta.url)
const { compiledArtifact } = await tsImport('./admission.ts', import.meta.url)

const env = reconcileEnvironment({ ...process.env, PRIMARY: workerData.primary, RUN: 'isolation' })
const empty = reconcileEnvironment({ ...process.env, RUNS: '[]' })
const fallbackHome = join(process.env.HOME, '.dagu')
compiledArtifact(fallbackHome)
const stepOutput = process.env.DAGU_OUTPUT_FILE
appendFileSync(stepOutput, 'X=1\n')
parentPort.postMessage({ home: env.DAGU_HOME, emptyHome: empty.DAGU_HOME, fallbackHome,
  stepOutput, stepOutputContent: readFileSync(stepOutput, 'utf8') })
