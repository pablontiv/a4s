'use strict'

const fs = require('node:fs')
const { createDiagnostics } = require('./diagnostics.cjs')

const TURN_REASONS = ['answer', 'aborted', 'refusal', 'error']
const DELIVERY_STATUSES = ['complete', 'failed']

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object')
  const sessionId = requireString(input.sessionId, 'sessionId')
  const messageId = requireString(input.messageId, 'messageId')
  const messageKind = requireString(input.messageKind, 'messageKind')
  const result = input.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('result must be an object')
  if (!TURN_REASONS.includes(result.reason)) throw new TypeError('result.reason is invalid')
  if (!DELIVERY_STATUSES.includes(result.status)) throw new TypeError('result.status is invalid')
  if (typeof result.text !== 'string') throw new TypeError('result.text must be a string')
  if (result.status === 'complete' && result.reason !== 'answer') throw new TypeError('complete result must have reason answer')
  if (result.status === 'failed' && (result.reason === 'answer' || result.cause !== result.reason)) {
    throw new TypeError('failed result must preserve its cause')
  }

  const logger = createDiagnostics({
    componentName: 'claude',
    harnessName: 'claude-code',
    instanceId: sessionId,
    scopeName: 'a4s.synagent.claude',
  })
  const recorded = logger.record(
    result.status === 'complete'
      ? 'synagent.claude.delivery.settled'
      : 'synagent.claude.delivery.failed',
    {
      operation: 'delivery.settle',
      messageId,
      messageKind,
      deliveryText: result.text,
      deliveryReason: result.reason,
      deliveryStatus: result.status,
      ...(result.status === 'failed' ? { deliveryCause: result.cause, severity: 'WARN' } : {}),
    },
  )
  logger.close()
  if (!recorded) process.exitCode = 1
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
