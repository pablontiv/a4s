'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { defaultDbDir, parseArgs } = require('../broker.cjs')

test('database defaults and precedence are OS-aware', () => {
  assert.equal(
    defaultDbDir({ platform: 'darwin', env: {}, home: '/Users/tester' }),
    '/Users/tester/Library/Application Support/a4s/message-bus/mqtt-db',
  )
  assert.equal(
    defaultDbDir({ platform: 'linux', env: {}, home: '/home/tester' }),
    '/home/tester/.local/state/a4s/message-bus/mqtt-db',
  )
  assert.equal(
    defaultDbDir({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/tester' }),
    '/state/a4s/message-bus/mqtt-db',
  )

  const options = { platform: 'linux', home: '/home/tester' }
  assert.equal(parseArgs([], { A4S_MESSAGE_BUS_DB: '/env' }, options).dbdir, '/env')
  assert.equal(parseArgs(['1885', '/explicit'], { A4S_MESSAGE_BUS_DB: '/env' }, options).dbdir, '/explicit')
  assert.equal(parseArgs(['1885', '/explicit', '--db', '/flag'], { A4S_MESSAGE_BUS_DB: '/env' }, options).dbdir, '/flag')
  assert.equal(parseArgs([], { A4S_MESSAGE_BUS_PORT: '1885' }, options).port, 1885)
  assert.equal(parseArgs(['1886'], { A4S_MESSAGE_BUS_PORT: '1885' }, options).port, 1886)
  assert.equal(parseArgs(['0'], {}, options).port, 0)
})

test('invalid ports retain the structured non-retryable argument taxonomy in-process', () => {
  assert.throws(() => parseArgs(['not-a-port']), error => {
    assert.equal(error.message, 'invalid port: not-a-port')
    assert.equal(error.a4sCode, 'A4S_BROKER_PORT_INVALID')
    return true
  })
})
