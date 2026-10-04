// synagent BRIDGE de JALAR (suscriptor). Es lo que el adaptador lanza con
// $.process.spawn. Se suscribe al inbox de la dirección y ESCUPE cada mensaje
// canónico como UNA línea JSON en stdout. El adaptador lee esas líneas
// (for await) y hace $.prompt.submit.
//
//   node bridge-sub.js <address> [brokerUrl]
//
// clean:false + clientId estable => sesión persistente: si el adaptador se cae
// y el bridge se relanza, el broker le re-entrega lo encolado (QoS1).
const mqtt = require('mqtt')

const ADDRESS = process.argv[2] || 'claude'
const URL = process.argv[3] || 'mqtt://127.0.0.1:1884'
const TOPIC = `a4s/inbox/${ADDRESS}`

const client = mqtt.connect(URL, { clientId: `a4s-bridge-${ADDRESS}`, clean: false })

client.on('connect', () => {
  client.subscribe(TOPIC, { qos: 1 }, (err) => {
    if (err) { console.error(`[bridge] subscribe error: ${err.message}`); process.exit(1) }
    console.error(`[bridge] suscrito a ${TOPIC} via ${URL}`) // log a stderr, no stdout
  })
})

client.on('message', (_topic, payload) => {
  // stdout = canal de datos hacia el adaptador: una línea = un mensaje canónico.
  process.stdout.write(payload.toString().replace(/\n/g, ' ') + '\n')
})

client.on('error', (e) => console.error(`[bridge] error: ${e.message}`))
process.on('SIGTERM', () => client.end(true, () => process.exit(0)))
process.on('SIGINT', () => client.end(true, () => process.exit(0)))
