import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

import { assertLoopbackBrokerUrl, loadAgentMessagingSettings, settingsPaths } from './adapters/session/settings.ts'
import { observeBus, renderObservations, replayObservations } from './observer.ts'

const usage = `Usage:
  npm run observer --workspace @a4s/agent-messaging -- --output capture.jsonl [--broker-url mqtt://127.0.0.1:1884]
  npm run observer --workspace @a4s/agent-messaging -- --replay capture.jsonl

Live mode subscribes to synagent/# and appends UTF-8 payloads to JSONL.
Each receipt redraws the grouped snapshot (successive snapshots when piped).
Ctrl-C stops capture. Replay prints one snapshot without connecting to MQTT.
Capture and replay paths are relative to the invoking directory; settings are user-scoped.
`

try {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      replay: { type: 'string' },
      'broker-url': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) {
    process.stdout.write(usage)
  } else {
    const cwd = process.env.INIT_CWD || process.cwd()
    if (values.replay !== undefined) {
      if (!values.replay || values.output !== undefined || values['broker-url'] !== undefined) {
        throw new Error('Use --replay FILE by itself')
      }
      process.stdout.write(renderObservations(await replayObservations(resolve(cwd, values.replay))))
    } else {
      if (!values.output) throw new Error('Live mode requires --output FILE')
      const settings = loadAgentMessagingSettings(settingsPaths())
      const brokerUrl = values['broker-url'] ?? settings['broker-url']
      assertLoopbackBrokerUrl(brokerUrl)
      const controller = new AbortController()
      const stop = () => controller.abort()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      try {
        await observeBus({
          brokerUrl,
          output: resolve(cwd, values.output),
          signal: controller.signal,
          onReady() {
            process.stderr.write(`Subscribed to synagent/# on ${brokerUrl}; appending to ${resolve(cwd, values.output!)}\n`)
          },
          onSnapshot(snapshot) {
            process.stdout.write(`${process.stdout.isTTY ? '\u001b[2J\u001b[H' : ''}${snapshot}`)
          },
        })
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    }
  }
} catch (error) {
  process.stderr.write(`agent-messaging observer: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
