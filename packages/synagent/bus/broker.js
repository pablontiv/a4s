// synagent BUS — broker MQTT embebido (aedes) + persistencia LevelDB.
// El bus es una app aparte: se arranca por shell y vive independiente de los
// adaptadores. `node bus/broker.js [port] [dbdir]` (o `npm run bus`).
// Imprime "BROKER READY" cuando escucha. Idempotente: si el puerto ya está
// ocupado por otro broker, sale limpio.
const net = require('net')
const { Aedes } = require('aedes')

const PORT = Number(process.argv[2] || 1884)
const DBDIR = process.argv[3] || `${__dirname}/mqtt-db`

async function main() {
  let persistence
  let kind = 'memoria'
  try {
    const { ClassicLevel } = require('classic-level')
    const levelPersistence = require('aedes-persistence-level')
    persistence = levelPersistence(new ClassicLevel(DBDIR))
    kind = `LevelDB (${DBDIR})`
  } catch (e) {
    console.error('[broker] sin persistencia Level, uso memoria:', e.message)
  }
  const broker = await Aedes.createBroker(persistence ? { persistence } : {})
  const server = net.createServer(broker.handle)
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`BROKER ALREADY RUNNING :${PORT} (otro proceso ya escucha; salgo)`)
      process.exit(0)
    }
    console.error('[broker] listen error', e)
    process.exit(1)
  })
  await new Promise((res) => server.listen(PORT, res))
  console.log(`BROKER READY :${PORT} persistencia=${kind}`)
}
main().catch((e) => {
  console.error('[broker] ERROR', e)
  process.exit(1)
})
