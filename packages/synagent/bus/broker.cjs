// synagent BUS — broker MQTT embebido (aedes) + persistencia LevelDB.
// El bus es una app aparte: se arranca por shell y vive independiente de los
// adaptadores. `node bus/broker.cjs [port] [dbdir]` (o `npm run bus`).
// Imprime "BROKER READY :<puerto>" cuando escucha. Idempotente: si el puerto ya
// está ocupado por otro broker, sale limpio.
//
// SEGURIDAD: escucha solo en loopback (127.0.0.1). No hay auth/TLS/ACL, así que
// exponerlo a otras interfaces convertiría a cualquier host de la red en un
// publicador capaz de inyectar prompts vía a4s/inbox/<address>. Para uso en red
// hay que añadir authenticate/authorizePublish y TLS (fuera de este PoC).
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
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res))
  const addr = server.address()
  const actual = addr && typeof addr === 'object' ? addr.port : PORT
  console.log(`BROKER READY :${actual} persistencia=${kind}`)
}
main().catch((e) => {
  console.error('[broker] ERROR', e)
  process.exit(1)
})
