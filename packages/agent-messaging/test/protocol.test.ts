// Pruebas del contrato compartido v2 + core host-neutral (ADR 0069).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  acceptInbound,
  assertSupportedTopicVersion,
  createCanonical,
  deadLetterTopic,
  directAddress,
  formatAddress,
  GLOBAL_ADDRESS,
  instanceFromHostSession,
  isAddress,
  isBroadcast,
  isBroadcastRedirect,
  isCommandKind,
  isEventKind,
  isFor,
  isForIdentity,
  isToken,
  MESSAGE_SCHEMAS,
  legacyTopic,
  makeOutbound,
  MESSAGE_KINDS,
  newId,
  parseAddress,
  parseDeadLetter,
  parseCanonical,
  parseCanonicalTopic,
  PROTOCOL_VERSION,
  projectAddress,
  renderForAgent,
  repoNameFromOrigin,
  resolveProject,
  resolveProjectWithSource,
  serializeDeadLetter,
  serialize,
  subscriptions,
  AGENT_MESSAGING_SEND_KINDS,
  topicMatchesAnyFilter,
  topicMatchesFilter,
  toTopic,
  type CanonicalMessage,
} from '../protocol.ts'

const identity = { project: 'a4s', instance: 'sess-01HXYZ' }

function msg(overrides: Partial<CanonicalMessage> & { to: string }): CanonicalMessage {
  return createCanonical(overrides.body ?? 'x', {
    id: overrides.id ?? 'm1',
    from: overrides.from ?? 'a4s/omp-1',
    to: overrides.to,
    ts: overrides.ts ?? 1,
    kind: overrides.kind ?? 'task.request',
    ...(overrides.reply_to ? { reply_to: overrides.reply_to } : {}),
    ...(overrides.correlation_id ? { correlation_id: overrides.correlation_id } : {}),
    ...(overrides.causation_id ? { causation_id: overrides.causation_id } : {}),
    ...(overrides.deadline === undefined ? {} : { deadline: overrides.deadline }),
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
  assert.equal(isAddress('a4s/omp-peer'), true)
  assert.equal(isAddress('legacy-sender'), false)
  assert.equal(isBroadcast('a4s/all'), true)
  assert.equal(isBroadcast('all'), true)
  assert.equal(isBroadcast('a4s/omp-peer'), false)
  for (const to of ['all', 'a4s/all', 'a4s/omp-peer']) assert.equal(formatAddress(parseAddress(to)!), to)
  assert.equal(directAddress(identity), 'a4s/sess-01HXYZ')
  assert.equal(projectAddress('a4s'), 'a4s/all')
})

test('toTopic/legacyTopic', () => {
  assert.equal(toTopic('a4s/omp-peer'), `synagent/${PROTOCOL_VERSION}/a4s/omp-peer`)
  assert.equal(toTopic('all'), 'synagent/v2/all')
  assert.throws(() => toTopic('no-es-direccion'), /dirección inválida/)
  assert.equal(legacyTopic('legacy-recipient'), 'a4s/inbox/legacy-recipient')
})

test('DLQ topic and records preserve the original payload and validate causes', () => {
  assert.equal(deadLetterTopic(identity), 'synagent/v2/dlq/a4s/sess-01HXYZ')
  const record = {
    id: 'dlq-1',
    payload: '  {"broken": ',
    cause: 'INVALID_JSON',
    time: '2026-10-15T12:00:00.000Z',
    harness: 'pion',
  } as const
  assert.deepEqual(parseDeadLetter(serializeDeadLetter(record)), record)
  assert.equal(parseDeadLetter(JSON.stringify({ ...record, payload: '' })).payload, '')
  assert.throws(
    () => parseDeadLetter(JSON.stringify({ ...record, cause: 'EXPIRED' })),
    /causa DLQ inválida/,
  )
  assert.throws(() => deadLetterTopic({ project: 'all', instance: 'x' }), /proyecto DLQ inválido/)
})

test('subscriptions wildcard the version level only; legacy stays exact', () => {
  const base = subscriptions({ identity })
  assert.deepEqual(base.durable, ['synagent/+/a4s/sess-01HXYZ'])
  assert.deepEqual(base.transient, ['synagent/+/a4s/all', 'synagent/+/all'])
  const compatible = subscriptions({ identity, global: false, legacyAddress: 'legacy-recipient' })
  assert.deepEqual(compatible.durable, ['synagent/+/a4s/sess-01HXYZ', 'a4s/inbox/legacy-recipient'])
  assert.deepEqual(compatible.transient, ['synagent/+/a4s/all'])
})

test('received topics match wildcard structurally and gate transport version before payload parsing', () => {
  assert.equal(topicMatchesFilter('synagent/+/a4s/sess-01HXYZ', 'synagent/v99/a4s/sess-01HXYZ'), true)
  assert.equal(topicMatchesFilter('synagent/+/a4s/sess-01HXYZ', 'synagent/v99/a4s/other'), false)
  assert.equal(topicMatchesAnyFilter(['synagent/+/all'], 'synagent/v99/all'), true)
  assert.deepEqual(parseCanonicalTopic('synagent/v2/a4s/all'), { version: 'v2', to: 'a4s/all' })
  assert.deepEqual(parseCanonicalTopic('synagent/v99/all'), { version: 'v99', to: 'all' })
  assert.equal(parseCanonicalTopic('synagent/v2/dlq/a4s/sess-01HXYZ'), null)
  assert.doesNotThrow(() => assertSupportedTopicVersion('synagent/v2/a4s/sess-01HXYZ'))
  assert.throws(
    () => assertSupportedTopicVersion('synagent/v99/a4s/sess-01HXYZ'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'VERSION_UNSUPPORTED',
  )
  assert.throws(
    () => assertSupportedTopicVersion('synagent/v1/a4s/sess-01HXYZ'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'VERSION_UNSUPPORTED',
  )
})

test('isForIdentity / isFor: directo, proyecto, legacy y global default-on con opt-out', () => {
  const opts = { identity, legacyAddress: 'legacy-recipient' }
  assert.equal(isForIdentity(msg({ to: 'a4s/sess-01HXYZ' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'a4s/all' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'legacy-recipient' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'a4s/otra' }), opts), false)
  assert.equal(isForIdentity(msg({ to: 'otro/all' }), opts), false)
  assert.equal(isForIdentity(msg({ to: 'all' }), opts), true)
  assert.equal(isForIdentity(msg({ to: 'all' }), { identity, global: false }), false)
  assert.equal(isFor(msg({ to: 'legacy-recipient' }), 'legacy-recipient'), true)
})

test('isBroadcastRedirect marca task.redirect a broadcast', () => {
  assert.equal(isBroadcastRedirect(msg({ to: 'a4s/all', kind: 'task.redirect' })), true)
  assert.equal(isBroadcastRedirect(msg({ to: 'all', kind: 'task.redirect' })), true)
  assert.equal(isBroadcastRedirect(msg({ to: 'a4s/x', kind: 'task.redirect' })), false)
  assert.equal(isBroadcastRedirect(msg({ to: 'a4s/all', kind: 'task.request' })), false)
})

test('repoNameFromOrigin: nombre canónico del repo, https y git@ (no basename de cwd)', () => {
  assert.equal(repoNameFromOrigin('https://github.com/pablontiv/a4s.git'), 'a4s')
  assert.equal(repoNameFromOrigin('git@github.com:pablontiv/a4s.git'), 'a4s')
  assert.equal(repoNameFromOrigin('https://github.com/pablontiv/a4s'), 'a4s')
  assert.equal(repoNameFromOrigin('https://github.com/acme/My.Repo.git'), 'My.Repo')
  assert.equal(repoNameFromOrigin('no-remoto'), null) // sin host/path no es un remoto
  assert.equal(repoNameFromOrigin('bad name/with space'), null)
})

test('resolveProject derives the origin identity and reports the source', () => {
  const origin = 'https://github.com/acme/Origin.Repo.git'
  assert.deepEqual(resolveProjectWithSource({ origin }), {
    project: 'Origin.Repo',
    source: 'origin',
  })
  assert.equal(resolveProject({ origin }), 'Origin.Repo')
})

test('resolveProject fails with remote.origin.url remediation without a valid origin', () => {
  assert.equal(resolveProject({ origin: 'https://github.com/pablontiv/a4s.git' }), 'a4s')
  assert.throws(() => resolveProject({}), /configura remote.origin.url/)
  assert.throws(() => resolveProject({ origin: '   ' }), /configura remote.origin.url/)
  assert.throws(() => resolveProject({ origin: 'https://h/x/bad name' }), /no se pudo derivar/)
})

test('instanceFromHostSession: id de sesión nativo tal cual; falla si no es token', () => {
  assert.equal(instanceFromHostSession('01HXYZ-abc'), '01HXYZ-abc')
  assert.equal(instanceFromHostSession('b0e0-0b0ae61c6f0c'), 'b0e0-0b0ae61c6f0c')
  assert.throws(() => instanceFromHostSession('tiene espacio'), /no es un token válido/)
  assert.throws(() => instanceFromHostSession('a/b'), /no es un token válido/)
})

test('makeOutbound correlates root commands and rejects broadcast task.redirect', () => {
  const { topic, message } = makeOutbound(identity, 'a4s/omp-1', { body: 'hola', id: 'm9', ts: 5 })
  assert.equal(topic, 'synagent/v2/a4s/omp-1')
  assert.equal(message.from, 'a4s/sess-01HXYZ')
  assert.equal(message.to, 'a4s/omp-1')
  assert.equal(message.kind, 'task.request')
  assert.equal(message.correlation_id, 'm9')
  assert.throws(() => makeOutbound(identity, 'no-dir', { body: 'x', id: 'm', ts: 1 }), /dirección inválida/)
  assert.throws(() => makeOutbound(identity, 'a4s/all', {
    body: 'x', kind: 'task.redirect', id: 'm', ts: 1,
  }), /task\.redirect solo/)
  const direct = makeOutbound(identity, 'a4s/omp-1', {
    body: 'x', kind: 'task.redirect', id: 'm', ts: 1, correlationId: 'root',
  })
  assert.equal(direct.message.kind, 'task.redirect')
  assert.equal(direct.message.correlation_id, 'root')
})

test('acceptInbound routes identity and rejects broadcast task.redirect', () => {
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/sess-01HXYZ' })), true)
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/all' })), true)
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/all', kind: 'task.redirect' })), false)
  assert.equal(acceptInbound(identity, msg({ to: 'otro/all' })), false)
  assert.equal(acceptInbound(identity, msg({ to: 'all' })), true)
  assert.equal(acceptInbound(identity, msg({ to: 'all' }), { global: false }), false)
  assert.equal(acceptInbound(identity, msg({ to: 'legacy-recipient' }), { legacyAddress: 'legacy-recipient' }), true)
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/all', from: directAddress(identity) })), false)
  assert.equal(acceptInbound(identity, msg({ to: 'a4s/sess-01HXYZ', from: directAddress(identity) })), false)
})

test('createCanonical/serialize/parseCanonical round-trips event correlation and renders it', () => {
  const m = makeOutbound(identity, 'a4s/omp-1', {
    body: 'hola',
    id: newId(directAddress(identity), 1000),
    ts: 1000,
    kind: 'task.completed',
    replyTo: 'a4s/omp-1-9-abc',
    correlationId: 'root-command',
    causationId: 'request-command',
    deadline: 6000,
  }).message
  assert.deepEqual(parseCanonical(serialize(m)), m)
  assert.match(renderForAgent(m), /\[bus:task\.completed\] de a4s\/sess-01HXYZ/)
  assert.match(renderForAgent(m), /correlación: root-command; causado por: request-command/)
})

test('parseCanonical accepts legacy addresses and validates optional causal and deadline fields', () => {
  assert.equal(parseCanonical(JSON.stringify({
    id: 'x', from: 'legacy-sender', to: 'legacy-recipient', kind: 'task.request', body: 'hi', deadline: 5001, ts: 1,
  })).deadline, 5001)
  assert.throws(() => parseCanonical(JSON.stringify({
    id: 'x', from: 'legacy-sender', kind: 'task.request', body: 'hi', ts: 1,
  })), /falta campo canónico: to/)
  assert.throws(() => parseCanonical(JSON.stringify({
    id: 'x', from: 'legacy-sender', to: 'legacy-recipient', kind: 'task.request', body: 'hi', correlation_id: '', ts: 1,
  })), /campo canónico inválido: correlation_id/)
  assert.throws(() => parseCanonical(JSON.stringify({
    id: 'x', from: 'legacy-sender', to: 'legacy-recipient', kind: 'task.request', body: 'hi', deadline: Number.NaN, ts: 1,
  })), /campo canónico inválido: deadline/)
  assert.equal(GLOBAL_ADDRESS, 'all')
})

test('parseCanonical uses per-kind schemas, reports stable codes, and ignores v2 extension fields', () => {
  assert.deepEqual(Object.keys(MESSAGE_SCHEMAS), MESSAGE_KINDS)
  for (const kind of MESSAGE_KINDS) assert.equal(MESSAGE_SCHEMAS[kind].kind, kind)
  const parsed = parseCanonical(JSON.stringify({
    id: 'ext-1',
    from: 'a4s/pi',
    to: 'a4s/omp',
    kind: 'note.published',
    body: 'compatible',
    ts: 1,
    version: 'v99',
    future_optional: { any: 'value' },
  }))
  assert.equal('version' in parsed, false)
  assert.equal('future_optional' in parsed, false)
  assert.throws(
    () => parseCanonical('not-json'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'MESSAGE_INVALID',
  )
})

test('message kinds distinguish v2 offer commands, adapter events, and LLM-sendable notes', () => {
  assert.deepEqual(MESSAGE_KINDS, [
    'task.request', 'task.redirect', 'task.offer', 'task.claim', 'task.cancel',
    'task.delivered', 'task.completed', 'task.expired', 'task.offer.closed', 'note.published',
  ])
  assert.deepEqual(AGENT_MESSAGING_SEND_KINDS, [
    'task.request', 'task.redirect', 'task.cancel', 'task.offer', 'note.published',
  ])
  for (const kind of ['task.offer', 'task.claim', 'task.offer.closed'] as const) {
    const parsed = parseCanonical(JSON.stringify({
      id: `id-${kind}`,
      from: 'a4s/omp-1',
      to: kind === 'task.offer' ? 'a4s/all' : 'a4s/offerer',
      kind,
      body: kind,
      ts: 1,
    }))
    assert.equal(parsed.kind, kind)
  }
  assert.equal(PROTOCOL_VERSION, 'v2')
  assert.equal(isCommandKind('task.offer'), true)
  assert.equal(isCommandKind('task.claim'), true)
  assert.equal(isEventKind('task.offer.closed'), true)
})
