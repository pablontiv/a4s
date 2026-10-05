// synagent BRIDGE v1 de ENVIAR (publisher one-shot). Publica un payload JSON
// canónico al topic especificado con QoS 1 y termina.
//
//   node bridge-pub.cjs <topic> <payloadJson> [url]

const mqtt = require('mqtt')

const [, , topic, payloadJson, url] = process.argv
const URL = url || 'mqtt://127.0.0.1:1884'

if (!topic || !payloadJson) {
  console.error('uso: node bridge-pub.cjs <topic> <payloadJson> [url]')
  process.exit(2)
}

// Generar clientId único
const clientId = `synagent-pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const client = mqtt.connect(URL, { clientId })

client.on('connect', () => {
  client.publish(topic, payloadJson, { qos: 1 }, (err) => {
    if (err) {
      console.error(`[pub] error: ${err.message}`)
      process.exit(1)
    }
    console.log(JSON.stringify({ published: true, topic }))
    client.end(true, () => process.exit(0))
  })
})

client.on('error', (e) => {
  console.error(`[pub] error: ${e.message}`)
  process.exit(1)
})
