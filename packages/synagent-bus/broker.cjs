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
      if (!flagDb) throw new Error('--db requires a directory')
      index += 1
    } else if (argument.startsWith('--db=')) {
      flagDb = argument.slice('--db='.length)
      if (!flagDb) throw new Error('--db requires a directory')
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  if (positional.length > 2) throw new Error('usage: synagent-bus [port] [dbdir] [--db <dir>]')

  const rawPort = positional[0] ?? env.SYNAGENT_PORT ?? '1884'
  if (!/^\d+$/.test(rawPort)) throw new Error(`invalid port: ${rawPort}`)
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${rawPort}`)

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
    if (!server.listening) return resolve()
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
  const { port, dbdir } = parseArgs(argv, env)
  let broker
  let database
  let closing = false
  const server = net.createServer(socket => {
    if (!broker) return socket.destroy()
    broker.handle(socket)
  })

  try {
    await listen(server, port)
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.log(`BROKER ALREADY RUNNING :${port}`)
      return 0
    }
    throw error
  }

  const shutdown = async signal => {
    if (closing) return
    closing = true
    if (signal) console.log(`[broker] closing on ${signal}`)
    await Promise.all([closeServer(server), closeBroker(broker)])
    if (database && database.status === 'open') await database.close()
  }

  try {
    await prepareDbDir(dbdir)
    database = new ClassicLevel(dbdir)
    await database.open()
    const persistence = levelPersistence(database)
    broker = await Aedes.createBroker({ persistence })

    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TCP listener address is unavailable')
    console.log(`BROKER READY :${address.port} db=${dbdir}`)

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        shutdown(signal).then(() => process.exit(0), error => {
          console.error('[broker] shutdown error', error)
          process.exit(1)
        })
      })
    }
    return await new Promise(resolve => server.once('close', () => resolve(0)))
  } catch (error) {
    await shutdown()
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
