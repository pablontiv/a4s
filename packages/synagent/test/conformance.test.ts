// Suite de CONFORMIDAD compartida (ADR 0069): ejercita el core host-neutral con
// vectores dorados que todo adaptador —actual o futuro— debe reproducir. Fija el
// formato de wire, el mapa dirección→topic y el enrutado/aceptación. La copia
// generada del plugin Claude queda cubierta por su test de paridad (es idéntica
// a protocol.ts), y ambos adaptadores enrutan con estas mismas funciones.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  acceptInbound,
  isAddress,
  makeOutbound,
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
type Golden = { identity: Identity; legacyAddress: string; vectors: Vector[] }

const golden = JSON.parse(
  readFileSync(new URL('./golden-vectors.json', import.meta.url), 'utf8'),
) as Golden

test('golden: el wire re-serializa idéntico (estabilidad de formato cross-host)', () => {
  for (const v of golden.vectors) {
    assert.equal(serialize(parseCanonical(v.wire)), v.wire, v.name)
  }
})

test('golden: dirección→topic es la regla v1 (o null para legacy plano)', () => {
  for (const v of golden.vectors) {
    const { to } = parseCanonical(v.wire)
    if (v.topic === null) {
      assert.equal(isAddress(to), false, `${v.name}: legacy plano no es dirección v1`)
    } else {
      assert.equal(toTopic(to), v.topic, v.name)
    }
  }
})

test('golden: acceptInbound coincide sin y con global opt-in', () => {
  const { identity, legacyAddress } = golden
  for (const v of golden.vectors) {
    const message = parseCanonical(v.wire)
    assert.equal(acceptInbound(identity, message, { legacyAddress }), v.acceptPlain, `${v.name} (plain)`)
    assert.equal(
      acceptInbound(identity, message, { legacyAddress, global: true }),
      v.acceptGlobal,
      `${v.name} (global)`,
    )
  }
})

test('golden: makeOutbound determinista (mismo id/ts → mismo topic y wire)', () => {
  const self: Identity = golden.identity
  const a = makeOutbound(self, 'a4s/pi-1', { body: 'hola', id: 'fix', ts: 42, kind: 'prompt' })
  const b = makeOutbound(self, 'a4s/pi-1', { body: 'hola', id: 'fix', ts: 42, kind: 'prompt' })
  assert.equal(a.topic, 'synagent/v1/a4s/pi-1')
  assert.equal(serialize(a.message), serialize(b.message))
  assert.equal(a.message.from, 'a4s/sess-01')
})
