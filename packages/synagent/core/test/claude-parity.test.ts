// Test de paridad: adapter.ts COPIA debe ser idéntica a protocol.ts + banner.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as sharedProtocol from '../protocol.ts'
import * as claudeProtocol from '../adapters/claude/hooks/adapter.ts'
const __dirname = dirname(fileURLToPath(import.meta.url))

const BANNER = `// GENERADO — copia de packages/synagent/core/protocol.ts. NO editar a mano.
// Regenerar: node adapters/claude/scripts/sync-protocol.mjs (desde packages/synagent/core).
// El plugin se instala copiándose solo; por eso lleva su propia copia del contrato.`

type SchemaVector = {
  name: string
  kind: string
  topic: string
  wire: string
  valid: boolean
  code?: string
}
type DeliveryResultVector = {
  name: string
  status: 'complete' | 'failed'
  wire: string
  valid: boolean
  code?: string
}
type Golden = {
  deliveryResultVectors: DeliveryResultVector[]
  schemaVectors: SchemaVector[]
}
type ProtocolContract = {
  assertSupportedTopicVersion(topic: string): void
  parseCanonical(wire: string): sharedProtocol.CanonicalMessage
  parseDeliveryResult(wire: string): sharedProtocol.DeliveryResult
}
type Evaluation = {
  accepted: boolean
  code: string
  message?: sharedProtocol.CanonicalMessage | sharedProtocol.DeliveryResult
}

const golden = JSON.parse(
  readFileSync(join(__dirname, 'golden-vectors.json'), 'utf8'),
) as Golden

function evaluate(protocol: ProtocolContract, vector: SchemaVector): Evaluation {
  try {
    protocol.assertSupportedTopicVersion(vector.topic)
    return {
      accepted: true,
      code: 'ACCEPT',
      message: protocol.parseCanonical(vector.wire),
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNCLASSIFIED'
    return { accepted: false, code }
  }
}

function evaluateDeliveryResult(protocol: ProtocolContract, vector: DeliveryResultVector): Evaluation {
  try {
    return {
      accepted: true,
      code: 'ACCEPT',
      message: protocol.parseDeliveryResult(vector.wire),
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNCLASSIFIED'
    return { accepted: false, code }
  }
}

test('claude-parity: adapter.ts === BANNER + protocol.ts', () => {
  const protocolPath = join(__dirname, '../protocol.ts')
  const adapterPath = join(__dirname, '../adapters/claude/hooks/adapter.ts')

  const protocolSrc = readFileSync(protocolPath, 'utf-8')
  const adapterSrc = readFileSync(adapterPath, 'utf-8')

  const expected = BANNER + '\n\n' + protocolSrc
  assert.equal(adapterSrc, expected, 'adapter.ts desincronizado; corré node adapters/claude/scripts/sync-protocol.mjs')
})

test('claude-parity: Pi/omp y Claude aceptan o rechazan los golden con el mismo código', () => {
  for (const kind of sharedProtocol.MESSAGE_KINDS) {
    assert.ok(golden.schemaVectors.some(vector => vector.kind === kind && vector.valid), `${kind}: falta válido`)
    assert.ok(golden.schemaVectors.some(vector => vector.kind === kind && !vector.valid), `${kind}: falta inválido`)
  }
  assert.ok(golden.schemaVectors.some(vector => vector.code === 'VERSION_UNSUPPORTED'), 'falta versión desconocida')

  for (const vector of golden.schemaVectors) {
    const shared = evaluate(sharedProtocol, vector)
    const claude = evaluate(claudeProtocol, vector)
    assert.deepEqual(claude, shared, vector.name)
    assert.equal(shared.accepted, vector.valid, vector.name)
    assert.equal(shared.code, vector.valid ? 'ACCEPT' : vector.code, vector.name)
  }
})

test('claude-parity: resultados de entrega usan el mismo esquema v2', () => {
  for (const status of ['complete', 'failed'] as const) {
    assert.ok(golden.deliveryResultVectors.some(vector => vector.status === status && vector.valid), `${status}: falta válido`)
    assert.ok(golden.deliveryResultVectors.some(vector => vector.status === status && !vector.valid), `${status}: falta inválido`)
  }
  for (const vector of golden.deliveryResultVectors) {
    const shared = evaluateDeliveryResult(sharedProtocol, vector)
    const claude = evaluateDeliveryResult(claudeProtocol, vector)
    assert.deepEqual(claude, shared, vector.name)
    assert.equal(shared.accepted, vector.valid, vector.name)
    assert.equal(shared.code, vector.valid ? 'ACCEPT' : vector.code, vector.name)
  }
})
