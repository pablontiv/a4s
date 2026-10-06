// synagent BRIDGE v1 de JALAR (suscriptor). Dos clientes MQTT:
// - Durable (clean=false, QoS 1): buzón directo (offline queued)
// - Transient (clean=true, QoS 1): broadcasts de proyecto + global (online-only)
//
// Cada mensaje recibido (cualquier cliente) → stdout como línea JSON.
// También puede retirar una sesión durable histórica en modo one-shot.
//
//   node bridge-sub.cjs --url <url> [--retire-id <id>] [--durable-id <id> --durable <t1> [t2 ...]] [--transient-id <id> --transient <t1> [t2 ...]]

const mqtt = require('mqtt')

// Parse arguments más robusto
const args = process.argv.slice(2)
let url = 'mqtt://127.0.0.1:1884'
let retireId, durableId, transientId
const durableTopics = []
const transientTopics = []

let i = 0
while (i < args.length) {
  const arg = args[i]

  if (arg === '--url') {
    url = args[++i] || url
    i++
  } else if (arg === '--retire-id') {
    retireId = args[++i]
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

// Migración one-shot: conectar con el clientId histórico y clean=true hace que
// el broker descarte su sesión durable (incluidas suscripciones y cola). Sin
// retries: si el broker está ausente, termina rápido y el arranque continúa.
let retirementClient
if (retireId) {
  retirementClient = mqtt.connect(url, {
    clientId: retireId,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 1000,
  })
  let retirementSettled = false
  retirementClient.once('connect', () => {
    retirementSettled = true
    retirementClient.end(false, () => {
      console.error(`[bridge] sesión durable retirada: ${retireId}`)
    })
  })
  retirementClient.once('error', (error) => {
    if (retirementSettled) return
    retirementSettled = true
    console.error(`[bridge] no se pudo retirar sesión durable ${retireId}: ${error.message}`)
    retirementClient.end(true, () => {
      process.exitCode = 1
    })
  })
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
  if (retirementClient) retirementClient.end(true, () => {})
  if (durableClient) durableClient.end(true, () => {})
  if (transientClient) transientClient.end(true, () => {})
  setTimeout(() => process.exit(0), 100)
})

process.on('SIGINT', () => {
  if (retirementClient) retirementClient.end(true, () => {})
  if (durableClient) durableClient.end(true, () => {})
  if (transientClient) transientClient.end(true, () => {})
  setTimeout(() => process.exit(0), 100)
})
