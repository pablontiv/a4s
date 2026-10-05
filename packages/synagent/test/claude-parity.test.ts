// Test de paridad: adapter.ts COPIA debe ser idéntica a protocol.ts + banner.
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const BANNER = `// GENERADO — copia de packages/synagent/protocol.ts. NO editar a mano.
// Regenerar: node adapters/claude/scripts/sync-protocol.mjs (desde packages/synagent).
// El plugin se instala copiándose solo; por eso lleva su propia copia del contrato.`

test('claude-parity: adapter.ts === BANNER + protocol.ts', () => {
  const protocolPath = join(__dirname, '../protocol.ts')
  const adapterPath = join(__dirname, '../adapters/claude/hooks/adapter.ts')

  const protocolSrc = readFileSync(protocolPath, 'utf-8')
  const adapterSrc = readFileSync(adapterPath, 'utf-8')

  const expected = BANNER + '\n\n' + protocolSrc
  assert.equal(adapterSrc, expected, 'adapter.ts desincronizado; corré node adapters/claude/scripts/sync-protocol.mjs')
})
