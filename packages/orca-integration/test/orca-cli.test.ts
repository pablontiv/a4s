import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveOrcaCliPath } from '../src/orca-cli.ts'

test('resolves the Orca CLI using the managed-environment precedence', () => {
  assert.equal(resolveOrcaCliPath({
    ORCA_CLI_COMMAND: '/managed/orca',
    ORCA_DEV_REPO_ROOT: '/src/orca',
  }, 'linux'), '/managed/orca')
  assert.equal(resolveOrcaCliPath({ ORCA_DEV_REPO_ROOT: '/src/orca' }, 'darwin'), 'orca-dev')
  assert.equal(resolveOrcaCliPath({}, 'linux'), 'orca-ide')
  assert.equal(resolveOrcaCliPath({ ORCA_PANE_KEY: 'pane_1' }, 'linux'), 'orca')
  assert.equal(resolveOrcaCliPath({}, 'darwin'), 'orca')
})
