// Suite de CONFORMIDAD compartida (ADR 0069): verifica el core host-neutral TS
// (protocol.ts) contra los vectores dorados de `golden-vectors.json`. El CONTRATO
// que fijan los vectores —formato de wire, mapa dirección→topic y enrutado/
// aceptación— es independiente de lenguaje; todo adaptador debe reproducirlo EN
// SU PROPIO RUNTIME. Este test cubre los adaptadores JS que comparten protocol.ts
// (incluida la copia generada del plugin Claude, anclada por su test de paridad);
// Pi, en otro runtime, corre los mismos vectores por su lado — este archivo NO lo
// prueba.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  acceptInbound,
  isAddress,
  makeOutbound,
  parseDeliveryResult,
  parseCanonical,
  serialize,
  toTopic,
  type Identity,
} from '../protocol.ts'

type Vector = {
  name: string
  wire: string
  topic: string | null
  acceptPlain: boolean
  acceptGlobal: boolean
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
  identity: Identity
  legacyAddress: string
  routingVectors: Vector[]
}

const golden = JSON.parse(
  readFileSync(new URL('./golden-vectors.json', import.meta.url), 'utf8'),
) as Golden

test('golden: el wire re-serializa idéntico (estabilidad de formato cross-host)', () => {
  for (const v of golden.routingVectors) {
    assert.equal(serialize(parseCanonical(v.wire)), v.wire, v.name)
  }
})

test('golden: dirección→topic es la regla v2 (o null para legacy plano)', () => {
  for (const v of golden.routingVectors) {
    const { to } = parseCanonical(v.wire)
    if (v.topic === null) {
      assert.equal(isAddress(to), false, `${v.name}: legacy plano no es dirección canónica`)
    } else {
      assert.equal(toTopic(to), v.topic, v.name)
    }
  }
})

test('golden: acceptInbound coincide con global default-on y opt-out', () => {
  const { identity, legacyAddress } = golden
  for (const v of golden.routingVectors) {
    const message = parseCanonical(v.wire)
    assert.equal(
      acceptInbound(identity, message, { legacyAddress, global: false }),
      v.acceptPlain,
      `${v.name} (opt-out)`,
    )
    assert.equal(acceptInbound(identity, message, { legacyAddress }), v.acceptGlobal, `${v.name} (default)`)
  }
})

test('golden: makeOutbound determinista (mismo id/ts → mismo topic y wire)', () => {
  const self: Identity = golden.identity
  const a = makeOutbound(self, 'a4s/pi-1', { body: 'hola', id: 'fix', ts: 42, kind: 'task.request' })
  const b = makeOutbound(self, 'a4s/pi-1', { body: 'hola', id: 'fix', ts: 42, kind: 'task.request' })
  assert.equal(a.topic, 'synagent/v2/a4s/pi-1')
  assert.equal(serialize(a.message), serialize(b.message))
  assert.equal(a.message.from, 'a4s/sess-01')
})

test('golden: resultados de entrega completos y fallidos cumplen su esquema v2', () => {
  for (const status of ['complete', 'failed'] as const) {
    assert.ok(golden.deliveryResultVectors.some(vector => vector.status === status && vector.valid), `${status}: falta válido`)
    assert.ok(golden.deliveryResultVectors.some(vector => vector.status === status && !vector.valid), `${status}: falta inválido`)
  }
  for (const vector of golden.deliveryResultVectors) {
    try {
      const result = parseDeliveryResult(vector.wire)
      assert.equal(vector.valid, true, vector.name)
      assert.equal(result.status, vector.status, vector.name)
    } catch (error) {
      assert.equal(vector.valid, false, vector.name)
      assert.equal(
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
        vector.code,
        vector.name,
      )
    }
  }
})
