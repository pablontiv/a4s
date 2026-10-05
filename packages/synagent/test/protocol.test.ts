// Pruebas del contrato compartido v1 + core host-neutral (ADR 0069).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  acceptInbound,
  createCanonical,
  directAddress,
  formatAddress,
  GLOBAL_ADDRESS,
  instanceFromHostSession,
  isAddress,
  isBroadcast,
  isBroadcastSteer,
  isFor,
  isForIdentity,
  isToken,
  legacyTopic,
  makeOutbound,
  newId,
  parseAddress,
  parseCanonical,
  PROTOCOL_VERSION,
  projectAddress,
  renderForAgent,
  repoNameFromOrigin,
  resolveProject,
  serialize,
  subscriptions,
  toTopic,
  type CanonicalMessage,
} from '../protocol.ts'

const identity = { project: 'a4s', instance: 'sess-01HXYZ' }

function msg(overrides: Partial<CanonicalMessage> & { to: string }): CanonicalMessage {
  return createCanonical(overrides.body ?? 'x', {
    id: overrides.id ?? 'm1',
    from: overrides.from ?? 'a4s/pi-1',
    to: overrides.to,
    ts: overrides.ts ?? 1,
    kind: overrides.kind ?? 'prompt',
    ...(overrides.reply_to ? { reply_to: overrides.reply_to } : {}),
  })
}

test('isToken es no-lossy: admite mayúsculas y punto, rechaza vacíos/largos/separadores', () => {
  assert.equal(isToken('a4s'), true)
  assert.equal(isToken('Claude-Sess.01'), true) // mayúsculas + punto (no-lossy)
  assert.equal(isToken('01HXYZ-abc_DEF'), true)
  assert.equal(isToken(''), false)
  assert.equal(isToken('-leading'), false)
  assert.equal(isToken('a/b'), false) // separador de topic prohibido
  assert.equal(isToken('a+b'), false)
  assert.equal(isToken('a#b'), false)
  assert.equal(isToken('a'.repeat(65)), true)
  assert.equal(isToken('a'.repeat(256)), true)
  assert.equal(isToken('a'.repeat(257)), false)
})

test('parseAddress distingue global, proyecto y directo; reserva "all"', () => {
  assert.deepEqual(parseAddress('all'), { scope: 'global' })
  assert.deepEqual(parseAddress('a4s/all'), { scope: 'project', project: 'a4s' })
  assert.deepEqual(parseAddress('a4s/Sess.01'), { scope: 'direct', project: 'a4s', instance: 'Sess.01' })
  assert.equal(parseAddress('a4s'), null)
  assert.equal(parseAddress('a/b/c'), null)
  assert.equal(parseAddress('a4s/'), null)
  assert.equal(parseAddress('all/x'), null) // 'all' no puede ser proyecto
  assert.equal(parseAddress('all/all'), null)
})

test('isAddress/isBroadcast/formatAddress', () => {
  assert.equal(isAddress('a4s/claude-1'), true)
  assert.equal(isAddress('pi'), false)
  assert.equal(isBroadcast('a4s/all'), true)
  assert.equal(isBroadcast('all'), true)
  assert.equal(isBroadcast('a4s/claude-1'), false)
  for (const to of ['all', 'a4s/all', 'a4s/claude-1']) assert.equal(formatAddress(parseAddress(to)!), to)
  assert.equal(directAddress(identity), 'a4s/sess-01HXYZ')
  assert.equal(projectAddress('a4s'), 'a4s/all')
})

test('toTopic/legacyTopic', () => {
  assert.equal(toTopic('a4s/claude-1'), `synagent/${PROTOCOL_VERSION}/a4s/claude-1`)
  assert.equal(toTopic('all'), 'synagent/v1/all')
  assert.throws(() => toTopic('no-es-direccion'), /dirección v1 inválida/)
  assert.equal(legacyTopic('claude'), 'a4s/inbox/claude')
})

test('subscriptions: directo + broadcasts de proyecto/global por defecto; legacy solo explícito', () => {
  const base = subscriptions({ identity })
  assert.deepEqual(base.durable, ['synagent/v1/a4s/sess-01HXYZ'])
  assert.deepEqual(base.transient, ['synagent/v1/a4s/all', 'synagent/v1/all'])
  const compatible = subscriptions({ identity, global: false, legacyAddress: 'claude' })
  assert.deepEqual(compatible.durable, ['synagent/v1/a4s/sess-01HXYZ', 'a4s/inbox/claude'])
  assert.deepEqual(compatible.transient, ['synagent/v1/a4s/all'])
})

test('isForIdentity / isFor: directo, proyecto, legacy y global default-on con opt-out', () => {
  const opts = { identity, legacyAddress: 'claude' }
  assert.equal(isForIdentity(msg({ to: 'a4s/sess-01HXYZ' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'a4s/all' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'claude' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'a4s/otra' }), opts), false)
  assert.equal(isForIdentity(msg({ to: 'otro/all' }), opts), false)
  assert.equal(isForIdentity(msg({ to: 'all' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'all' }), { identity, global: false }), false)
  assert.equal(isFor(msg({ to: 'claude' }), 'claude'), true)
})

test('isBroadcastSteer marca steer a broadcast', () => {
  assert.equal(isBroadcastSteer(msg({ to: 'a4s/all', kind: 'steer' })), true)
  assert.equal(isBroadcastSteer(msg({ to: 'all', kind: 'steer' })), true)
  assert.equal(isBroadcastSteer(msg({ to: 'a4s/x', kind: 'steer' })), false)
  assert.equal(isBroadcastSteer(msg({ to: 'a4s/all', kind: 'prompt' })), false)
})

test('repoNameFromOrigin: nombre canónico del repo, https y git@ (no basename de cwd)', () => {
  assert.equal(repoNameFromOrigin('https://github.com/pablontiv/a4s.git'), 'a4s')
  assert.equal(repoNameFromOrigin('git@github.com:pablontiv/a4s.git'), 'a4s')
  assert.equal(repoNameFromOrigin('https://github.com/pablontiv/a4s'), 'a4s')
  assert.equal(repoNameFromOrigin('https://github.com/acme/My.Repo.git'), 'My.Repo')
  assert.equal(repoNameFromOrigin('no-remoto'), null) // sin host/path no es un remoto
  assert.equal(repoNameFromOrigin('bad name/with space'), null)
})

test('resolveProject: setting > origin; FALLA explícito sin fuente ni token válido', () => {
  assert.equal(resolveProject({ setting: 'a4s', origin: 'git@github.com:x/y.git' }), 'a4s')
  assert.equal(resolveProject({ origin: 'https://github.com/pablontiv/a4s.git' }), 'a4s')
  assert.throws(() => resolveProject({}), /no se pudo resolver/)
  assert.throws(() => resolveProject({ setting: 'no válido' }), /no es un token válido/)
  assert.throws(() => resolveProject({ origin: 'https://h/x/bad name' }), /no se pudo derivar/)
})

test('instanceFromHostSession: id de sesión nativo tal cual; falla si no es token', () => {
  assert.equal(instanceFromHostSession('01HXYZ-abc'), '01HXYZ-abc')
  assert.equal(instanceFromHostSession('b0e0-0b0ae61c6f0c'), 'b0e0-0b0ae61c6f0c')
  assert.throws(() => instanceFromHostSession('tiene espacio'), /no es un token válido/)
  assert.throws(() => instanceFromHostSession('a/b'), /no es un token válido/)
})

test('makeOutbound: arma {topic,message} v1, from=identidad; rechaza inválido y steer-broadcast', () => {
  const { topic, message } = makeOutbound(identity, 'a4s/pi-1', { body: 'hola', id: 'm9', ts: 5 })
  assert.equal(topic, 'synagent/v1/a4s/pi-1')
  assert.equal(message.from, 'a4s/sess-01HXYZ')
  assert.equal(message.to, 'a4s/pi-1')
  assert.equal(message.kind, 'prompt')
  assert.throws(() => makeOutbound(identity, 'no-dir', { body: 'x', id: 'm', ts: 1 }), /dirección v1 inválida/)
  assert.throws(() => makeOutbound(identity, 'a4s/all', { body: 'x', kind: 'steer', id: 'm', ts: 1 }), /steer solo/)
  const direct = makeOutbound(identity, 'a4s/pi-1', { body: 'x', kind: 'steer', id: 'm', ts: 1 })
  assert.equal(direct.message.kind, 'steer') // steer directo OK
})

test('acceptInbound = enrutado para mí Y no steer-broadcast', () => {
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/sess-01HXYZ' })), true)
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/all' })), true)
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/all', kind: 'steer' })), false) // steer broadcast
  assert.equal(acceptInbound(identity, msg({ to: 'otro/all' })), false)
  assert.equal(acceptInbound(identity, msg({ to: 'all' })), true)
  assert.equal(acceptInbound(identity, msg({ to: 'all' }), { global: false }), false)
  assert.equal(acceptInbound(identity, msg({ to: 'claude' }), { legacyAddress: 'claude' }), true)
  // self-echo: un broadcast propio (from = mi dirección) no se entrega
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/all', from: directAddress(identity) })), false)
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/sess-01HXYZ', from: directAddress(identity) })), false)
})

test('createCanonical/serialize/parseCanonical round-trip y render', () => {
  const m = makeOutbound(identity, 'a4s/pi-1', {
    body: 'hola', id: newId(directAddress(identity), 1000), ts: 1000, kind: 'result', replyTo: 'a4s/pi-1-9-abc',
  }).message
  assert.deepEqual(parseCanonical(serialize(m)), m)
  assert.match(renderForAgent(m), /\[bus:result\] de a4s\/sess-01HXYZ/)
})

test('parseCanonical acepta to legacy plano (dual-read) y valida campos', () => {
  assert.equal(parseCanonical(JSON.stringify({ id: 'x', from: 'pi', to: 'claude', kind: 'prompt', body: 'hi', ts: 1 })).to, 'claude')
  assert.throws(() => parseCanonical(JSON.stringify({ id: 'x', from: 'pi', kind: 'prompt', body: 'hi', ts: 1 })), /falta campo canónico: to/)
  assert.equal(GLOBAL_ADDRESS, 'all')
})
