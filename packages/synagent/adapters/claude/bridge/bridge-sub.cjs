// synagent BRIDGE v1 de JALAR (suscriptor). Dos clientes MQTT:
// - Durable (clean=false, QoS 1): buzón directo + legacy (offline queued)
// - Transient (clean=true, QoS 1): broadcast de proyecto + global opt-in (online-only)
//
// Cada mensaje recibido (cualquier cliente) → stdout como línea JSON.
//
//   node bridge-sub.cjs --url <url> [--durable-id <id> --durable <t1> [t2 ...]] [--transient-id <id> --transient <t1> [t2 ...]]

const mqtt = require('mqtt')

// Parse arguments más robusto
const args = process.argv.slice(2)
let url = 'mqtt://127.0.0.1:1884'
let durableId, transientId
const durableTopics = []
const transientTopics = []


let i = 0
while (i < args.length) {
  const arg = args[i]

  if (arg === '--url') {
    url = args[++i] || url
    i++
  } else if (arg === '--durable-id') {
    durableId = args[++i]
    i++
  } else if (arg === '--transient-id') {
    transientId = args[++i]
    i++
  } else if (arg === '--durable') {
    i++
    while (i < args.length && !args[i].startsWith('--')) {
      durableTopics.push(args[i])
      i++
    }
  } else if (arg === '--transient') {
    i++
    while (i < args.length && !args[i].startsWith('--')) {
      transientTopics.push(args[i])
      i++
    }
  } else {
    i++
  }
}

// Durable client: clean=false, clientId, QoS 1
let durableClient
if (durableTopics.length > 0 && durableId) {
  durableClient = mqtt.connect(url, {
    clientId: durableId,
    clean: false,
  })

  durableClient.on('connect', () => {
    // MQTT.js usa object format: { 'topic1': {qos:1}, 'topic2': {qos:1} }
    const topicObj = {}
    for (const t of durableTopics) {
      topicObj[t] = { qos: 1 }
    }
    durableClient.subscribe(topicObj, (err) => {
      if (err) {
        console.error(`[bridge] durable subscribe error: ${err.message}`)
        process.exit(1)
      }
      console.error(`[bridge] suscrito durable: ${durableTopics.join(', ')}`)
    })
  })

  durableClient.on('message', (_topic, payload) => {
    process.stdout.write(payload.toString().replace(/\n/g, ' ') + '\n')
  })

  durableClient.on('error', (e) => console.error(`[bridge] durable error: ${e.message}`))
}

// Transient client: clean=true, clientId, QoS 1
let transientClient
if (transientTopics.length > 0 && transientId) {
  transientClient = mqtt.connect(url, {
    clientId: transientId,
    clean: true,
  })

  transientClient.on('connect', () => {
    console.error(`[bridge] transient conectado`)
    // MQTT.js usa object format: { 'topic1': {qos:1}, 'topic2': {qos:1} }
    const topicObj = {}
    for (const t of transientTopics) {
      topicObj[t] = { qos: 1 }
    }
    transientClient.subscribe(topicObj, (err) => {
      if (err) {
        console.error(`[bridge] transient subscribe error: ${err.message}`)
        process.exit(1)
      }
      console.error(`[bridge] suscrito transient: ${transientTopics.join(', ')}`)
    })
  })

  transientClient.on('message', (_topic, payload) => {
    process.stdout.write(payload.toString().replace(/\n/g, ' ') + '\n')
  })

  transientClient.on('error', (e) => {
    console.error(`[bridge] transient error: ${e.message}`)
  })
} else if (transientTopics.length === 0 && transientId) {
  console.error(`[bridge] transient no tiene topics, omitido`)
}

// Shutdown handlers
process.on('SIGTERM', () => {
  if (durableClient) durableClient.end(true, () => {})
  if (transientClient) transientClient.end(true, () => {})
  setTimeout(() => process.exit(0), 100)
})

process.on('SIGINT', () => {
  if (durableClient) durableClient.end(true, () => {})
  if (transientClient) transientClient.end(true, () => {})
  setTimeout(() => process.exit(0), 100)
})
