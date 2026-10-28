import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))

function assertAllowed(method, args) {
  const command = args[0]
  const options = Array.isArray(args[1]) ? args[2] : args[1]
  if (method !== 'fork' && method !== 'exec' && method !== 'execSync'
    && (command === 'git' || command === 'tar') && !options?.shell) return

  const test = process.argv[1] ? relative(root, process.argv[1]) : '<inline test>'
  const error = new Error(
    `Default test ${test} forbids child_process.${method}(${JSON.stringify(command)}). `
    + 'Only git and tar without a shell are allowed; inject a fake or move this case to test/live/.',
  )
  error.code = 'ERR_TEST_FORBIDDEN_SPAWN'
  Error.captureStackTrace(error, assertAllowed)
  throw error
}

for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[method]
  const guarded = function (...args) {
    assertAllowed(method, args)
    return Reflect.apply(original, this, args)
  }
  if (original[promisify.custom]) {
    guarded[promisify.custom] = function (...args) {
      assertAllowed(method, args)
      return Reflect.apply(original[promisify.custom], this, args)
    }
  }
  childProcess[method] = guarded
}

// Keep ESM named imports and CommonJS require('node:child_process') on the same guard.
syncBuiltinESMExports()
