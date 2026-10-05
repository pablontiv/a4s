// Pruebas del contrato compartido v1 (ADR 0068): gramática de direcciones,
// topics, plan de suscripción, enrutado, steer-broadcast y resolución.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createCanonical,
  deriveProjectFromRemote,
  directAddress,
  formatAddress,
  GLOBAL_ADDRESS,
  isAddress,
  isBroadcast,
  isBroadcastSteer,
  isFor,
  isForIdentity,
  isToken,
  legacyTopic,
  newId,
  normalizeProject,
  parseAddress,
  parseCanonical,
  PROTOCOL_VERSION,
  projectAddress,
  renderForAgent,
  resolveInstance,
  resolveProject,
  serialize,
  subscriptions,
  toTopic,
  type CanonicalMessage,
} from '../protocol.ts'

const identity = { project: 'a4s', instance: 'claude-1' }

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

test('isToken acepta tokens legibles y rechaza mayúsculas, vacíos y largos', () => {
  assert.equal(isToken('a4s'), true)
  assert.equal(isToken('claude-1_x'), true)
  assert.equal(isToken('A4S'), false)
  assert.equal(isToken(''), false)
  assert.equal(isToken('-leading'), false)
  assert.equal(isToken('a'.repeat(65)), false)
})

test('parseAddress distingue global, proyecto y directo; rechaza lo inválido', () => {
  assert.deepEqual(parseAddress('all'), { scope: 'global' })
  assert.deepEqual(parseAddress('a4s/all'), { scope: 'project', project: 'a4s' })
  assert.deepEqual(parseAddress('a4s/claude-1'), { scope: 'direct', project: 'a4s', instance: 'claude-1' })
  assert.equal(parseAddress('a4s'), null) // plano legacy no es dirección v1
  assert.equal(parseAddress('a/b/c'), null)
  assert.equal(parseAddress('A4S/x'), null)
  assert.equal(parseAddress('a4s/'), null)
})

test('isAddress/isBroadcast coinciden con el scope', () => {
  assert.equal(isAddress('a4s/claude-1'), true)
  assert.equal(isAddress('pi'), false)
  assert.equal(isBroadcast('a4s/all'), true)
  assert.equal(isBroadcast('all'), true)
  assert.equal(isBroadcast('a4s/claude-1'), false)
  assert.equal(isBroadcast('pi'), false)
})

test('formatAddress es inverso de parseAddress', () => {
  for (const to of ['all', 'a4s/all', 'a4s/claude-1']) {
    assert.equal(formatAddress(parseAddress(to)!), to)
  }
  assert.equal(directAddress(identity), 'a4s/claude-1')
  assert.equal(projectAddress('a4s'), 'a4s/all')
})

test('toTopic aplica la regla synagent/<version>/<to> y valida', () => {
  assert.equal(toTopic('a4s/claude-1'), `synagent/${PROTOCOL_VERSION}/a4s/claude-1`)
  assert.equal(toTopic('a4s/all'), 'synagent/v1/a4s/all')
  assert.equal(toTopic('all'), 'synagent/v1/all')
  assert.throws(() => toTopic('no-es-direccion'), /dirección v1 inválida/)
  assert.equal(legacyTopic('claude'), 'a4s/inbox/claude')
})

test('subscriptions: durable=directo(+legacy), transient=proyecto(+global opt-in)', () => {
  const base = subscriptions({ identity })
  assert.deepEqual(base.durable, ['synagent/v1/a4s/claude-1'])
  assert.deepEqual(base.transient, ['synagent/v1/a4s/all'])

  const full = subscriptions({ identity, global: true, legacyAddress: 'claude' })
  assert.deepEqual(full.durable, ['synagent/v1/a4s/claude-1', 'a4s/inbox/claude'])
  assert.deepEqual(full.transient, ['synagent/v1/a4s/all', 'synagent/v1/all'])
})

test('isForIdentity acepta directo, proyecto, legacy y global solo si opt-in', () => {
  const opts = { identity, legacyAddress: 'claude' }
  assert.equal(isForIdentity(msg({ to: 'a4s/claude-1' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'a4s/all' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'claude' }), opts), true) // legacy plano
  assert.equal(isForIdentity(msg({ to: 'a4s/pi-1' }), opts), false) // otra instancia
  assert.equal(isForIdentity(msg({ to: 'otro/all' }), opts), false) // otro proyecto
  assert.equal(isForIdentity(msg({ to: 'all' }), opts), false) // global sin opt-in
  assert.equal(isForIdentity(msg({ to: 'all' }), { identity, global: true }), true)
  assert.equal(isForIdentity(msg({ to: 'claude' }), { identity }), false) // sin legacy configurado
})

test('isFor conserva igualdad exacta (buzón directo/legacy)', () => {
  assert.equal(isFor(msg({ to: 'a4s/claude-1' }), 'a4s/claude-1'), true)
  assert.equal(isFor(msg({ to: 'claude' }), 'claude'), true)
  assert.equal(isFor(msg({ to: 'a4s/all' }), 'a4s/claude-1'), false)
})

test('isBroadcastSteer marca steer a broadcast (rechazo en ambos extremos)', () => {
  assert.equal(isBroadcastSteer(msg({ to: 'a4s/all', kind: 'steer' })), true)
  assert.equal(isBroadcastSteer(msg({ to: 'all', kind: 'steer' })), true)
  assert.equal(isBroadcastSteer(msg({ to: 'a4s/claude-1', kind: 'steer' })), false) // directo OK
  assert.equal(isBroadcastSteer(msg({ to: 'a4s/all', kind: 'prompt' })), false) // no-steer OK
})

test('normalizeProject: token passthrough, mapeo determinista o fallo', () => {
  assert.equal(normalizeProject('a4s'), 'a4s')
  assert.equal(normalizeProject('A4S'), 'a4s')
  assert.equal(normalizeProject('pablontiv/a4s'), 'pablontiv-a4s')
  assert.equal(normalizeProject('my.project'), 'my-project')
  assert.throws(() => normalizeProject('  '), /no normalizable/)
  assert.throws(() => normalizeProject('a'.repeat(65)), /no normalizable/)
})

test('deriveProjectFromRemote soporta https y git@ como owner-repo', () => {
  assert.equal(deriveProjectFromRemote('https://github.com/pablontiv/a4s.git'), 'pablontiv-a4s')
  assert.equal(deriveProjectFromRemote('git@github.com:pablontiv/a4s.git'), 'pablontiv-a4s')
  assert.equal(deriveProjectFromRemote('https://github.com/pablontiv/a4s'), 'pablontiv-a4s')
  assert.throws(() => deriveProjectFromRemote('no-remoto'), /no se pudo derivar/)
})

test('resolveProject sigue env > config > remoto; falla sin fuente', () => {
  assert.equal(resolveProject({ env: 'a4s', config: 'otro' }), 'a4s')
  assert.equal(resolveProject({ config: 'otro' }), 'otro')
  assert.equal(resolveProject({ remoteUrl: 'git@github.com:pablontiv/a4s.git' }), 'pablontiv-a4s')
  assert.throws(() => resolveProject({}), /no se pudo resolver/)
})

test('resolveInstance sigue env > config > generado; explícito inválido falla', () => {
  assert.equal(resolveInstance({ env: 'claude-1', generated: 'gen' }), 'claude-1')
  assert.equal(resolveInstance({ config: 'cfg-1', generated: 'gen' }), 'cfg-1')
  assert.equal(resolveInstance({ generated: 'GEN-X' }), 'gen-x')
  assert.throws(() => resolveInstance({ env: 'in valido', generated: 'gen' }), /instancia inválida/)
})

test('createCanonical/serialize/parseCanonical hace round-trip con to jerárquico', () => {
  const m = createCanonical('hola', {
    id: newId('a4s/claude-1', 1000),
    from: 'a4s/claude-1',
    to: 'a4s/pi-1',
    ts: 1000,
    kind: 'result',
    reply_to: 'a4s/pi-1-999-abc',
  })
  assert.deepEqual(parseCanonical(serialize(m)), m)
  assert.match(renderForAgent(m), /\[bus:result\] de a4s\/claude-1/)
})

test('parseCanonical acepta to plano legacy (dual-read) y valida campos', () => {
  const legacy = JSON.stringify({ id: 'x', from: 'pi', to: 'claude', kind: 'prompt', body: 'hi', ts: 1 })
  assert.equal(parseCanonical(legacy).to, 'claude')
  assert.throws(() => parseCanonical(JSON.stringify({ id: 'x', from: 'pi', kind: 'prompt', body: 'hi', ts: 1 })), /falta campo canónico: to/)
})

test('newId incluye la dirección de origen', () => {
  assert.match(newId('a4s/claude-1', 1234), /^a4s\/claude-1-1234-[a-z0-9]{1,6}$/)
  assert.equal(GLOBAL_ADDRESS, 'all')
})
