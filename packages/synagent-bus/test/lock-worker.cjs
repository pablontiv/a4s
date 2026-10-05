'use strict'

const fs = require('node:fs/promises')
const { acquireEnsureLock } = require('../herdr/ensure.cjs')

const [target, staleText, updateText, retriesText, holdText, logFile = ''] = process.argv.slice(2)
const stale = Number(staleText)
const update = Number(updateText)
const retries = Number(retriesText)
const holdMs = Number(holdText)

async function report(message) {
  if (process.send) process.send(message)
}

async function main() {
  const release = await acquireEnsureLock(target, {
    stale,
    update,
    retries: { retries, factor: 1, minTimeout: 20, maxTimeout: 20, randomize: false },
  })
  if (logFile) await fs.appendFile(logFile, `ENTER ${process.pid} ${Date.now()}\n`)
  await report({ type: 'acquired', pid: process.pid })

  const finish = async () => {
    if (logFile) await fs.appendFile(logFile, `EXIT ${process.pid} ${Date.now()}\n`)
    await release()
    await report({ type: 'released', pid: process.pid })
  }

  if (holdMs >= 0) {
    await new Promise(resolve => setTimeout(resolve, holdMs))
    await finish()
    return
  }

  await new Promise((resolve, reject) => {
    process.once('message', message => {
      if (message?.type !== 'release') return reject(new Error('unexpected worker message'))
      finish().then(resolve, reject)
    })
  })
}

main().catch(async error => {
  await report({ type: 'failed', code: error.code, message: error.message })
  process.exitCode = 1
})
