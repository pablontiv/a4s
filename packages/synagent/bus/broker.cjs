#!/usr/bin/env node
'use strict'

// Standalone loopback MQTT broker. The TCP port is reserved before LevelDB is
// opened so a second instance exits without touching persistent state.
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { Aedes } = require('aedes')
const { ClassicLevel } = require('classic-level')
const levelPersistence = require('aedes-persistence-level')
const { classifyError, createLogger, operationalError, tagOperationalError } = require('./logging.cjs')

function defaultDbDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'a4s', 'synagent', 'mqtt-db')
  }
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state')
  return path.join(stateHome, 'a4s', 'synagent', 'mqtt-db')
}

function parseArgs(argv = process.argv.slice(2), env = process.env, options = {}) {
  const positional = []
  let flagDb
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--db') {
      flagDb = argv[index + 1]
      if (!flagDb) {
        throw operationalError('A4S_BROKER_ARGUMENT_INVALID', '--db requires a directory', { phase: 'arguments' })
      }
      index += 1
    } else if (argument.startsWith('--db=')) {
      flagDb = argument.slice('--db='.length)
      if (!flagDb) {
        throw operationalError('A4S_BROKER_ARGUMENT_INVALID', '--db requires a directory', { phase: 'arguments' })
      }
    } else if (argument.startsWith('-')) {
      throw operationalError('A4S_BROKER_ARGUMENT_INVALID', `unknown option: ${argument}`, { phase: 'arguments' })
    } else {
      positional.push(argument)
    }
  }
  if (positional.length > 2) {
    throw operationalError(
      'A4S_BROKER_ARGUMENT_INVALID',
      'usage: synagent-bus [port] [dbdir] [--db <dir>]',
      { phase: 'arguments' },
    )
  }

  const rawPort = positional[0] ?? env.SYNAGENT_PORT ?? '1884'
  if (!/^\d+$/.test(rawPort)) {
    throw operationalError('A4S_BROKER_PORT_INVALID', `invalid port: ${rawPort}`, { phase: 'arguments' })
  }
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw operationalError('A4S_BROKER_PORT_INVALID', `invalid port: ${rawPort}`, { phase: 'arguments' })
  }

  const dbdir = path.resolve(flagDb || positional[1] || env.SYNAGENT_DB || defaultDbDir(options))
  return { port, dbdir }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

function closeBroker(broker) {
  return new Promise(resolve => {
    if (!broker) return resolve()
    broker.close(() => resolve())
  })
}

async function prepareDbDir(dbdir) {
  await fs.mkdir(dbdir, { recursive: true, mode: 0o700 })
  try {
    await fs.chmod(dbdir, 0o700)
  } catch (error) {
    console.error(`[broker] warning: could not restrict ${dbdir} to the current user: ${error.message}`)
  }
}

async function run(argv = process.argv.slice(2), env = process.env) {
  const logger = createLogger({
    env,
    scopeName: 'a4s.synagent-bus.broker',
    harnessKind: 'mqtt-broker',
    harnessRole: 'broker',
  })
  let broker
  let database
  let server
  let closing = false
  let port

  logger.info('broker.started', {
    body: 'Synagent broker startup began',
    protocol: { channel: 'jsonl_file', contaminated: false },
  })

  const shutdown = async signal => {
    if (closing) return
    closing = true
    if (signal) console.log(`[broker] closing on ${signal}`)
    logger.info('broker.shutdown', {
      body: 'Synagent broker shutdown began',
      attributes: { 'a4s.signal': signal || 'internal' },
      protocol: { channel: 'jsonl_file', contaminated: false },
      flushStatus: 'sync_requested',
    })
    await Promise.all([closeServer(server), closeBroker(broker)])
    if (database && database.status === 'open') await database.close()
    logger.close()
  }

  try {
    const parsed = parseArgs(argv, env)
    port = parsed.port
    const { dbdir } = parsed
    server = net.createServer(socket => {
      if (!broker) return socket.destroy()
      broker.handle(socket)
    })

    try {
      await listen(server, port)
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        logger.info('broker.already_running', {
          body: 'Synagent broker listener is already occupied',
          attributes: { 'server.port': port },
          protocol: { channel: 'stdout', contaminated: false },
          flushStatus: 'sync_requested',
        })
        logger.close()
        console.log(`BROKER ALREADY RUNNING :${port}`)
        return 0
      }
      throw tagOperationalError(error, 'A4S_BROKER_PORT_FAILED', {
        phase: 'port.listen',
        retryable: true,
      })
    }

    try {
      await prepareDbDir(dbdir)
      database = new ClassicLevel(dbdir)
      await database.open()
      const persistence = levelPersistence(database)
      broker = await Aedes.createBroker({ persistence })
    } catch (error) {
      throw tagOperationalError(error, 'A4S_BROKER_DB_FAILED', {
        phase: 'db.open',
        retryable: false,
      })
    }

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw operationalError(
        'A4S_BROKER_READINESS_FAILED',
        'TCP listener address is unavailable',
        { phase: 'readiness.tcp' },
      )
    }
    logger.info('broker.ready', {
      body: 'Synagent broker is ready',
      attributes: { 'server.port': address.port },
      protocol: { channel: 'stdout', contaminated: false },
      flushStatus: 'pending',
    })
    console.log(`BROKER READY :${address.port} db=${dbdir}`)

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        shutdown(signal).then(() => process.exit(0), error => {
          logger.error('broker.error', {
            body: 'Synagent broker shutdown failed',
            error: classifyError(error, 'broker.shutdown', {
              code: 'A4S_BROKER_SHUTDOWN_FAILED',
              phase: 'shutdown',
            }),
            protocol: { channel: 'stderr', contaminated: false },
            flushStatus: 'failed',
          })
          logger.close({ flushStatus: 'failed' })
          console.error('[broker] shutdown error', error)
          process.exit(1)
        })
      })
    }
    return await new Promise(resolve => server.once('close', () => resolve(0)))
  } catch (error) {
    logger.error('broker.error', {
      body: 'Synagent broker operation failed',
      error: classifyError(error, 'broker.runtime', {
        code: error?.a4sCode || 'A4S_BROKER_OPERATION_FAILED',
      }),
      protocol: { channel: 'stderr', contaminated: false },
      flushStatus: 'pending',
    })
    try {
      await shutdown()
    } catch (shutdownError) {
      logger.error('broker.error', {
        body: 'Synagent broker cleanup failed',
        error: classifyError(shutdownError, 'broker.shutdown', {
          code: 'A4S_BROKER_SHUTDOWN_FAILED',
          phase: 'shutdown',
        }),
        protocol: { channel: 'stderr', contaminated: false },
        flushStatus: 'failed',
      })
      logger.close({ flushStatus: 'failed' })
    }
    throw error
  }
}

if (require.main === module) {
  run().then(code => {
    if (code !== undefined) process.exitCode = code
  }).catch(error => {
    console.error('[broker] ERROR', error)
    process.exitCode = 1
  })
}

module.exports = { defaultDbDir, parseArgs, prepareDbDir, run }
