import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const core = fileURLToPath(new URL('../', import.meta.url))
const generator = 'adapters/claude/scripts/sync-diagnostics.mjs'
const artifacts = ['adapters/claude/diagnostics.ts', 'adapters/claude/bridge/diagnostics.cjs']

test('diagnostics generator reproduces committed artifacts and checks canonical changes', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synagent-diagnostics-generator-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(path.join(temp, 'adapters/claude/scripts'), { recursive: true })
  fs.mkdirSync(path.join(temp, 'adapters/claude/bridge'))
  for (const file of ['diagnostics.ts', generator]) {
    fs.copyFileSync(path.join(core, file), path.join(temp, file))
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(temp, generator), ...args], {
    cwd: os.tmpdir(), // Generation resolves paths from the script, not the cwd.
    encoding: 'utf8',
  })
  const generate = run()
  assert.equal(generate.status, 0, generate.stderr)
  assert.equal(generate.stdout, '')
  const expected = artifacts.map(file => fs.readFileSync(path.join(core, file), 'utf8'))
  const readArtifacts = () => artifacts.map(file => fs.readFileSync(path.join(temp, file), 'utf8'))
  assert.deepEqual(readArtifacts(), expected)
  assert.equal(run().status, 0)
  assert.deepEqual(readArtifacts(), expected)
  const check = run('--check')
  assert.equal(check.status, 0, check.stderr)
  assert.equal(check.stdout, '')

  fs.appendFileSync(path.join(temp, 'diagnostics.ts'), '\n// Canonical change for the drift check.\n')
  const stale = run('--check')
  assert.equal(stale.status, 1, stale.stderr)
  for (const file of artifacts) assert.ok(stale.stderr.includes(path.basename(file)))
  assert.deepEqual(readArtifacts(), expected, '--check preserves the current artifacts')
  assert.equal(run().status, 0)
  assert.equal(run('--check').status, 0)
  for (const content of readArtifacts()) assert.ok(content.includes('// Canonical change for the drift check.'))

  for (const file of artifacts) {
    const target = path.join(temp, file)
    const original = fs.readFileSync(target, 'utf8')
    fs.writeFileSync(target, `${original}\n// Artifact drift.\n`)
    assert.equal(run('--check').status, 1)
    fs.writeFileSync(target, original)
    fs.unlinkSync(target)
    assert.equal(run('--check').status, 1)
    fs.writeFileSync(target, original)
  }
  assert.equal(run('--check').status, 0)
})
