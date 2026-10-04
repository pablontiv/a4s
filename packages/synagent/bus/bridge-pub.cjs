// synagent BRIDGE de ENVIAR (publisher one-shot). El adaptador lo invoca con
// $.process.run. Publica un mensaje canónico (contrato §3 del boceto) al inbox
// del destinatario y termina.
//
//   node bridge-pub.cjs <to> <body> [from] [kind] [id] [replyTo] [brokerUrl]
const mqtt = require('mqtt')

const [, , to, body, from = 'claude', kind = 'prompt', id, replyTo, url] = process.argv
const URL = url || 'mqtt://127.0.0.1:1884'
if (!to || body === undefined) {
  console.error('uso: node bridge-pub.cjs <to> <body> [from] [kind] [id] [replyTo] [url]')
  process.exit(2)
}

const msg = {
  id: id || `${from}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  from, to, kind, body,
  ts: Date.now(),
}
if (replyTo) msg.reply_to = replyTo

const client = mqtt.connect(URL, { clientId: `a4s-pub-${msg.id}` })
client.on('connect', () => {
  client.publish(`a4s/inbox/${to}`, JSON.stringify(msg), { qos: 1 }, (err) => {
    if (err) { console.error(`[pub] error: ${err.message}`); process.exit(1) }
    console.log(JSON.stringify({ published: true, id: msg.id, to }))
    client.end(true, () => process.exit(0))
  })
})
client.on('error', (e) => { console.error(`[pub] error: ${e.message}`); process.exit(1) })
