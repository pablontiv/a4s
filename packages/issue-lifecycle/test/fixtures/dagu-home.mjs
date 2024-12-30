import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test-file process gets its own explicitly declared station, even when
// a gate inherits the live station's environment. Never inspect or clean up
// inherited homes or step output files.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'a4s-test-dagu-')))
const bin = join(home, 'bin')
mkdirSync(bin)
for (const tool of ['bash', 'git', 'gh', 'jq', 'curl', 'node', 'omp', 'dagu']) {
  const file = join(bin, tool)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
}
const endpoint = 'http://127.0.0.1:18765'
const declaration = join(home, 'service-environment.json')
writeFileSync(declaration, JSON.stringify({ DAGU_URL: endpoint, DAGU_HOME: home, PATH: `${process.env.PATH}:${bin}` }))
process.env.A4S_SERVICE_ENV = declaration
process.env.DAGU_URL = endpoint
delete process.env.DAGU_PORT
process.env.PATH = `${process.env.PATH}:${bin}`
process.env.DAGU_HOME = home
process.env.HOME = home
process.env.DAGU_OUTPUT_FILE = join(home, 'step-output')
process.once('exit', () => rmSync(home, { recursive: true, force: true }))
