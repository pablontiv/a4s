// Pruebas de la COPIA standalone de protocol.ts (adapters/claude/hooks/adapter.ts).
// Estas pruebas verifican que la copia funciona SOLA, sin importar protocol.ts original.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createCanonical,
  directAddress,
  formatAddress,
  isAddress,
  isBroadcast,
  isBroadcastSteer,
  isForIdentity,
  isToken,
  MESSAGE_KINDS,
  newId,
  parseAddress,
  parseCanonical,
  renderForAgent,
  serialize,
  subscriptions,
  toTopic,
} from '../adapters/claude/hooks/adapter.ts'

test('adapter: isToken valida tokens no-lossy en v1 (mayúsculas y punto)', () => {
  assert.equal(isToken('a4s'), true)
  assert.equal(isToken('claude-1'), true)
  assert.equal(isToken('x_y-z'), true)
  assert.equal(isToken('123'), true)
  assert.equal(isToken('A4S'), true) // mayúsculas válidas (no-lossy)
  assert.equal(isToken('My.Repo'), true) // punto válido
  assert.equal(isToken(''), false)
  assert.equal(isToken('-a'), false) // no empieza con -
  assert.equal(isToken(' a'), false) // no empieza con espacio
  assert.equal(isToken('a/b'), false) // separador de topic prohibido
})

test('adapter: parseAddress reconoce gramática v1', () => {
  assert.deepEqual(parseAddress('all'), { scope: 'global' })
  assert.deepEqual(parseAddress('a4s/claude-1'), { scope: 'direct', project: 'a4s', instance: 'claude-1' })
  assert.deepEqual(parseAddress('a4s/all'), { scope: 'project', project: 'a4s' })
  assert.equal(parseAddress('invalid'), null)
  assert.equal(parseAddress('a4s/all/extra'), null)
  assert.equal(parseAddress(''), null)
})

test('adapter: isAddress y isBroadcast', () => {
  assert.equal(isAddress('all'), true)
  assert.equal(isAddress('a4s/claude-1'), true)
  assert.equal(isAddress('a4s/all'), true)
  assert.equal(isAddress('invalid'), false)

  assert.equal(isBroadcast('all'), true)
  assert.equal(isBroadcast('a4s/all'), true)
  assert.equal(isBroadcast('a4s/claude-1'), false)
})

test('adapter: formatAddress invierte parseAddress', () => {
  assert.equal(formatAddress({ scope: 'global' }), 'all')
  assert.equal(formatAddress({ scope: 'project', project: 'a4s' }), 'a4s/all')
  assert.equal(formatAddress({ scope: 'direct', project: 'a4s', instance: 'claude-1' }), 'a4s/claude-1')
})

test('adapter: toTopic mapea dirección → topic v1', () => {
  assert.equal(toTopic('all'), 'synagent/v1/all')
  assert.equal(toTopic('a4s/all'), 'synagent/v1/a4s/all')
  assert.equal(toTopic('a4s/claude-1'), 'synagent/v1/a4s/claude-1')
  assert.throws(() => toTopic('invalid'), /dirección v1 inválida/)
})

test('adapter: directAddress y subscriptions', () => {
  const identity = { project: 'a4s', instance: 'claude-1' }
  assert.equal(directAddress(identity), 'a4s/claude-1')

  const plan = subscriptions({ identity })
  assert.deepEqual(plan.durable, ['synagent/v1/a4s/claude-1'])
  assert.deepEqual(plan.transient, ['synagent/v1/a4s/all', 'synagent/v1/all'])

  const optOutPlan = subscriptions({ identity, global: false, legacyAddress: 'claude' })
  assert.deepEqual(optOutPlan.durable, ['synagent/v1/a4s/claude-1', 'a4s/inbox/claude'])
  assert.deepEqual(optOutPlan.transient, ['synagent/v1/a4s/all'])
})

test('adapter: isForIdentity filtra por identidad', () => {
  const identity = { project: 'a4s', instance: 'claude-1' }
  const msg = (to: string) =>
    createCanonical('test', {
      id: 'test-1',
      from: 'pi/pi-1',
      to,
      ts: 1000,
    })

  // Directo a mí
  assert.equal(
    isForIdentity(msg('a4s/claude-1'), { identity, global: false, legacyAddress: 'claude' }),
    true,
  )

  // Directo a otro
  assert.equal(
    isForIdentity(msg('a4s/other'), { identity, global: false, legacyAddress: 'claude' }),
    false,
  )

  // Broadcast de mi proyecto
  assert.equal(
    isForIdentity(msg('a4s/all'), { identity, global: false, legacyAddress: 'claude' }),
    true,
  )

  // Broadcast de otro proyecto
  assert.equal(
    isForIdentity(msg('other/all'), { identity, global: false, legacyAddress: 'claude' }),
    false,
  )

  // Global (habilitado por defecto)
  assert.equal(isForIdentity(msg('all'), { identity, legacyAddress: 'claude' }), true)

  // Global (opt-out explícito)
  assert.equal(isForIdentity(msg('all'), { identity, global: false, legacyAddress: 'claude' }), false)

  // Legacy
  assert.equal(
    isForIdentity(msg('claude'), { identity, global: false, legacyAddress: 'claude' }),
    true,
  )
})

test('adapter: isBroadcastSteer rechaza steer broadcast', () => {
  const directMsg = createCanonical('test', {
    id: 'test-1',
    from: 'pi/pi-1',
    to: 'a4s/claude-1',
    ts: 1000,
    kind: 'steer',
  })
  assert.equal(isBroadcastSteer(directMsg), false)

  const projectMsg = createCanonical('test', {
    id: 'test-2',
    from: 'pi/pi-1',
    to: 'a4s/all',
    ts: 1000,
    kind: 'steer',
  })
  assert.equal(isBroadcastSteer(projectMsg), true)

  const globalMsg = createCanonical('test', {
    id: 'test-3',
    from: 'pi/pi-1',
    to: 'all',
    ts: 1000,
    kind: 'steer',
  })
  assert.equal(isBroadcastSteer(globalMsg), true)

  const promptMsg = createCanonical('test', {
    id: 'test-4',
    from: 'pi/pi-1',
    to: 'a4s/all',
    ts: 1000,
    kind: 'prompt',
  })
  assert.equal(isBroadcastSteer(promptMsg), false)
})

test('adapter: createCanonical + serialize + parseCanonical round-trip', () => {
  const msg = createCanonical('contenido', {
    id: 'test-1',
    from: 'a4s/claude-1',
    to: 'a4s/other',
    ts: 5000,
    kind: 'result',
    reply_to: 'test-0',
  })

  const serialized = serialize(msg)
  const parsed = parseCanonical(serialized)

  assert.deepEqual(parsed, msg)
})

test('adapter: parseCanonical rechaza mensajes malformados', () => {
  assert.throws(() => parseCanonical('not json'), /no es JSON válido/)
  assert.throws(() => parseCanonical('[]'), /debe ser un objeto/)
  assert.throws(
    () =>
      parseCanonical(
        JSON.stringify({
          id: 'test',
          from: 'a4s/claude-1',
          body: 'test',
          ts: 1000,
          // falta 'to' y 'kind'
        }),
      ),
    /falta campo canónico/,
  )
  assert.throws(
    () =>
      parseCanonical(
        JSON.stringify({
          id: 1, // debe ser string
          from: 'a4s/claude-1',
          to: 'a4s/other',
          kind: 'prompt',
          body: 'test',
          ts: 1000,
        }),
      ),
    /campo canónico inválido: id/,
  )
})

test('adapter: renderForAgent produce texto legible', () => {
  const msg = createCanonical('¿cómo estás?', {
    id: 'msg-1',
    from: 'a4s/pi-1',
    to: 'a4s/claude-1',
    ts: 1000,
    kind: 'steer',
    reply_to: 'msg-0',
  })

  const text = renderForAgent(msg)
  assert.match(text, /\[bus:steer\]/)
  assert.match(text, /de a4s\/pi-1/)
  assert.match(text, /id msg-1/)
  assert.match(text, /¿cómo estás\?/)
  assert.match(text, /responder a: msg-0/)
})

test('adapter: newId incluye dirección y ts', () => {
  const id = newId('a4s/claude-1', 5000)
  assert.match(id, /^a4s\/claude-1-5000-[a-z0-9]+$/)
})

test('adapter: MESSAGE_KINDS incluye todos los tipos', () => {
  assert.deepEqual(MESSAGE_KINDS, ['prompt', 'steer', 'result', 'notify', 'ack'])
})
