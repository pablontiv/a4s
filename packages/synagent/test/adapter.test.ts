// Pruebas del núcleo traducible del adaptador (boceto §3/§4), sin bus ni `$`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_PEER,
  isForSelf,
  newId,
  parseCanonical,
  renderForAgent,
  SELF_ADDRESS,
  serialize,
  toCanonical,
} from '../adapters/claude/hooks/adapter.ts'

test('ENVIAR: toCanonical arma el contrato mínimo con defaults', () => {
  const msg = toCanonical('hola pi', { id: 'm1', ts: 1000 })
  assert.equal(msg.id, 'm1')
  assert.equal(msg.from, SELF_ADDRESS)
  assert.equal(msg.to, DEFAULT_PEER)
  assert.equal(msg.kind, 'prompt')
  assert.equal(msg.body, 'hola pi')
  assert.equal(msg.ts, 1000)
  assert.ok(!('reply_to' in msg))
})

test('ENVIAR: serialize/parse hace round-trip del contrato', () => {
  const msg = toCanonical('resultado listo', {
    id: 'm2',
    ts: 2000,
    to: 'pi',
    kind: 'result',
    reply_to: 'claude',
  })
  assert.deepEqual(parseCanonical(serialize(msg)), msg)
})

test('JALAR: parseCanonical rechaza un mensaje sin campos obligatorios', () => {
  const incompleto = JSON.stringify({ id: 'x', from: 'pi', body: 'hi' })
  assert.throws(() => parseCanonical(incompleto), /falta campo canónico: to/)
})

test('JALAR: parseCanonical rechaza un kind inválido', () => {
  const malKind = JSON.stringify({
    id: 'x', from: 'pi', to: 'claude', kind: 'grito', body: 'hi', ts: 1,
  })
  assert.throws(() => parseCanonical(malKind), /kind inválido/)
})

test('JALAR: el protocolo compartido rechaza coerciones de tipos', () => {
  assert.throws(
    () => parseCanonical(JSON.stringify({ id: 1, from: 'pi', to: 'claude', kind: 'prompt', body: 'hi', ts: 1 })),
    /campo canónico inválido: id/,
  )
  assert.throws(
    () => parseCanonical(JSON.stringify({ id: 'x', from: 'pi', to: 'claude', kind: 'prompt', body: 'hi', ts: '1' })),
    /campo canónico inválido: ts/,
  )
})

test('JALAR: isForSelf solo acepta mensajes dirigidos a este adaptador', () => {
  assert.equal(isForSelf(toCanonical('oye claude', { id: 'm3', ts: 3000, to: SELF_ADDRESS })), true)
  assert.equal(isForSelf(toCanonical('oye pi', { id: 'm4', ts: 3000, to: 'pi' })), false)
})

test('ENTREGAR: renderForAgent produce texto legible con metadatos', () => {
  const text = renderForAgent(
    toCanonical('¿avanzamos?', { id: 'm5', ts: 5000, to: SELF_ADDRESS, kind: 'steer', reply_to: 'pi' }),
  )
  assert.match(text, /\[bus:steer\]/)
  assert.match(text, /de claude/)
  assert.match(text, /id m5/)
  assert.match(text, /¿avanzamos\?/)
  assert.match(text, /responder a: pi/)
})

test('IDEMPOTENCIA: el id permite deduplicar re-entregas del bus', () => {
  const entregados = new Set<string>()
  const incoming = [
    toCanonical('a', { id: 'dup', ts: 1, to: SELF_ADDRESS }),
    toCanonical('a (re-entregado)', { id: 'dup', ts: 2, to: SELF_ADDRESS }),
    toCanonical('b', { id: 'otro', ts: 3, to: SELF_ADDRESS }),
  ]
  const entregas: string[] = []
  for (const msg of incoming) {
    if (!isForSelf(msg) || entregados.has(msg.id)) continue
    entregas.push(msg.id)
    entregados.add(msg.id)
  }
  assert.deepEqual(entregas, ['dup', 'otro'])
})

test('newId incluye la dirección propia y el ts', () => {
  assert.match(newId(1234), /^claude-1234-[a-z0-9]{1,6}$/)
})
