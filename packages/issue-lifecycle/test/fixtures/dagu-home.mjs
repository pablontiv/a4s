import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test-file process gets its own home, even when a gate inherits the live
// station's environment. Isolate HOME too: sparse child environments can omit
// DAGU_HOME and fall back to ~/.dagu. Never inspect or clean up inherited homes.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'a4s-test-dagu-')))
process.env.DAGU_HOME = home
process.env.HOME = home
process.once('exit', () => rmSync(home, { recursive: true, force: true }))
